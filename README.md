# FixFlow Manufacturer API — demo client

![The demo client: register your directory, create a work order with your own keys, and watch the tracked work orders update from the change feed](docs/screenshot.png)

A small reference client for the **FixFlow Manufacturer API v1**. Your system uses this API to send repair
work orders to FixFlow and to track their status by polling.

It shows the whole integration end to end:

- **Verify the key** (`GET /key`).
- **Register your directory under your own ids**: end customers (`POST /customers`), their sites
  (`POST /service-locations`) and your units by serial number (`POST /equipment`). Registration is
  idempotent, and FixFlow finds rows it already has instead of making duplicates.
- **Create work orders with your keys only** (`POST /work-orders`). Retries are idempotent on
  `externalReference`, field errors come back as a `422`, and you can classify the fault with a
  `problemId` from the **problem catalogue** (`GET /problems`).
- **Track status** with the polling loop over the change feed (`GET /work-orders/changes`): store the
  cursor, follow `hasMore`, apply snapshots by id.
- **Look things up by your own keys**: a work order by your claim number, a customer, a site, a unit by
  serial number.
- **Handle rate limits** (`429` + `Retry-After`).

It runs out of the box against a **built-in mock** of the API, so you can try everything before you
have a key.

The full contract is the FixFlow public API page, `https://<your-fixflow-host>/ui/fixflow/manufacturer-api/`.
A copy of its OpenAPI document is in [`contract/openapi.v1.json`](contract/openapi.v1.json).

## Quick start (no key needed)

Requires Node.js 22 or newer.

```sh
npm install
npm run dev
```

Open <http://127.0.0.1:3000>. With no FixFlow host or key configured, the demo starts an in-process
mock of the API:

1. Press **Register**. The sample customer and site already exist in the mock's FixFlow, as if a
   dispatcher had entered them before the integration existed. Your keys are mapped onto those rows
   instead of creating copies.
2. Press **Create work order**. The work order is sent with your keys only.
3. Watch **Tracked work orders**. The mock moves every open work order one status forward every
   15 seconds (`New → Dispatched → Assigned → EnRoute → OnSite → Working → Done`), and the change feed
   picks the changes up.

Prefer a terminal? `npm run walkthrough` runs the same flow and prints every call.

## Run it against FixFlow

1. **Get an API key.** Keys are issued per integrating system and shown **once**. You can get one in
   two ways:
   - on the **API keys** page of the FixFlow manufacturer portal (any active portal user of your
     company can create one, and revoke it there too);
   - from your FixFlow contact.
2. Copy `.env.example` to `.env` and set:

   ```ini
   FIXFLOW_BASE_URL=https://<your-fixflow-host>/fixflow
   FIXFLOW_API_KEY=ffmfr_...
   ```

3. Run `npm run dev` (or `npm run build && npm start`). The badge in the top-right corner changes
   from **Mock** to **Live**.

> **Careful:** in live mode everything you register and every work order you create is real. Work
> orders land in FixFlow's dispatch queue, and a dispatcher will act on them. The same goes for
> `npm run walkthrough -- --live`, so point it at a test environment.

**Never put the key in a browser.** The browser part of this demo only talks to the demo's own
`/api/*` routes. The Node server holds the key and calls FixFlow.

## The integration in short

### 1. Address everything by your own keys

| What | Your key | Registered with |
| --- | --- | --- |
| End customer | its id in your system (`reference`) | `POST /customers` |
| Site | its id in your system (`reference`) | `POST /service-locations` |
| Unit | its serial number | `POST /equipment` |
| Fault (optional) | a `problemId` from FixFlow's catalogue | `GET /problems` |

You never need to store FixFlow ids. If your system has no site id, use any key you can rebuild for
the same site every time, for example your customer id plus the site number.

Registration is find-or-create:

- **The first call with a key** answers `201`. FixFlow first looks for a row it already has: a
  customer by name **together with** an address, a site by address and ZIP among that customer's
  sites, a unit by serial number at that site. Only if there is none does it create one.
- **Every later call with the same key** answers `200` with what FixFlow has stored, unchanged
  (header `Idempotent-Replayed: true`).
- **The API never updates or deletes** customers, sites or units. Corrections are made by FixFlow's
  dispatchers.
- **A serial number already registered at another of your sites** answers `409`.

### 2. Create work orders with the keys

`customer.reference` and `serviceLocation.reference` are always required. A key FixFlow already
knows wins: everything else about that customer or site is then optional, and ignored if you send
it.

| Field | Needed |
| --- | --- |
| `customer.name` | only while `customer.reference` is unknown to FixFlow |
| `serviceLocation.addressLine1`, `.city`, `.state`, `.zip` | only while `serviceLocation.reference` is unknown |
| `equipment.modelNumber` | only when no unit of yours with that `serialNumber` is at the site |

So you can register first (as this demo does) or send the full details with the first work order for
a customer or site. Either way, later claims need the keys only. A missing field that is needed comes
back as a `422` naming that field. In the UI, open **Not registered yet? Send the details inline** to
try the second way.

`externalReference` (your claim or case number) is the idempotency key:

- the first `POST` creates the work order (`201`);
- any later `POST` with the same value returns the same work order unchanged (`200` + header
  `Idempotent-Replayed: true`).

So a request that timed out can always be retried safely. In the UI, submit the form twice without
pressing **New** to see it.

### 3. Poll the change feed

1. **First start.** Call `GET /work-orders/changes` without a cursor. You get no items and a
   `nextCursor`: that subscribes you from now on. Store the cursor.
2. **Every 30–60 seconds.** Call `GET /work-orders/changes?cursor=<stored>`. Apply every item, then
   store the new `nextCursor`.
3. **While `hasMore` is `true`.** Call again straight away.

Rules that matter:

- **Every item is the current snapshot** of a work order, not a diff.
- **Delivery is at-least-once.** The same work order can come again, so apply items by `id`.
- **Changes appear after about 5 seconds**, not instantly.
- **Creating a work order is not a feed event.** Keep the `201` response; later changes come through
  the feed. That includes the dispatcher changing the `problem`.
- **To replay history**, call with `since=<ISO time>` instead of a cursor.

## What to look at

| File | What it shows |
| --- | --- |
| [`src/walkthrough.ts`](src/walkthrough.ts) | The recommended flow in one readable script: key → register → work order → read back → subscribe. |
| [`src/fixflow/client.ts`](src/fixflow/client.ts) | A dependency-free API client: `X-Api-Key`, problem details → `FixFlowApiError`, the `429` retry after `Retry-After`, registrations and creates with the `replayed` flag, the paged problem catalogue. |
| [`src/fixflow/types.ts`](src/fixflow/types.ts) | The v1 contract as TypeScript types. |
| [`src/sync/poller.ts`](src/sync/poller.ts) | The recommended polling loop. |
| [`src/sync/state-store.ts`](src/sync/state-store.ts) | Where the cursor lives. Apply a page, **then** store its `nextCursor`. |
| [`src/mock/mock-api.ts`](src/mock/mock-api.ts) | The mock API, kept faithful to the contract by `test/contract.test.ts`. |
| [`src/web/app.ts`](src/web/app.ts), [`public/`](public/) | The demo UI and its small backend. |

## Scripts

| Command | Does |
| --- | --- |
| `npm run dev` | Runs the demo with auto-reload (TypeScript via `tsx`). |
| `npm run build` / `npm start` | Compiles to `dist/` and runs the compiled app. |
| `npm run walkthrough` | Runs the recommended flow against a fresh mock and prints every call; `-- --live` runs it against the FixFlow in `.env`. |
| `npm test` | Runs the client, registration, poller and contract tests against the mock (`node:test`). |
| `npm run typecheck` | Type-checks everything. |
| `npm run mock` | Runs only the mock API on <http://127.0.0.1:4010/fixflow> (key `ffmfr_mock_demo_key`), so you can point your own client at it. |

Settings (all optional) are listed in [`.env.example`](.env.example).

## Notes

- **State storage.** The demo keeps its state in `data/<mode>/state.json`: the feed cursor, the work
  orders seen, and what it registered (only to offer your keys in the forms). A real integration keeps
  the cursor and the work orders in its own database, in the same transaction as the applied
  changes; its own ids already are the keys.
- **The mock is a simplification.** It follows the documented behaviour of v1, but the real API
  matches the customer, site and unit more thoroughly. The public API page describes those rules.

## License

[MIT](LICENSE).
