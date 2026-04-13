import { type ZodType, z } from "zod";

/** Calendar date `YYYY-MM-DD` (invalid dates like 2024-13-40 rejected). */
export const ymdDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
  .refine((s) => {
    const [y, m, d] = s.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }, "Invalid calendar date");

/** Optional `YYYY-MM-DD`; omits undefined/null from output shape when using .nullish(). */
export const optionalYmd = ymdDateString.nullish().transform((v) => v ?? undefined);

/**
 * Positive integer IDs and similar. Uses coercion so string `"42"` from JSON-ish clients still validates.
 */
export const positiveInt = z.coerce.number().int().positive();

export const optionalPositiveInt = positiveInt.nullish().transform((v) => v ?? undefined);

/** Page number (1-based). */
export const optionalPage = z.coerce
  .number()
  .int()
  .min(1)
  .nullish()
  .transform((v) => v ?? undefined);

/** Optional string; null coerced to undefined. */
export const optionalString = z
  .string()
  .nullish()
  .transform((v) => v ?? undefined);

/** Optional number (coerced); null coerced to undefined. */
export const optionalNumber = z.coerce
  .number()
  .nullish()
  .transform((v) => v ?? undefined);

/** Optional boolean; null coerced to undefined. */
export const optionalBoolean = z
  .boolean()
  .nullish()
  .transform((v) => v ?? undefined);

export const transactionStatusEnum = z.enum(["PROJECT", "CONFIRMED", "VOID"]);

export const creditDebitEnum = z.enum(["C", "D"]);

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

export function parseToolArgs<T extends ZodType>(schema: T, raw: unknown): z.infer<T> {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw new Error(formatZodError(result.error));
  }
  return result.data;
}
