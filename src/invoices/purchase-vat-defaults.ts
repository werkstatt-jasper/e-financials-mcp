import type { EFinancialsClient } from "../client.js";
import { logger } from "../logger.js";
import { formatVatRateDropdown, parseVatRateDropdown } from "../money.js";
import type { PurchaseArticle, VatInfo } from "../types/accounts.js";

const VAT_REGISTERED_FALLBACK = {
  vat_accounts_id: 1510,
  cl_vat_articles_id: 1,
} as const;

const NON_VAT_REGISTERED_FALLBACK = {
  cl_vat_articles_id: 11,
} as const;

const warnedFallbackKeys = new Set<string>();
let warningScope = "";

export type PurchaseArticleWithVat = PurchaseArticle;

export interface PurchaseLineVatFields {
  cl_purchase_articles_id?: number | null;
  vat_rate_dropdown?: string | null;
  vat_accounts_id?: number | null;
  cl_vat_articles_id?: number | null;
  purchase_accounts_id?: number | null;
  cl_fringe_benefits_id?: number | null;
  amount?: number | null;
}

export interface AppliedPurchaseVatDefaults extends PurchaseLineVatFields {
  vat_rate_dropdown: string;
  vat_accounts_id?: number;
  cl_vat_articles_id?: number;
  cl_fringe_benefits_id: number;
  amount: number;
}

/** Clear deduped fallback warnings; optionally switch company/connection scope. */
export function clearVatWarnings(scope?: string): void {
  if (scope !== undefined) {
    warningScope = scope;
  }
  warnedFallbackKeys.clear();
}

export function clearAllVatWarnings(): void {
  warnedFallbackKeys.clear();
}

function warnFallbackOnce(key: string, message: string): void {
  const scopedKey = `${warningScope}:${key}`;
  if (warnedFallbackKeys.has(scopedKey)) {
    return;
  }
  warnedFallbackKeys.add(scopedKey);
  logger.warn({ component: "purchase-vat-defaults" }, message);
}

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeVatRateString(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatVatRateDropdown(value);
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (trimmed === "-") {
    return "-";
  }
  const parsed = parseVatRateDropdown(trimmed);
  if (parsed === 0 && trimmed !== "0" && trimmed !== "0%" && trimmed !== "0,0") {
    // Non-numeric junk: keep raw trimmed for matching attempts
    return trimmed;
  }
  return formatVatRateDropdown(parsed);
}

function extractVatDefaults(article?: PurchaseArticleWithVat): {
  vat_accounts_id?: number;
  cl_vat_articles_id?: number;
} {
  return {
    vat_accounts_id: toNumber(article?.vat_accounts_id),
    cl_vat_articles_id: toNumber(article?.cl_vat_articles_id),
  };
}

function matchesRate(article: PurchaseArticleWithVat, vatRateDropdown: string): boolean {
  const articleRate = normalizeVatRateString(article.vat_rate_dropdown ?? article.vat_rate);
  return articleRate === vatRateDropdown;
}

function getArticleSearchText(article: PurchaseArticleWithVat): string {
  return `${article.name_est} ${article.name_eng}`.toLowerCase();
}

function findArticleDefaults(
  articles: PurchaseArticleWithVat[],
  item: PurchaseLineVatFields,
  vatRateDropdown: string | undefined,
  isVatRegistered: boolean,
): { vat_accounts_id?: number; cl_vat_articles_id?: number } {
  const selectedArticle =
    item.cl_purchase_articles_id != null
      ? articles.find((article) => article.id === item.cl_purchase_articles_id)
      : undefined;
  const selectedDefaults = extractVatDefaults(selectedArticle);
  if (
    selectedDefaults.vat_accounts_id !== undefined ||
    selectedDefaults.cl_vat_articles_id !== undefined
  ) {
    return selectedDefaults;
  }

  const withVatDefaults = articles.filter((article) => {
    const defaults = extractVatDefaults(article);
    return defaults.vat_accounts_id !== undefined || defaults.cl_vat_articles_id !== undefined;
  });

  const rateMatch = vatRateDropdown
    ? withVatDefaults.find((article) => matchesRate(article, vatRateDropdown))
    : undefined;
  if (rateMatch) {
    return extractVatDefaults(rateMatch);
  }

  const keywordMatch = withVatDefaults.find((article) => {
    const text = getArticleSearchText(article);
    if (isVatRegistered) {
      const isVatName =
        text.includes("vat") || text.includes("käibemaks") || text.includes("kaibemaks");
      return isVatName && !text.includes("non-deduct") && !text.includes("mahaarv");
    }
    return text.includes("non-deduct") || text.includes("mahaarv") || text.includes("mitte");
  });
  if (keywordMatch) {
    return extractVatDefaults(keywordMatch);
  }

  return {};
}

/** True when company has a non-empty VAT number on `/v1/vat_info`. */
export async function isCompanyVatRegistered(client: EFinancialsClient): Promise<boolean> {
  const info = (await client.get<VatInfo>("/v1/vat_info")) as unknown as VatInfo;
  return Boolean(info.vat_number?.trim());
}

/**
 * Fill missing VAT line fields for a purchase invoice item.
 * Does not invent rates: no-VAT uses `"-"`.
 */
export function applyPurchaseVatDefaults(
  purchaseArticles: PurchaseArticleWithVat[],
  item: PurchaseLineVatFields,
  isVatRegistered: boolean,
): AppliedPurchaseVatDefaults {
  const rateNormalized = normalizeVatRateString(item.vat_rate_dropdown);
  const merged: AppliedPurchaseVatDefaults = {
    cl_purchase_articles_id: item.cl_purchase_articles_id ?? undefined,
    purchase_accounts_id: item.purchase_accounts_id ?? undefined,
    vat_accounts_id: toNumber(item.vat_accounts_id),
    cl_vat_articles_id: toNumber(item.cl_vat_articles_id),
    cl_fringe_benefits_id: toNumber(item.cl_fringe_benefits_id) ?? 1,
    amount: toNumber(item.amount) ?? 1,
    vat_rate_dropdown: rateNormalized ?? "-",
  };

  const defaults = findArticleDefaults(purchaseArticles, merged, rateNormalized, isVatRegistered);

  if (isVatRegistered) {
    if (rateNormalized) {
      merged.vat_rate_dropdown = rateNormalized;
    }
    merged.vat_accounts_id =
      toNumber(merged.vat_accounts_id) ??
      defaults.vat_accounts_id ??
      VAT_REGISTERED_FALLBACK.vat_accounts_id;
    merged.cl_vat_articles_id =
      toNumber(merged.cl_vat_articles_id) ??
      defaults.cl_vat_articles_id ??
      VAT_REGISTERED_FALLBACK.cl_vat_articles_id;

    if (defaults.vat_accounts_id === undefined || defaults.cl_vat_articles_id === undefined) {
      warnFallbackOnce(
        "vat-registered",
        "Could not resolve purchase VAT defaults from purchase_articles; falling back to vat_accounts_id=1510 and cl_vat_articles_id=1.",
      );
    }
    return merged;
  }

  merged.vat_rate_dropdown = rateNormalized ?? "-";

  if (merged.vat_rate_dropdown !== "-") {
    merged.vat_accounts_id =
      toNumber(merged.vat_accounts_id) ??
      defaults.vat_accounts_id ??
      toNumber(merged.purchase_accounts_id);
    merged.cl_vat_articles_id =
      toNumber(merged.cl_vat_articles_id) ??
      defaults.cl_vat_articles_id ??
      NON_VAT_REGISTERED_FALLBACK.cl_vat_articles_id;

    if (defaults.cl_vat_articles_id === undefined) {
      warnFallbackOnce(
        "non-vat-registered",
        "Could not resolve non-deductible VAT defaults from purchase_articles; falling back to cl_vat_articles_id=11.",
      );
    }
  }

  return merged;
}
