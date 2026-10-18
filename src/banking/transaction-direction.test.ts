import { describe, expect, it } from "vitest";
import {
  directionFromToolType,
  messageMatchesDirection,
  rikMessages,
  rikTypeForToolType,
  transactionIdFromResponse,
} from "./transaction-direction.js";

describe("transaction direction", () => {
  it("translates the tool contract to RIK's cash debit/credit letter", () => {
    expect(rikTypeForToolType("D")).toBe("C");
    expect(rikTypeForToolType("C")).toBe("D");
    expect(directionFromToolType("D")).toBe("outgoing");
    expect(directionFromToolType("C")).toBe("incoming");
  });

  it("matches English and Estonian save messages", () => {
    expect(messageMatchesDirection(["Outgoing payment has been saved."], "outgoing")).toBe(true);
    expect(messageMatchesDirection(["Incoming payment has been saved."], "incoming")).toBe(true);
    expect(messageMatchesDirection(["Väljaminev makse on salvestatud."], "outgoing")).toBe(true);
    expect(messageMatchesDirection(["Väljuv makse on salvestatud."], "outgoing")).toBe(true);
    expect(messageMatchesDirection(["Sissetulev makse on salvestatud."], "incoming")).toBe(true);
    expect(messageMatchesDirection(["Laekuv makse on salvestatud."], "incoming")).toBe(true);
    expect(messageMatchesDirection(["Outgoing payment has been saved."], "incoming")).toBe(false);
    expect(messageMatchesDirection(["Incoming payment has been saved."], "outgoing")).toBe(false);
    expect(messageMatchesDirection(["Incoming and outgoing"], "outgoing")).toBe(false);
    expect(messageMatchesDirection(["Incoming and outgoing"], "incoming")).toBe(false);
    expect(messageMatchesDirection(["saved"], "outgoing")).toBe(false);
    expect(messageMatchesDirection([], "incoming")).toBe(false);
  });

  it("reads messages and ids from RIK bodies", () => {
    expect(rikMessages(null)).toEqual([]);
    expect(rikMessages("nope")).toEqual([]);
    expect(rikMessages({ messages: ["Outgoing payment has been saved.", 1] })).toEqual([
      "Outgoing payment has been saved.",
    ]);
    expect(rikMessages({ response_message: "Incoming payment has been saved." })).toEqual([
      "Incoming payment has been saved.",
    ]);
    expect(rikMessages({ code: 0 })).toEqual([]);
    expect(transactionIdFromResponse(null)).toBeUndefined();
    expect(transactionIdFromResponse("x")).toBeUndefined();
    expect(transactionIdFromResponse({ id: 4, created_object_id: 9 })).toBe(4);
    expect(transactionIdFromResponse({ created_object_id: 9 })).toBe(9);
    expect(transactionIdFromResponse({ code: 0 })).toBeUndefined();
  });
});
