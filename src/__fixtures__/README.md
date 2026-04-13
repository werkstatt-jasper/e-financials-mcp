# RIK API test fixtures

JSON samples mirror shapes returned by the e-Financials REST API (pagination, list `items`, error bodies). Keys are arbitrary labels for tests to pick a slice.

## Files

| File | Contents |
|------|----------|
| `accounts.json` | Chart of accounts lists, dimensions, search samples |
| `clients.json` | Paginated client list, search rows, POST response, supplier list |
| `transactions.json` | Paginated transactions, single entity, multi-page pagination slices, reconciliation list row, generic HTTP mock bodies |
| `invoices.json` | Sales invoice list, GET body for patch flow, reconciliation sale/purchase list items |
| `error-responses.json` | JSON bodies for HTTP and API-level errors (`response_code`, `message`, `errors[]`) and success-with-`response_code` |

## Importing in tests (ESM)

```typescript
import clientsFixture from "../__fixtures__/clients.json" with { type: "json" };

vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.list_paginated });
```

Use object spread or `structuredClone()` if a test mutates the resolved value.

## Mocking `EFinancialsClient` (tool tests)

Use [`src/tools/test-helpers.ts`](../tools/test-helpers.ts) `createMockClient()`, then stub methods:

```typescript
import { createMockClient } from "./test-helpers.js";

const client = createMockClient();
vi.mocked(client.get).mockResolvedValue({ ...clientsFixture.list_paginated });
```

## Mocking global `fetch` (client tests)

Stub `fetch` and wrap bodies with `Response` + `JSON.stringify`, as in [`src/client.test.ts`](../client.test.ts) `jsonResponse()`. Reuse `error-responses.json` for error JSON bodies and `transactions.json` for paginated list shapes.

## Deterministic time (`auth` tests)

For HMAC timestamps, use `vi.useFakeTimers()` / `vi.setSystemTime(...)` in `beforeEach` and `vi.useRealTimers()` in `afterEach`. See [`src/auth.test.ts`](../auth.test.ts).
