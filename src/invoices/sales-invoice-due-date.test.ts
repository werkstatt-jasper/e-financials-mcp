import { describe, expect, it } from "vitest";
import {
  daysBetweenYmd,
  salesInvoiceDueDate,
  withSalesInvoiceDueDate,
} from "./sales-invoice-due-date.js";

describe("daysBetweenYmd", () => {
  it("counts calendar days across month and year ends", () => {
    expect(daysBetweenYmd("2025-01-01", "2025-01-15")).toBe(14);
    expect(daysBetweenYmd("2025-01-31", "2025-03-02")).toBe(30);
    expect(daysBetweenYmd("2024-12-20", "2025-01-03")).toBe(14);
    expect(daysBetweenYmd("2025-03-01", "2025-03-01")).toBe(0);
  });

  it("returns a negative number when the due date is earlier", () => {
    expect(daysBetweenYmd("2025-03-10", "2025-03-01")).toBe(-9);
  });

  it("accepts a datetime-shaped invoice date", () => {
    expect(daysBetweenYmd("2025-01-01T00:00:00", "2025-01-08")).toBe(7);
  });

  it("returns null for unparseable dates", () => {
    expect(daysBetweenYmd("not-a-date", "2025-01-08")).toBeNull();
    expect(daysBetweenYmd("2025-01-01", "")).toBeNull();
  });
});

describe("salesInvoiceDueDate", () => {
  it("adds term_days to create_date", () => {
    expect(salesInvoiceDueDate({ create_date: "2025-01-01", term_days: 14 })).toBe("2025-01-15");
    expect(salesInvoiceDueDate({ create_date: "2024-02-20", term_days: 10 })).toBe("2024-03-01");
    expect(salesInvoiceDueDate({ create_date: "2025-06-01", term_days: 0 })).toBe("2025-06-01");
  });

  it("returns undefined when create_date or term_days is missing or invalid", () => {
    expect(salesInvoiceDueDate({ term_days: 14 })).toBeUndefined();
    expect(salesInvoiceDueDate({ create_date: "", term_days: 14 })).toBeUndefined();
    expect(salesInvoiceDueDate({ create_date: "2025-01-01" })).toBeUndefined();
    expect(salesInvoiceDueDate({ create_date: "2025-01-01", term_days: null })).toBeUndefined();
    expect(
      salesInvoiceDueDate({ create_date: "2025-01-01", term_days: Number.NaN }),
    ).toBeUndefined();
    expect(salesInvoiceDueDate({ create_date: "garbage", term_days: 3 })).toBeUndefined();
  });
});

describe("withSalesInvoiceDueDate", () => {
  it("adds a derived due_date and keeps all other fields", () => {
    const invoice = { id: 1, create_date: "2025-01-01", term_days: 7, status: "PROJECT" };
    expect(withSalesInvoiceDueDate(invoice)).toEqual({ ...invoice, due_date: "2025-01-08" });
    expect(invoice).not.toHaveProperty("due_date");
  });

  it("keeps an existing due_date", () => {
    const invoice = { id: 1, create_date: "2025-01-01", term_days: 7, due_date: "2025-02-01" };
    expect(withSalesInvoiceDueDate(invoice)).toBe(invoice);
  });

  it("returns the input unchanged when no due date can be derived", () => {
    const invoice = { id: 1, create_date: "2025-01-01" };
    expect(withSalesInvoiceDueDate(invoice)).toBe(invoice);
    expect(withSalesInvoiceDueDate(null)).toBeNull();
    expect(withSalesInvoiceDueDate("text")).toBe("text");
    const list = [1, 2];
    expect(withSalesInvoiceDueDate(list)).toBe(list);
  });
});
