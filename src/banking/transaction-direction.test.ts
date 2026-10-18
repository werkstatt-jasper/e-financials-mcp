import { describe, expect, it } from "vitest";
import {
  directionFromToolType,
  reportedMessages,
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

  it("formats RIK messages for error text", () => {
    expect(reportedMessages([])).toBe("");
    expect(reportedMessages(["Saved."])).toBe(" RIK reported: Saved.");
    expect(reportedMessages(["One", "Two."])).toBe(" RIK reported: One; Two.");
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
