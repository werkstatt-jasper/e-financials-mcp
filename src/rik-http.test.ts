import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";

const httpsRequestMock = vi.hoisted(() => vi.fn());

vi.mock("node:https", () => ({
  request: httpsRequestMock,
}));

import { rikFetch } from "./rik-http.js";

class FakeRes extends EventEmitter {
  statusCode: number | undefined;
  statusMessage: string | undefined;
  headers: Record<string, string | string[] | undefined> = {};
}

class FakeReq extends EventEmitter {
  end = vi.fn();
}

interface CapturedCall {
  url: string;
  options: {
    method?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  };
}

function setupRequest(): { req: FakeReq; res: FakeRes; captured: CapturedCall } {
  const req = new FakeReq();
  const res = new FakeRes();
  const captured: CapturedCall = { url: "", options: {} };
  httpsRequestMock.mockImplementation(
    (url: string, options: CapturedCall["options"], callback: (res: FakeRes) => void) => {
      captured.url = url;
      captured.options = options;
      queueMicrotask(() => callback(res));
      return req;
    },
  );
  return { req, res, captured };
}

function respond(
  res: FakeRes,
  fields: {
    statusCode?: number;
    statusMessage?: string;
    headers?: Record<string, string | string[] | undefined>;
    chunks?: string[];
  },
): void {
  queueMicrotask(() => {
    queueMicrotask(() => {
      res.statusCode = fields.statusCode;
      res.statusMessage = fields.statusMessage;
      res.headers = fields.headers ?? {};
      for (const chunk of fields.chunks ?? []) {
        res.emit("data", Buffer.from(chunk));
      }
      res.emit("end");
    });
  });
}

describe("rikFetch", () => {
  beforeEach(() => {
    httpsRequestMock.mockReset();
  });

  it("performs a GET with exactly the given headers and builds a Response", async () => {
    const { req, res, captured } = setupRequest();
    respond(res, {
      statusCode: 200,
      statusMessage: "OK",
      headers: {
        "content-type": "application/json",
        "set-cookie": ["a=1", "b=2"],
        "x-undefined": undefined,
      },
      chunks: ['{"items"', ":[1,2]}"],
    });

    const response = await rikFetch("https://rmp-api.rik.ee/v1/transactions", {
      headers: { "X-AUTH-KEY": "pub:sig" },
      signal: AbortSignal.timeout(1000),
    });

    expect(captured.url).toBe("https://rmp-api.rik.ee/v1/transactions");
    expect(captured.options.method).toBe("GET");
    expect(captured.options.headers).toEqual({ "X-AUTH-KEY": "pub:sig" });
    expect(captured.options.signal).toBeInstanceOf(AbortSignal);
    expect(req.end).toHaveBeenCalledWith(undefined);

    expect(response.status).toBe(200);
    expect(response.statusText).toBe("OK");
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("set-cookie")).toBe("a=1, b=2");
    expect(response.headers.has("x-undefined")).toBe(false);
    await expect(response.json()).resolves.toEqual({ items: [1, 2] });
  });

  it("defaults to GET with empty headers when init is omitted", async () => {
    const { res, captured } = setupRequest();
    respond(res, { statusCode: 200, statusMessage: "OK", chunks: ["{}"] });

    const response = await rikFetch("https://rmp-api.rik.ee/v1/foo");

    expect(captured.options.method).toBe("GET");
    expect(captured.options.headers).toEqual({});
    expect(response.status).toBe(200);
  });

  it("sets Content-Length and writes the body for POST", async () => {
    const { req, res, captured } = setupRequest();
    respond(res, { statusCode: 200, statusMessage: "OK", chunks: ['{"id":1}'] });

    const body = JSON.stringify({ name: "õli" });
    await rikFetch("https://rmp-api.rik.ee/v1/clients", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    expect(captured.options.method).toBe("POST");
    expect(captured.options.headers).toEqual({
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
    });
    expect(req.end).toHaveBeenCalledWith(body);
  });

  it("returns a null-body Response for 204", async () => {
    const { res } = setupRequest();
    respond(res, { statusCode: 204, statusMessage: "No Content" });

    const response = await rikFetch("https://rmp-api.rik.ee/v1/x", { method: "DELETE" });

    expect(response.status).toBe(204);
    await expect(response.text()).resolves.toBe("");
  });

  it("returns a null-body Response when the body is empty", async () => {
    const { res } = setupRequest();
    respond(res, { statusCode: 200, statusMessage: "OK" });

    const response = await rikFetch("https://rmp-api.rik.ee/v1/x");

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("");
  });

  it("falls back to status 500 and empty statusText when the response has none", async () => {
    const { res } = setupRequest();
    respond(res, {});

    const response = await rikFetch("https://rmp-api.rik.ee/v1/x");

    expect(response.status).toBe(500);
    expect(response.statusText).toBe("");
  });

  it("rejects instead of crashing when Response construction fails", async () => {
    const { res } = setupRequest();
    respond(res, { statusCode: 100, statusMessage: "Continue" });

    await expect(rikFetch("https://rmp-api.rik.ee/v1/x")).rejects.toThrow(RangeError);
  });

  it("rejects with the request error when there is no signal", async () => {
    const { req } = setupRequest();
    const boom = new Error("ECONNREFUSED");
    queueMicrotask(() => req.emit("error", boom));

    await expect(rikFetch("https://rmp-api.rik.ee/v1/x")).rejects.toBe(boom);
  });

  it("rejects with the signal reason when the request is aborted", async () => {
    const { req } = setupRequest();
    const controller = new AbortController();
    const reason = new DOMException("timed out", "TimeoutError");
    queueMicrotask(() => {
      controller.abort(reason);
      req.emit("error", new Error("socket hang up"));
    });

    await expect(
      rikFetch("https://rmp-api.rik.ee/v1/x", { signal: controller.signal }),
    ).rejects.toBe(reason);
  });

  it("rejects when the response stream errors mid-body", async () => {
    const { res } = setupRequest();
    const boom = new Error("aborted");
    queueMicrotask(() => {
      queueMicrotask(() => {
        res.statusCode = 200;
        res.emit("data", Buffer.from("{"));
        res.emit("error", boom);
      });
    });

    await expect(rikFetch("https://rmp-api.rik.ee/v1/x")).rejects.toBe(boom);
  });
});
