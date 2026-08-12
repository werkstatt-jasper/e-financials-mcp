import { describe, expect, it } from "vitest";
import {
  type AgingInvoice,
  addCalendarDays,
  bucketLabel,
  calendarDaysBetween,
  computeAging,
  effectiveGross,
  invoiceDueDate,
} from "./aging.js";

function inv(overrides: Partial<AgingInvoice> & Pick<AgingInvoice, "id">): AgingInvoice {
  return {
    status: "CONFIRMED",
    payment_status: "NOT_PAID",
    create_date: "2025-01-01",
    term_days: 0,
    clients_id: 1,
    client_name: "Acme",
    number: `INV-${overrides.id}`,
    gross_price: 100,
    ...overrides,
  };
}

describe("effectiveGross", () => {
  it("prefers base_gross_price over gross_price", () => {
    expect(effectiveGross(inv({ id: 1, base_gross_price: 90, gross_price: 100 })).amount).toBe(90);
  });

  it("falls back to gross_price and warns when both missing", () => {
    expect(effectiveGross(inv({ id: 2, gross_price: 50, base_gross_price: null })).amount).toBe(50);
    const missing = effectiveGross(inv({ id: 3, gross_price: null, base_gross_price: null }));
    expect(missing.amount).toBe(0);
    expect(missing.warning).toMatch(/Invoice 3/);
  });
});

describe("date helpers", () => {
  it("adds calendar days across month boundaries", () => {
    expect(addCalendarDays("2025-01-30", 2)).toBe("2025-02-01");
  });

  it("computes calendar days between dates", () => {
    expect(calendarDaysBetween("2025-01-01", "2025-01-31")).toBe(30);
    expect(calendarDaysBetween("2025-01-01", "2025-01-01")).toBe(0);
  });

  it("invoiceDueDate uses create_date + term_days", () => {
    expect(invoiceDueDate(inv({ id: 1, create_date: "2025-01-01", term_days: 14 }))).toBe(
      "2025-01-15",
    );
    expect(invoiceDueDate(inv({ id: 2, create_date: null }))).toBeNull();
    expect(invoiceDueDate(inv({ id: 3, create_date: "", term_days: 5 }))).toBeNull();
    expect(invoiceDueDate(inv({ id: 4, create_date: "2025-01-01", term_days: null }))).toBe(
      "2025-01-01",
    );
  });
});

describe("bucketLabel", () => {
  it("maps boundary days", () => {
    expect(bucketLabel(-5)).toBe("current");
    expect(bucketLabel(0)).toBe("current");
    expect(bucketLabel(1)).toBe("1-30");
    expect(bucketLabel(30)).toBe("1-30");
    expect(bucketLabel(31)).toBe("31-60");
    expect(bucketLabel(60)).toBe("31-60");
    expect(bucketLabel(61)).toBe("61-90");
    expect(bucketLabel(90)).toBe("61-90");
    expect(bucketLabel(91)).toBe("90+");
  });
});

describe("computeAging", () => {
  const asOf = "2025-04-01";

  it("filters non-confirmed and paid invoices", () => {
    const result = computeAging(
      [
        inv({ id: 1, create_date: "2025-03-01", term_days: 0, gross_price: 10 }),
        inv({ id: 2, status: "PROJECT", gross_price: 99 }),
        inv({ id: 3, status: "VOID", gross_price: 99 }),
        inv({ id: 4, payment_status: "PAID", gross_price: 99 }),
      ],
      asOf,
    );
    expect(result.total_invoices).toBe(1);
    expect(result.total_unpaid_face_value).toBe(10);
  });

  it("buckets by days overdue relative to as_of_date", () => {
    const result = computeAging(
      [
        inv({ id: 1, create_date: "2025-04-10", term_days: 0, gross_price: 1 }), // not yet due
        inv({ id: 2, create_date: "2025-04-01", term_days: 0, gross_price: 2 }), // due today
        inv({ id: 3, create_date: "2025-03-02", term_days: 0, gross_price: 3 }), // 30 days
        inv({ id: 4, create_date: "2025-03-01", term_days: 0, gross_price: 4 }), // 31 days
        inv({ id: 5, create_date: "2025-01-31", term_days: 0, gross_price: 5 }), // 60 days
        inv({ id: 6, create_date: "2025-01-30", term_days: 0, gross_price: 6 }), // 61 days
        inv({ id: 7, create_date: "2025-01-01", term_days: 0, gross_price: 7 }), // 90 days
        inv({ id: 8, create_date: "2024-12-31", term_days: 0, gross_price: 8 }), // 91 days
      ],
      asOf,
    );

    const labels = result.aging_buckets.map((b) => b.label);
    expect(labels).toEqual(["current", "1-30", "31-60", "61-90", "90+"]);

    const byLabel = Object.fromEntries(result.aging_buckets.map((b) => [b.label, b]));
    expect(byLabel.current.count).toBe(2);
    expect(byLabel.current.invoices.map((i) => i.days_overdue)).toEqual([0, 0]);
    expect(byLabel["1-30"].count).toBe(1);
    expect(byLabel["1-30"].invoices[0]?.days_overdue).toBe(30);
    expect(byLabel["31-60"].count).toBe(2);
    expect(byLabel["61-90"].count).toBe(2);
    expect(byLabel["90+"].count).toBe(1);
    expect(byLabel["90+"].invoices[0]?.days_overdue).toBe(91);
  });

  it("includes PARTIALLY_PAID at full face value with warning", () => {
    const result = computeAging(
      [
        inv({
          id: 1,
          payment_status: "PARTIALLY_PAID",
          create_date: "2025-03-01",
          gross_price: 200,
        }),
      ],
      asOf,
    );
    expect(result.partially_paid_count).toBe(1);
    expect(result.total_unpaid_face_value).toBe(200);
    expect(result.warnings.some((w) => w.includes("PARTIALLY_PAID"))).toBe(true);
  });

  it("groups top counterparties and tracks unmatched clients_id", () => {
    const result = computeAging(
      [
        inv({
          id: 1,
          clients_id: 10,
          client_name: "Big",
          create_date: "2025-01-01",
          gross_price: 500,
        }),
        inv({
          id: 2,
          clients_id: 10,
          client_name: "Big",
          create_date: "2025-03-15",
          gross_price: 50,
        }),
        inv({
          id: 3,
          clients_id: 20,
          client_name: "Small",
          create_date: "2025-03-01",
          gross_price: 40,
        }),
        inv({
          id: 4,
          clients_id: null,
          client_name: "Orphan",
          create_date: "2024-01-01",
          gross_price: 9,
        }),
      ],
      asOf,
    );

    expect(result.top_counterparties[0]).toMatchObject({
      clients_id: 10,
      total: 550,
      oldest_days: calendarDaysBetween("2025-01-01", asOf),
    });
    expect(result.top_counterparties).toHaveLength(2);
    expect(result.unmatched_invoices).toEqual({
      count: 1,
      total: 9,
      oldest_days: calendarDaysBetween("2024-01-01", asOf),
    });
    expect(result.warnings.some((w) => w.includes("no clients_id"))).toBe(true);
  });

  it("caps invoices per bucket at 10 sorted by amount desc", () => {
    // 2025-03-15 → 2025-04-01 = 17 days → 1-30 bucket
    const invoices = Array.from({ length: 12 }, (_, i) =>
      inv({
        id: i + 1,
        create_date: "2025-03-15",
        term_days: 0,
        gross_price: i + 1,
        clients_id: i + 1,
      }),
    );
    const result = computeAging(invoices, asOf);
    const bucket = result.aging_buckets.find((b) => b.label === "1-30");
    expect(bucket?.count).toBe(12);
    expect(bucket?.invoices).toHaveLength(10);
    expect(bucket?.invoices[0]?.amount).toBe(12);
    expect(bucket?.invoices[9]?.amount).toBe(3);
  });

  it("caps top counterparties at 10", () => {
    const invoices = Array.from({ length: 12 }, (_, i) =>
      inv({
        id: i + 1,
        clients_id: i + 1,
        client_name: `C${i}`,
        create_date: "2025-03-01",
        gross_price: 100 - i,
      }),
    );
    const result = computeAging(invoices, asOf);
    expect(result.top_counterparties).toHaveLength(10);
    expect(result.top_counterparties[0]?.total).toBe(100);
  });

  it("warns on missing create_date and places in current", () => {
    const result = computeAging([inv({ id: 1, create_date: null, gross_price: 15 })], asOf);
    expect(result.aging_buckets).toHaveLength(1);
    expect(result.aging_buckets[0]?.label).toBe("current");
    expect(result.warnings.some((w) => w.includes("create_date"))).toBe(true);
  });

  it("warns when gross amounts are missing and fills client name on later invoice", () => {
    const result = computeAging(
      [
        inv({
          id: 1,
          clients_id: 5,
          client_name: null,
          create_date: "2025-03-15",
          gross_price: null,
          base_gross_price: null,
        }),
        // Same id → duplicate warning string exercises the warningSet dedupe path.
        inv({
          id: 1,
          clients_id: 5,
          client_name: null,
          create_date: "2025-03-15",
          gross_price: null,
          base_gross_price: null,
        }),
        inv({
          id: 2,
          clients_id: 5,
          client_name: "Named",
          create_date: "2025-03-15",
          gross_price: 10,
          number: undefined,
          payment_status: undefined,
        }),
      ],
      asOf,
    );
    expect(result.warnings.filter((w) => w.includes("Invoice 1"))).toHaveLength(1);
    expect(result.top_counterparties[0]?.name).toBe("Named");
    expect(result.top_counterparties[0]?.total).toBe(10);
    expect(result.aging_buckets[0]?.invoices.some((i) => i.number === null)).toBe(true);
    expect(result.aging_buckets[0]?.invoices.some((i) => i.payment_status === null)).toBe(true);
  });

  it("defaults as_of_date to today UTC when omitted", () => {
    const today = new Date().toISOString().slice(0, 10);
    const result = computeAging([inv({ id: 1, create_date: today, term_days: 0, gross_price: 1 })]);
    expect(result.as_of_date).toBe(today);
    expect(result.aging_buckets[0]?.label).toBe("current");
  });
});
