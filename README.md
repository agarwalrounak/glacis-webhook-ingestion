# Glacis - AI Webhook Ingestion Service

A backend that accepts arbitrary vendor webhook JSON, uses an LLM to classify and normalize it into canonical **shipment** or **invoice** records, and persists the result in MySQL with strong guarantees against the realities of vendor integrations: duplicates, out-of-order delivery, sub-second ack requirements, schema drift, and partial failure.

---

## Quick start

```bash
cp .env.example .env             # set LLM_PROVIDER + the relevant API key
docker compose up --build        # boots MySQL + API + worker
# In another shell:
node scripts/replay-samples.js   # POSTs the 6 sample payloads, prints final state
```

The LLM provider is selectable: set `LLM_PROVIDER=anthropic` (default) or `LLM_PROVIDER=openai` in `.env`. The provider abstraction lives in `src/llm/` — the canonical schema is defined once in `normalizeTool.js`, and per-provider adapters in `src/llm/providers/` wrap it in each vendor's tool-calling shape. Nothing outside `src/llm/` knows or cares which provider is in use.

The replay harness:

1. POSTs all 6 sample payloads **concurrently** (vendors don't politely serialize).
2. POSTs payload #1 a **second time** to demonstrate dedupe.
3. Waits for the worker to drain.
4. Prints the materialized `shipments` and `invoices` tables plus their full event history, and runs three sanity checks (Maersk shipment advances to `IN_TRANSIT` despite out-of-order delivery; GFP invoice ends in `PAID` with both events recorded; the marine advisory is routed to `unclassified`).

---

## Sending a test webhook

The endpoint accepts any well-formed JSON. Useful for poking the system from a terminal, Postman, or a vendor sandbox.

**Single POST — minimum viable:**

```bash
curl -sS -X POST http://localhost:3000/webhooks \
  -H 'content-type: application/json' \
  -d '{
    "carrier_scac": "MAEU",
    "transport_doc": { "type": "MBL", "number": "MAEU240498712" },
    "container": "MSKU7748112",
    "milestone": "Loaded onboard and sailed",
    "milestone_at": "2026-04-21T22:47:00+08:00"
  }' | jq
```

Response (immediate, < 100 ms):

```json
{ "ok": true, "raw_event_id": 1 }
```

The LLM call happens asynchronously in the worker (~2–5 s later). Watch `docker compose logs -f app` to see it process, then inspect the result:

```bash
curl -sS http://localhost:3000/raw-events  | jq '.[] | {id, status, classification, attempts}'
curl -sS http://localhost:3000/shipments   | jq
curl -sS http://localhost:3000/invoices    | jq
```

**Tag with a vendor name** (lands in `raw_events.vendor_hint`):

```bash
curl -sS -X POST http://localhost:3000/webhooks/lastmilenow \
  -H 'content-type: application/json' \
  -d '{ "system": "LastMileNow API", "tracking_reference": "LMN-99999",
        "update": { "description": "On the truck" },
        "timestamp_utc": "2026-05-24T12:15:00Z" }'
```

**Demonstrate dedupe** (identical bodies):

```bash
PAYLOAD='{"carrier":"DHL","awb":"123-99999","milestone":"departed","event_time":"2026-05-24T10:00:00Z"}'

curl -sS -X POST http://localhost:3000/webhooks \
  -H 'content-type: application/json' -d "$PAYLOAD" | jq
# → { "ok": true, "raw_event_id": 2 }

curl -sS -X POST http://localhost:3000/webhooks \
  -H 'content-type: application/json' -d "$PAYLOAD" | jq
# → { "ok": true, "duplicate": true, "raw_event_id": 2, "status": "..." }
```

**Demonstrate out-of-order** (same entity, two events, "wrong" order):

```bash
# DELIVERED arrives first
curl -sS -X POST http://localhost:3000/webhooks -H 'content-type: application/json' -d '{
  "logistics_provider": "TestCarrier", "parcel_id": "TEST-001",
  "scan_type": "Handed to recipient", "scan_time": "2026-05-25T14:45:00Z"
}'

sleep 5

# Then PICKED_UP (chronologically earlier)
curl -sS -X POST http://localhost:3000/webhooks -H 'content-type: application/json' -d '{
  "logistics_provider": "TestCarrier", "parcel_id": "TEST-001",
  "scan_type": "Collected from sender", "scan_time": "2026-05-23T10:15:00Z"
}'

sleep 5

# current_state should be DELIVERED; history should have BOTH events.
curl -sS http://localhost:3000/shipments | jq '.[] | select(.natural_key | contains("test-001"))'
```

**Unhappy paths:**

```bash
# Malformed JSON → 400 malformed_json
curl -i -X POST http://localhost:3000/webhooks \
  -H 'content-type: application/json' -d '{ this is not json'

# Payload > 256 KiB → 413 payload_too_large
python3 -c "import json,sys; sys.stdout.write(json.dumps({'data':'x'*300000}))" \
  | curl -i -X POST http://localhost:3000/webhooks \
      -H 'content-type: application/json' --data-binary @-
```

**Query MySQL directly** (for debugging):

```bash
docker compose exec mysql mysql -uroot -proot glacis -e "
  SELECT id, status, classification, attempts, entity_type, entity_id, llm_latency_ms
    FROM raw_events ORDER BY id DESC LIMIT 5;"
```

---

## Architecture

```
  vendor                                                        Anthropic API
    │                                                                │
    │ POST /webhooks (arbitrary JSON)                                │
    ▼                                                                │
 ┌───────────────────────────────────────────┐                       │
 │ Express API (src/api/server.js)            │                      │
 │                                            │                      │
 │  1. capture raw bytes                      │                      │
 │  2. SHA-256(body) → body_hash              │                      │
 │  3. INSERT raw_events (UNIQUE body_hash)   │                      │
 │  4. respond 200 in <100ms                  │                      │
 └────────────────────┬───────────────────────┘                      │
                      │                                              │
                      ▼                                              │
              ┌─────────────────┐                                    │
              │   MySQL 8       │     ┌──────────────────────────┐   │
              │                 │◀────│ Worker (src/worker/*)    │   │
              │  raw_events     │     │                          │   │
              │  shipments      │     │  SELECT … FOR UPDATE     │   │
              │  shipment_events│     │  SKIP LOCKED             │   │
              │  invoices       │     │     │                    │   │
              │  invoice_events │     │     ▼                    │   │
              └─────────────────┘     │  normalize(payload)  ────┼───┘
                                      │     │                    │
                                      │     ▼                    │
                                      │  apply state machine     │
                                      │  + flip raw_events.status│
                                      │  (single transaction)    │
                                      └──────────────────────────┘
```

The pipeline is intentionally split into **two stages with different latency budgets**:

- **Ingest path (hot)** — must respond in <1s. Does nothing but parse, hash, write a row, and ack. No LLM, no entity logic, no joins.
- **Normalize path (cold)** — async worker pulling from MySQL. Each event takes seconds of LLM time but can be parallelized and retried freely.

The same database row (`raw_events`) is **both the inbox and the queue**. This collapses two services into one, and — more importantly — makes it impossible to write normalized data without also flipping the inbox status (they happen in the same transaction).

---

## Canonical schema (the LLM contract)

The LLM is constrained to call a single tool, `normalize_webhook`, defined in [`src/llm/normalizeTool.js`](src/llm/normalizeTool.js). We define a JSON Schema on the tool's `input_schema`; the Anthropic API uses it to steer the model toward conforming output (via training and partial constrained decoding). This is not a hard guarantee — enum violations and cross-field invariants can still slip through — so we run the model's `tool_use.input` through AJV and route validation failures to `needs_review`.

The schema is a **discriminated union on `type`**:

```ts
{
  type: 'shipment' | 'invoice' | 'unclassified',
  confidence: 'low' | 'medium' | 'high',
  reasoning: string,
  shipment?: { natural_key, state, event_at, … },
  invoice?:  { natural_key, state, event_at, amount_minor, currency, … },
}
```

**Canonical states:**

| Entity | States | Rank |
| --- | --- | --- |
| Shipment | `PICKED_UP → IN_TRANSIT → OUT_FOR_DELIVERY → DELIVERED` | 10/20/30/40 |
| Invoice | `ISSUED → PAID` with alternates `VOIDED` (from ISSUED) and `REFUNDED` (from PAID) | 10/20/20/30 |

Vendor vocabulary varies wildly: "loaded onboard and sailed" → `IN_TRANSIT`, "settled in full" → `PAID`, "released to consignee" → `DELIVERED`. The system prompt enumerates these mappings explicitly; new vendors require no code changes, only prompt examples if their phrasing is novel.

**Entity identity.** Each normalized record carries a `natural_key` — a deterministic, colon-separated string composed by the LLM from the strongest stable identifiers in the payload (e.g. `MAEU:MBL:MAEU240498712:MSKU7748112` for shipments, `globalfreightpay.api:GFP-INV-2026-Q2-08821` for invoices). This is the join key that collapses events about the same physical parcel or document across vendors and over time. It is `UNIQUE` in the `shipments` / `invoices` tables, so upserts are deterministic.

---

## How the hard problems are solved

### 1. Sub-second ack

The API never calls the LLM. It writes one row to `raw_events` and returns 200. End-to-end p50 should be tens of milliseconds against a warm MySQL connection. The LLM is invoked later by the worker.

### 2. Idempotency (two layers)

Vendors retry aggressively after timeouts, network blips, or just because. The system tolerates this at two layers:

- **L1 — raw payload dedup.** `body_hash` (SHA-256 of the raw bytes) is `UNIQUE` on `raw_events`. A duplicate POST resolves to the same row and returns 200 with `duplicate: true`. No LLM cost is ever paid for a duplicate.
- **L2 — entity-event dedup.** `shipment_events` and `invoice_events` have `UNIQUE(entity_id, raw_event_id)`. If a worker crashes after the LLM call but before commit, the next worker re-processes the same `raw_event` and the unique constraint makes the entity-event insert a no-op. The materialized state is therefore exactly-once even though the LLM call is at-least-once.

### 3. Out-of-order delivery

Sample payloads #1 and #2 demonstrate this exactly: the IN_TRANSIT webhook (Apr 21) arrives before the PICKED_UP webhook (Apr 19). The system handles this by separating two notions:

- **History** (`*_events` tables) always appends in order of arrival, with the event's own `event_at`.
- **Current state** (`shipments.current_state`, `invoices.current_state`) only advances on **strict rank increase**. A delayed PICKED_UP arriving after IN_TRANSIT is recorded in history but does not regress the materialized state. See [`src/domain/states.js`](src/domain/states.js) and the `advanced_current_state` boolean on each event row, which records whether that event moved the materialized cursor.

### 4. Worker crashes mid-processing

The worker uses a **two-transaction claim-then-process pattern**:

- The claim transaction runs `SELECT … FOR UPDATE SKIP LOCKED` to find a pending row, flips its status to `processing`, sets `locked_until = NOW() + lease_seconds`, increments `attempts`, and commits. Row lock released.
- The LLM call happens **outside any transaction** (LLM calls take seconds; you must never hold an InnoDB transaction open that long).
- The settle transaction writes the normalized entity AND flips `raw_events.status` together, atomically.

If the worker crashes between transactions, the row stays in `processing` status with a lease. When `locked_until` expires, another worker re-claims it (with `attempts` already incremented). Worst case: an LLM call is wasted; correctness is preserved.

### 5. LLM failures

The worker distinguishes three failure modes from the LLM:

| Kind | Cause | Disposition |
| --- | --- | --- |
| `network` | Transport, 5xx, 429, timeout | Back to `pending` with exponential backoff (5s, 20s, 80s, 320s, ~21min, +jitter); after `WORKER_MAX_ATTEMPTS` → `dead` (DLQ) |
| `invocation` | Model returned prose, didn't call the tool | Route to `needs_review` immediately — retrying won't help |
| `schema` | Tool input failed AJV validation | Route to `needs_review`; record the offending input for prompt iteration |

Additionally, **low-confidence** successful classifications (where the model itself signals uncertainty) are routed to `needs_review` rather than silently written. This protects the canonical tables from garbage when the model isn't sure, at the cost of needing a human-review path for ambiguous webhooks.

### 6. Concurrent workers

`SELECT … FOR UPDATE SKIP LOCKED` is the load-bearing primitive. Multiple workers claim disjoint sets of rows with zero coordination — no broker, no leader election, no Redis lock. The `(status, locked_until, id)` composite index ensures the claim query is a short range scan, so row-level locks cover only the rows we actually intend to claim. See [`src/worker/claim.js`](src/worker/claim.js).

Inside the settle transaction, the domain layer takes `SELECT … FOR UPDATE` on the `shipment` or `invoice` row before checking-and-advancing `current_state`. Two events for the same entity processed in parallel will serialize on that row lock — neither can read a stale `current_state_rank` while the other is updating it.

### 7. Schema drift / new vendors

There is no per-vendor parser. Adding a new vendor with a never-before-seen payload structure costs zero code changes: the LLM extracts whatever is there. If accuracy on a new vendor is poor, the fix is a few examples in the system prompt, not a deploy.

The `raw_events` table is preserved forever (until archived). When the canonical schema or prompt evolves, we can re-normalize history with `UPDATE raw_events SET status='pending' WHERE …` — the replay is a SQL statement.

---

## Schema

5 tables; full DDL in `migrations/`.

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `raw_events` | Inbox + queue + audit log | `UNIQUE(body_hash)`, index `(status, locked_until, id)` |
| `shipments` | Materialized current state per parcel | `UNIQUE(natural_key)` |
| `shipment_events` | Append-only history | `UNIQUE(shipment_id, raw_event_id)` |
| `invoices` | Materialized current state per invoice | `UNIQUE(natural_key)` |
| `invoice_events` | Append-only history | `UNIQUE(invoice_id, raw_event_id)` |

Monetary amounts are stored as integer `amount_minor` (e.g. cents) to avoid binary float drift; the LLM parses locale-specific punctuation ("EUR 24.350,75") into the integer.

---

## Trade-offs taken for the time-box

These are the calls I made knowingly and would revisit for production:

1. **MySQL as the queue.** No Redis, no Kafka. Pros: one dependency, transactional with entity writes (no "wrote to DB but didn't ack queue" failure mode), trivial replay (`UPDATE … SET status='pending'`). Cons: polling has a small floor cost; no fan-out to multiple consumers; housekeeping on the table is on us. Scales fine to thousands of events/sec; beyond that, swap in a dedicated queueing system (Redis, Kafka). Two-transaction pattern in [`src/worker/process.js`](src/worker/process.js) is mandatory and the code review checklist must enforce "no LLM call inside a transaction."

2. **Single-process API + worker container.** They run side-by-side via `concurrently` for the assessment. In production they are separate deployments with separate scaling profiles — the API scales on request rate, the worker scales on `raw_events.status='pending'` backlog depth.

3. **No webhook signature verification.** Every real vendor signs requests; we'd verify `x-signature` per-vendor before persisting. The infrastructure is there (signed headers are captured in `raw_events.headers`), just not the verification step. Until done, the endpoint trusts any caller.

4. **No authentication on the read endpoints.** `/shipments`, `/invoices`, `/raw-events` are open for the replay harness. A real read API would be authenticated and behind separate routing.

5. **Single LLM call per event.** No two-stage classify-then-extract, no model triage (cheap classifier → expensive extractor). For these payloads a single Sonnet call is accurate enough. At scale, the cost-optimal path is Haiku classification → Sonnet extraction only for shipments/invoices.

6. **No prompt caching.** The Anthropic prompt-caching feature would cache the system prompt + tool schema (~2 KB of stable prefix), cutting per-call cost ~70%. Single-line change — not done because it complicates explaining the bare path.

7. **Confidence-based human review, no UI.** Low-confidence and schema-invalid results land in `raw_events` with `status='needs_review'` but there's no UI to act on them. The data is there; the review surface isn't.

8. **No observability tooling.** Structured logs via pino, but no metrics, no traces, no alerting. In production this is a Prometheus + OTel job: `raw_events.status` counters, claim-to-settle latency histograms, LLM latency/cost per call, queue depth alarms.

9. **Invoice state transitions enforced by rank only.** "Don't regress" is enforced, but stricter transition rules (e.g. REFUNDED only valid after PAID; VOIDED only from ISSUED) are *not* enforced as hard constraints — they're documented in `src/domain/states.js`. The history is the source of truth; the materialized `current_state` is a convenience. Sufficient for the assessment; in production I'd add a transition map.

---

## Production roadmap

In rough priority order — what I'd do next to take this to production:

**Trust & safety**

- Per-vendor HMAC/signature verification middleware, with key rotation.
- Authentication on read APIs (mTLS or signed JWTs from the platform).
- Rate limiting + per-vendor circuit breakers (a misbehaving vendor must not exhaust the LLM budget).
- Secret management via Vault / SM (not `.env`).

**Observability**

- Metrics: queue depth by status, claim-to-settle p50/p95, LLM latency histograms by model, classification distribution, `needs_review` rate, DLQ size, cost-per-event.
- Tracing: OpenTelemetry spans ingest → claim → LLM → settle, tagged with `raw_event_id`. Correlate across container boundaries.
- Alerts: `pending` depth > N for > M min, `dead` rate > X%, p95 ingest latency > 1s, MySQL connection saturation.
- Per-vendor dashboards (classification accuracy, latency, cost).

**Operational tooling**

- Web UI for `needs_review`: render the raw payload + LLM output + reasoning; let an operator approve, edit, or reclassify. Operator decisions feed back into prompt refinement.
- DLQ replay UI: select a `dead` event, optionally edit its payload, requeue.
- "Re-normalize history" workflow: given a prompt version, re-process all `raw_events` since date X, compare results, blue/green cutover.

**Scale & cost**

- Move queue from MySQL to a dedicated queueing system (Redis, Kafka, etc.) when sustained throughput exceeds ~1k events/sec. Outbox pattern preserves the transactional ack semantics.
- Two-stage LLM: Haiku for classification + identity extraction; Sonnet only for shipment/invoice extraction. Probably ~5x cheaper for the unclassified-heavy traffic mix.
- Prompt caching on the system prompt + tool schema. ~70% LLM cost reduction.
- Batch API for non-realtime backfills.

**Data quality**

- Per-vendor accuracy evals on a held-out set; CI fails if a prompt change regresses any vendor's accuracy.
- A/B prompt rollouts behind a feature flag, with shadow comparison against the current prompt.
- Confidence calibration: do `high`-confidence outputs actually agree with human review at >99%? If not, recalibrate the prompt's confidence guidance.

**Schema evolution**

- Versioned canonical schema. New required field on `shipments`? Add a column, backfill by re-normalizing `raw_events` with the new prompt, blue/green cut traffic over. `raw_events` being immutable + the LLM being deterministic-ish makes this safe.

---

## Repo layout

```
.
├── docker-compose.yml          # MySQL 8 + app, one command up
├── Dockerfile
├── .env.example                # ANTHROPIC_API_KEY etc.
├── migrations/                 # Sequelize migrations (DDL only — plain SQL where it matters)
├── src/
│   ├── api/server.js           # Express ingest + read endpoints
│   ├── worker/
│   │   ├── index.js            # main loop + graceful shutdown
│   │   ├── claim.js            # SKIP LOCKED claim, lease management
│   │   ├── process.js          # LLM call + state machine + status flip
│   │   └── backoff.js          # exponential backoff with jitter
│   ├── llm/
│   │   ├── client.js           # Anthropic SDK wrapper + AJV validation
│   │   └── normalizeTool.js    # THE canonical schema (tool definition)
│   ├── domain/
│   │   ├── states.js           # state rank tables
│   │   ├── shipments.js        # upsert + advance-current logic
│   │   └── invoices.js
│   ├── models/                 # Sequelize models
│   ├── db/                     # connection + sequelize-cli config
│   ├── config.js
│   └── logger.js
└── scripts/
    ├── samples.js              # the 6 sample payloads as a fixture
    └── replay-samples.js       # end-to-end demo + sanity checks
```

---

## Failure modes catalog (for the record)

A non-exhaustive list of failure modes the design defends against:

| Failure | Defense |
| --- | --- |
| Vendor retries identical payload | `body_hash UNIQUE` on `raw_events`; second POST returns 200 immediately |
| Vendor retries with whitespace differences | New `raw_events` row, but entity-layer `UNIQUE(entity_id, raw_event_id)` prevents duplicate state changes (event lands in history as a non-advancing event) |
| Events arrive out of order | Strict-rank advance on `current_state`; history always appends |
| Two events for same entity processed concurrently | `SELECT FOR UPDATE` row lock inside the settle transaction serializes them |
| Worker crashes mid-LLM-call | Row stays at `status='processing'`. The claim query picks up `processing` rows with expired `locked_until` (alongside normal `pending` work) — a single primitive handles both new work and dead-worker recovery. LLM call wasted, correctness preserved. |
| Worker crashes between LLM and settle | Same as above — settle transaction never committed, row eventually re-claimed via lease expiry |
| LLM returns malformed tool input | AJV validation fails → `needs_review` (don't retry; this is a model bug) |
| LLM returns ambiguous classification | `confidence: 'low'` → `needs_review` |
| LLM is down / rate limited | Exponential backoff with jitter; after N attempts → `dead` (DLQ) |
| DB is down at ingest | API returns 500 → vendor retries → eventually succeeds with same `body_hash` |
| DB transient failure during settle | Transaction rolls back; row reverts to `pending` with backoff |
| Vendor sends malformed JSON | API returns 400 with parse error message; no `raw_event` row created |
| Vendor sends huge payload | API returns 413 (`MAX_BODY_BYTES`); protects LLM token budget |
| Prompt/schema bug causes wrong outputs | Fix prompt, mass `UPDATE raw_events SET status='pending'`, worker re-processes |
| New vendor with novel payload | Zero code change; if accuracy is bad, add examples to system prompt |
| Same entity referenced by two different vendors | LLM composes `natural_key` deterministically; if both vendors share identifiers (SCAC + BL), they collide cleanly; if not, they're separate records and a downstream entity-resolution job links them |
