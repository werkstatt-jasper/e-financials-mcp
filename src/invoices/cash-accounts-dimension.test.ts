import { describe, expect, it } from "vitest";
import {
  assertCashAccountsDimensionWritable,
  CASH_ACCOUNTS_DIMENSION_PRESERVE_ERROR,
  CASH_ACCOUNTS_DIMENSION_WRITE_ERROR,
} from "./cash-accounts-dimension.js";

describe("assertCashAccountsDimensionWritable", () => {
  it("allows writes when no cash dimension is requested or stored", () => {
    expect(() => assertCashAccountsDimensionWritable({})).not.toThrow();
    expect(() =>
      assertCashAccountsDimensionWritable({ requested: undefined, current: null }),
    ).not.toThrow();
  });

  it("rejects a requested cash dimension id", () => {
    expect(() => assertCashAccountsDimensionWritable({ requested: 41442 })).toThrow(
      CASH_ACCOUNTS_DIMENSION_WRITE_ERROR,
    );
  });

  it("rejects a stored cash dimension so PATCH cannot clear it", () => {
    expect(() => assertCashAccountsDimensionWritable({ current: 41442 })).toThrow(
      CASH_ACCOUNTS_DIMENSION_PRESERVE_ERROR,
    );
  });
});
