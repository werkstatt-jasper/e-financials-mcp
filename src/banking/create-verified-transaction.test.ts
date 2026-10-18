import { describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createMockClient } from "../tools/test-helpers.js";
import { createVerifiedTransaction } from "./create-verified-transaction.js";

const outgoingBody = {
  accounts_dimensions_id: 1,
  type: "D" as const,
  amount: 10,
  cl_currencies_id: "EUR",
  date: "2026-10-01",
};

/**
 * Each check answers one stored-direction lookup, which lists the day twice.
 * A number array is the ids stored as incoming; the created id is in the unfiltered list.
 * "missing" means the created id is in neither list. An Error fails the lookup.
 */
function incomingChecks(
  client: EFinancialsClient,
  createdId: number,
  ...checks: Array<number[] | "missing" | Error>
): void {
  const queue = [...checks];
  let active: (typeof queue)[number] = "missing";
  let usesLeft = 0;
  vi.mocked(client.getAllPages).mockImplementation(async (_path, params) => {
    if (usesLeft === 0) {
      active = queue.shift() ?? "missing";
      usesLeft = 2;
    }
    usesLeft -= 1;
    if (active instanceof Error) {
      throw active;
    }
    if (active === "missing") {
      return [] as never;
    }
    if (params?.type === undefined) {
      return [{ id: createdId, type: "C" }] as never;
    }
    return active.map((id) => ({ id, type: "C" })) as never;
  });
}

describe("createVerifiedTransaction", () => {
  it("keeps an outgoing draft that RIK stored as outgoing", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 5,
      messages: ["Outgoing payment has been saved."],
    } as never);
    incomingChecks(client, 5, [4]);
    vi.mocked(client.get).mockResolvedValue({
      id: 5,
      type: "C",
      status: "PROJECT",
      amount: 10,
    } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ type: "C" }),
    );
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
    });
    expect(client.getAllPages).toHaveBeenCalledWith("/v1/transactions", {
      start_date: "2026-10-01",
      end_date: "2026-10-01",
      type: "D",
    });
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(created).toEqual({
      id: 5,
      type: "D",
      status: "PROJECT",
      amount: 10,
      direction_confirmed: true,
      rik_messages: ["Outgoing payment has been saved."],
    });
  });

  it("keeps an incoming draft that RIK stored as incoming", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      created_object_id: 6,
      response_message: "Incoming payment has been saved.",
    } as never);
    incomingChecks(client, 6, [6]);
    vi.mocked(client.get).mockResolvedValue({ id: 6, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, { ...outgoingBody, type: "C" });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ type: "D" }),
    );
    expect(created).toMatchObject({ id: 6, type: "C", direction_confirmed: true });
  });

  it("patches once when RIK stored the other direction", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 7,
      messages: ["Incoming payment has been saved."],
    } as never);
    incomingChecks(client, 7, [7], []);
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 7, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.patch).toHaveBeenCalledWith("/v1/transactions/7", { type: "C" });
    expect(client.delete).not.toHaveBeenCalled();
    expect(created.rik_messages).toEqual(["Outgoing payment has been saved."]);
    expect(created.direction_confirmed).toBe(true);
  });

  it("keeps the draft unconfirmed when the direction check fails", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 8, messages: ["Saved."] } as never);
    incomingChecks(client, 8, new Error("HTTP 503"));
    vi.mocked(client.get).mockResolvedValue({ id: 8, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(created).toMatchObject({ id: 8, type: "D", direction_confirmed: false });
  });

  it("keeps the draft unconfirmed when the check after the PATCH fails", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 8 } as never);
    incomingChecks(client, 8, [8], new Error("HTTP 503"));
    vi.mocked(client.patch).mockResolvedValue({ messages: [] } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 8, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.delete).not.toHaveBeenCalled();
    expect(created.direction_confirmed).toBe(false);
  });

  it("deletes the draft when RIK still stores the other direction after the PATCH", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 8,
      messages: ["Incoming payment has been saved."],
    } as never);
    incomingChecks(client, 8, [8], [8]);
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.delete).mockResolvedValue({} as never);

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      "Requested type D (outgoing), sent API type C, but RIK stored the transaction as incoming. RIK reported: Incoming payment has been saved. The draft was deleted.",
    );
    expect(client.delete).toHaveBeenCalledWith("/v1/transactions/8");
  });

  it("includes a delete failure after the PATCH did not help", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 8 } as never);
    incomingChecks(client, 8, [8], [8]);
    vi.mocked(client.patch).mockResolvedValue({} as never);
    vi.mocked(client.delete).mockRejectedValue(new Error("gone"));

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      "Requested type D (outgoing), sent API type C, but RIK stored the transaction as incoming. Failed to delete draft transaction 8: gone",
    );
  });

  it("deletes the draft when the correcting PATCH throws", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 8 } as never);
    incomingChecks(client, 8, [8]);
    vi.mocked(client.patch).mockRejectedValue("patch-string");
    vi.mocked(client.delete).mockResolvedValue({} as never);

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      /PATCH failed: patch-string The draft was deleted\./,
    );
  });

  it("reports both failures when the PATCH and the delete throw", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 8 } as never);
    incomingChecks(client, 8, [8]);
    vi.mocked(client.patch).mockRejectedValue(new Error("patch no"));
    vi.mocked(client.delete).mockRejectedValue(new Error("delete no"));

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      /PATCH failed: patch no[\s\S]*delete no/,
    );
  });

  it("throws when RIK returns no id", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ code: 0 } as never);
    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(/transaction id/);
    vi.mocked(client.post).mockResolvedValue(null as never);
    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(/transaction id/);
    expect(client.getAllPages).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("returns the created id when the read-back is empty", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 5 } as never);
    incomingChecks(client, 5, [], []);
    vi.mocked(client.get).mockResolvedValue(null as never);
    const empty = await createVerifiedTransaction(client, outgoingBody);
    expect(empty).toMatchObject({
      ...outgoingBody,
      id: 5,
      type: "D",
      direction_confirmed: true,
      read_back_error:
        "Transaction 5 was created but could not be read back: the response was empty",
    });
    vi.mocked(client.get).mockResolvedValue([] as never);
    const list = await createVerifiedTransaction(client, outgoingBody);
    expect(list.read_back_error).toMatch(/response was empty/);
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("keeps an unlisted incoming draft", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 6, messages: ["Saved."] } as never);
    incomingChecks(client, 6, "missing");
    vi.mocked(client.get).mockResolvedValue({ id: 6, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, { ...outgoingBody, type: "C" });

    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(created).toMatchObject({ id: 6, type: "C", direction_confirmed: false });
  });

  it("keeps an unlisted outgoing draft unconfirmed", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 5, messages: ["Saved."] } as never);
    incomingChecks(client, 5, "missing");
    vi.mocked(client.get).mockResolvedValue({ id: 5, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(created).toMatchObject({ id: 5, type: "D", direction_confirmed: false });
  });

  it("returns the created id when the read-back throws", async () => {
    const client = createMockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 5 } as never);
    incomingChecks(client, 5, []);
    vi.mocked(client.get).mockRejectedValue(new Error("HTTP 503"));
    const created = await createVerifiedTransaction(client, outgoingBody);
    expect(created).toMatchObject({ id: 5, type: "D", amount: 10, direction_confirmed: true });
    expect(created.read_back_error).toBe(
      "Transaction 5 was created but could not be read back: HTTP 503",
    );
    expect(client.delete).not.toHaveBeenCalled();
  });
});
