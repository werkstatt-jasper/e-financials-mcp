import { describe, expect, it, vi } from "vitest";
import type { EFinancialsClient } from "../client.js";
import { createVerifiedTransaction } from "./create-verified-transaction.js";

function mockClient(): EFinancialsClient {
  return {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
    getAllPages: vi.fn(),
    request: vi.fn(),
  } as unknown as EFinancialsClient;
}

const outgoingBody = {
  accounts_dimensions_id: 1,
  type: "D" as const,
  amount: 10,
  cl_currencies_id: "EUR",
  date: "2026-10-01",
};

describe("createVerifiedTransaction", () => {
  it("keeps an outgoing draft when the first save message matches", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 5,
      messages: ["Outgoing payment has been saved."],
    } as never);
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
    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(created).toMatchObject({
      id: 5,
      type: "D",
      direction_confirmed: true,
      rik_messages: ["Outgoing payment has been saved."],
    });
  });

  it("keeps an incoming draft from a response_message", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      created_object_id: 6,
      response_message: "Incoming payment has been saved.",
    } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 6, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, { ...outgoingBody, type: "C" });

    expect(client.post).toHaveBeenCalledWith(
      "/v1/transactions",
      expect.objectContaining({ type: "D" }),
    );
    expect(created.type).toBe("C");
    expect(created.id).toBe(6);
  });

  it("accepts a correcting PATCH when the POST message is wrong", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 7,
      messages: ["Incoming payment has been saved."],
    } as never);
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

  it("keeps an unrecognized save message without patching", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ id: 8, messages: ["nope"] } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 8, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.patch).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
    expect(created.direction_confirmed).toBe(false);
    expect(created.type).toBe("D");
  });

  it("keeps the draft when a correcting PATCH no longer names a direction", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 8,
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({ messages: [] } as never);
    vi.mocked(client.get).mockResolvedValue({ id: 8, type: "C", status: "PROJECT" } as never);

    const created = await createVerifiedTransaction(client, outgoingBody);

    expect(client.delete).not.toHaveBeenCalled();
    expect(created.direction_confirmed).toBe(false);
  });

  it("deletes the draft when POST and PATCH both name the other direction", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 8,
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.delete).mockResolvedValue({} as never);

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      /Requested type D \(outgoing\).*The draft was deleted/,
    );
    expect(client.delete).toHaveBeenCalledWith("/v1/transactions/8");
  });

  it("includes a delete failure after a wrong PATCH message", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 8,
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockResolvedValue({
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.delete).mockRejectedValue(new Error("gone"));

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      /Failed to delete draft transaction 8: gone/,
    );
  });

  it("deletes the draft when the correcting PATCH throws", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 8,
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockRejectedValue("patch-string");
    vi.mocked(client.delete).mockResolvedValue({} as never);

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      /PATCH failed: patch-string.*The draft was deleted/,
    );
  });

  it("reports both failures when PATCH and delete throw", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 8,
      messages: ["Incoming payment has been saved."],
    } as never);
    vi.mocked(client.patch).mockRejectedValue(new Error("patch no"));
    vi.mocked(client.delete).mockRejectedValue(new Error("delete no"));

    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(
      /PATCH failed: patch no[\s\S]*delete no/,
    );
  });

  it("throws when RIK returns no id", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({ code: 0 } as never);
    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(/transaction id/);
    vi.mocked(client.post).mockResolvedValue(null as never);
    await expect(createVerifiedTransaction(client, outgoingBody)).rejects.toThrow(/transaction id/);
    expect(client.delete).not.toHaveBeenCalled();
  });

  it("returns the created id when the read-back is empty", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 5,
      messages: ["Outgoing payment has been saved."],
    } as never);
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

  it("returns the created id when the read-back throws", async () => {
    const client = mockClient();
    vi.mocked(client.post).mockResolvedValue({
      id: 5,
      messages: ["Outgoing payment has been saved."],
    } as never);
    vi.mocked(client.get).mockRejectedValue(new Error("HTTP 503"));
    const created = await createVerifiedTransaction(client, outgoingBody);
    expect(created).toMatchObject({ id: 5, type: "D", amount: 10, direction_confirmed: true });
    expect(created.read_back_error).toBe(
      "Transaction 5 was created but could not be read back: HTTP 503",
    );
    expect(client.delete).not.toHaveBeenCalled();
  });
});
