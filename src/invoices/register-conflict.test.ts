import { describe, expect, it } from "vitest";
import { createHttpJsonApiError, EFinancialsApiError } from "../api-error.js";
import { registerConflictHint, withRegisterConflictHint } from "./register-conflict.js";

/** 409 body shaped like the OpenAPI `ApiResponse` (fake messages). */
function conflict409(path: string) {
  return createHttpJsonApiError({
    method: "PATCH",
    url: `https://rmp-api.rik.ee/v1${path}`,
    httpStatus: 409,
    errorData: {
      code: 409,
      messages: [
        "Line classifiers are derived from settings.",
        "Row 2: classifier X is missing",
        "Row 3: classifier Y is not allowed",
      ],
    },
  });
}

describe("registerConflictHint", () => {
  it("names the sale or purchase tools", () => {
    expect(registerConflictHint("sale", 7)).toContain("Sales invoice 7");
    expect(registerConflictHint("sale", 7)).toContain("update_sales_invoice");
    expect(registerConflictHint("sale", 7)).toContain("list_sale_articles");
    expect(registerConflictHint("purchase", 8)).toContain("Purchase invoice 8");
    expect(registerConflictHint("purchase", 8)).toContain("update_purchase_invoice");
    expect(registerConflictHint("purchase", 8)).toContain("list_purchase_articles");
  });
});

describe("withRegisterConflictHint", () => {
  it("returns the register response", async () => {
    await expect(withRegisterConflictHint("sale", 1, async () => ({ code: 0 }))).resolves.toEqual({
      code: 0,
    });
  });

  it("keeps every RIK message and adds the hint on 409", async () => {
    const original = conflict409("/sale_invoices/5/register");
    const error = await withRegisterConflictHint("sale", 5, async () => {
      throw original;
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EFinancialsApiError);
    const e = error as EFinancialsApiError;
    expect(e.message).toContain(
      "Line classifiers are derived from settings.; Row 2: classifier X is missing; Row 3: classifier Y is not allowed",
    );
    expect(e.message).toContain("line classifier");
    expect(e.message).toContain("update_sales_invoice");
    expect(e.httpStatus).toBe(409);
    expect(e.apiCode).toBe(409);
    expect(e.kind).toBe("http");
    expect(e.method).toBe("PATCH");
    expect(e.bodySnippet).toBe(original.bodySnippet);
    expect(e.cause).toBe(original);
  });

  it("rethrows other errors unchanged", async () => {
    const other = createHttpJsonApiError({
      method: "PATCH",
      url: "https://x/v1/sale_invoices/5/register",
      httpStatus: 400,
      errorData: { messages: ["bad"] },
    });
    await expect(
      withRegisterConflictHint("sale", 5, async () => {
        throw other;
      }),
    ).rejects.toBe(other);
    const plain = new Error("boom");
    await expect(
      withRegisterConflictHint("purchase", 5, async () => {
        throw plain;
      }),
    ).rejects.toBe(plain);
  });
});
