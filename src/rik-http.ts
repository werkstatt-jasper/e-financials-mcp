/**
 * Minimal `node:https` transport for RIK API calls, returning WHATWG `Response`s.
 *
 * Why not global `fetch`: Node's fetch (undici) unconditionally appends
 * `Sec-Fetch-Mode: cors` — a forbidden header callers cannot override or
 * remove — plus `Accept-Language: *`. Cloudflare bot protection in front of
 * the production RIK API (`rmp-api.rik.ee`) challenges that header profile
 * from datacenter IPs with an HTML 403 page, while a plain `node:https`
 * request from the same host, IP, and TLS stack passes. Keeping the
 * fetch-like call shape lets `EFinancialsClient` logic stay unchanged.
 */
import { Buffer } from "node:buffer";
import type { IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";

export interface RikFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/** Statuses the `Response` constructor refuses to pair with a body. */
const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function toWebHeaders(raw: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(name, item);
      }
    } else {
      headers.set(name, value);
    }
  }
  return headers;
}

/**
 * fetch-like HTTPS request that sends exactly the given headers (plus
 * `Content-Length` for bodies) — no implicit `Sec-Fetch-Mode`, `Accept`,
 * `Accept-Language`, or `Accept-Encoding`. The response body is fully
 * buffered before the `Response` resolves, so `signal` covers the complete
 * exchange like it does for `fetch`; on abort the promise rejects with the
 * signal's reason (e.g. a `TimeoutError` from `AbortSignal.timeout`).
 */
export function rikFetch(url: string, init: RikFetchInit = {}): Promise<Response> {
  const { method = "GET", headers = {}, body, signal } = init;

  return new Promise((resolve, reject) => {
    const requestHeaders: Record<string, string> = { ...headers };
    if (body !== undefined) {
      requestHeaders["Content-Length"] = String(Buffer.byteLength(body));
    }

    const rejectWithAbortReason = (error: unknown): void => {
      reject(signal?.aborted ? signal.reason : error);
    };

    const req = httpsRequest(url, { method, headers: requestHeaders, signal }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on("end", () => {
        try {
          const status = res.statusCode ?? 500;
          const bodyBuffer = Buffer.concat(chunks);
          const responseBody =
            NULL_BODY_STATUSES.has(status) || bodyBuffer.length === 0 ? null : bodyBuffer;
          resolve(
            new Response(responseBody, {
              status,
              statusText: res.statusMessage ?? "",
              headers: toWebHeaders(res.headers),
            }),
          );
        } catch (error) {
          // e.g. a status outside Response's [200, 599] range; reject instead
          // of throwing inside the event handler (which would crash the process).
          reject(error);
        }
      });
      res.on("error", rejectWithAbortReason);
    });

    req.on("error", rejectWithAbortReason);
    req.end(body);
  });
}
