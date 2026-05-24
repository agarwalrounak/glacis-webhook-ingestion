'use strict';

/**
 * End-to-end replay harness.
 *
 * Sends the combined fixture (original brief + stress brief) to the running
 * API, then polls until the worker drains the queue, then prints the
 * resulting shipments/invoices state plus PASS/FAIL sanity checks against
 * the expected outcomes of every brief section.
 *
 * Also exercises:
 *   - duplicate detection (POSTs the first payload twice on top of any
 *     intra-fixture byte-identical pairs)
 *   - concurrent POSTs (every entry in parallel — vendors don't queue)
 *
 * Usage:
 *   API_URL=http://localhost:3000 node scripts/replay-samples.js
 */

const samples = require('./samples-stress');

const API = process.env.API_URL || 'http://localhost:3000';
const DRAIN_TIMEOUT_MS = 120000; // LLM calls can be slow; allow generous time.

async function postOne(label, body) {
  const r = await fetch(`${API}/webhooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  // Spread the body FIRST so the response's `status` field (the row status)
  // doesn't shadow our explicit HTTP status code below.
  return { label, ...json, http: r.status };
}

async function getJson(path) {
  const r = await fetch(`${API}${path}`);
  if (!r.ok) throw new Error(`${path} returned ${r.status}`);
  return r.json();
}

async function waitForDrain() {
  const deadline = Date.now() + DRAIN_TIMEOUT_MS;
  let lastPending = -1;
  while (Date.now() < deadline) {
    const raws = await getJson('/raw-events');
    const pending = raws.filter((r) => r.status === 'pending' || r.status === 'processing').length;
    const done = raws.filter((r) => r.status !== 'pending' && r.status !== 'processing').length;
    if (pending !== lastPending) {
      console.log(`  waiting for drain: pending/processing=${pending}, settled=${done}`);
      lastPending = pending;
    }
    if (pending === 0 && raws.length > 0) return raws;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error('drain timeout');
}

function summarize(raw) {
  return {
    id: raw.id,
    status: raw.status,
    classification: raw.classification,
    attempts: raw.attempts,
    entity: raw.entity_type ? `${raw.entity_type}#${raw.entity_id}` : null,
    latency_ms: raw.llm_latency_ms,
    error: raw.last_error,
  };
}

(async () => {
  console.log(`Replay harness against ${API}\n`);

  // Phase 1: POST all entries in parallel — vendors don't politely serialize.
  console.log(`Phase 1: POST ${samples.length} sample payloads concurrently`);
  const results = await Promise.all(samples.map((s) => postOne(s.label, s.body)));
  results.forEach((r) => console.log(`  [${r.http}] ${r.label} → raw_event_id=${r.raw_event_id}${r.duplicate ? ' (DUP)' : ''}`));

  // Phase 2: duplicate POST of payload #1 — should be absorbed.
  console.log('\nPhase 2: duplicate POST of payload #1 (expect duplicate=true)');
  const dup = await postOne(samples[0].label, samples[0].body);
  console.log(`  [${dup.http}] duplicate=${dup.duplicate} raw_event_id=${dup.raw_event_id} (server reports row status=${dup.status})`);

  // Phase 3: wait for worker to drain.
  console.log('\nPhase 3: waiting for worker to drain queue...');
  const raws = await waitForDrain();
  console.log('\nRaw events (final state):');
  console.table(raws.map(summarize));

  // Phase 4: dump materialized entities.
  console.log('\nShipments:');
  const shipments = await getJson('/shipments');
  shipments.forEach((s) => {
    console.log(`  [${s.id}] natural_key=${s.natural_key}`);
    console.log(`    current_state=${s.current_state} @ ${s.current_state_at}`);
    console.log(`    container=${s.container_no || '-'} doc=${s.doc_number || '-'} vessel=${s.vessel_name || '-'}`);
    console.log(`    event history (${s.events.length}):`);
    s.events.forEach((e) => {
      const marker = e.advanced_current_state ? '→' : ' ';
      console.log(`      ${marker} ${e.state.padEnd(18)} ${new Date(e.event_at).toISOString()}  "${e.vendor_milestone_text || ''}"`);
    });
  });

  console.log('\nInvoices:');
  const invoices = await getJson('/invoices');
  invoices.forEach((i) => {
    const amt = i.amount_minor != null ? `${(i.amount_minor / 100).toFixed(2)} ${i.currency}` : '-';
    console.log(`  [${i.id}] natural_key=${i.natural_key}`);
    console.log(`    current_state=${i.current_state} @ ${i.current_state_at}`);
    console.log(`    doc_ref=${i.doc_ref} carrier=${i.carrier} amount=${amt}`);
    console.log(`    issued_at=${i.issued_at} paid_at=${i.paid_at}`);
    console.log(`    event history (${i.events.length}):`);
    i.events.forEach((e) => {
      const marker = e.advanced_current_state ? '→' : ' ';
      console.log(`      ${marker} ${e.state.padEnd(10)} ${new Date(e.event_at).toISOString()}  "${e.memo || ''}"`);
    });
  });

  // Quick correctness checks against the stress-test brief's expectations.
  // (In a real test suite these would be proper assertions; here they're
  // human-readable PASS/FAIL lines so the reviewer can see at a glance.)
  console.log('\nSanity checks:');
  const check = (label, ok, detail) =>
    console.log(`  ${ok ? 'PASS' : 'FAIL'} — ${label}${detail ? `  [${detail}]` : ''}`);

  // Idempotency at the body_hash layer.
  // 18 sample POSTs + 1 phase-2 dup POST = 19 attempts; 2A/2B and 5A/5C are
  // byte-identical pairs, and phase-2 is a third dup of samples[0]. So 19
  // attempts → 16 distinct rows.
  check(
    'Idempotency: 19 POSTs collapsed to 16 distinct raw_events',
    raws.length === 16,
    `actual=${raws.length}`,
  );

  // ─── Original brief ─────────────────────────────────────────────────
  // O1+O2: Maersk shipment out-of-order — IN_TRANSIT arrived before PICKED_UP.
  // Final state must be IN_TRANSIT (no regression); history has both events.
  const maersk = shipments.find((s) => (s.natural_key || '').includes('maeu240498712') || (s.natural_key || '').includes('msku7748112'));
  check(
    'O1+O2: Maersk shipment advanced to IN_TRANSIT despite out-of-order PICKED_UP arrival',
    maersk && maersk.current_state === 'IN_TRANSIT' && maersk.events.length === 2,
    maersk ? `state=${maersk.current_state} events=${maersk.events.length}` : 'shipment not found',
  );

  // O3+O4: GFP invoice out-of-order — PAID arrived before ISSUED.
  // Final state PAID; both events in history with their original timestamps.
  const gfp = invoices.find((i) => (i.natural_key || '').includes('gfp-inv-2026-q2-08821'));
  if (gfp) {
    const stateOk = gfp.current_state === 'PAID';
    const countOk = gfp.events.length === 2;
    const issuedOk = gfp.issued_at && new Date(gfp.issued_at).toISOString().startsWith('2026-04-15');
    const paidOk = gfp.paid_at && new Date(gfp.paid_at).toISOString().startsWith('2026-04-22');
    check(
      'O3+O4: GFP invoice ended PAID with both events; timestamps accurate',
      stateOk && countOk && issuedOk && paidOk,
      `state=${gfp.current_state} events=${gfp.events.length} issued=${gfp.issued_at} paid=${gfp.paid_at}`,
    );
  } else {
    check('O3+O4: GFP invoice ended PAID with both events', false, 'invoice not found');
  }

  // O5: ONE shipment — DELIVERED.
  const one = shipments.find((s) => (s.natural_key || '').includes('oneyjkthkg2604113') || (s.natural_key || '').includes('tllu2890442'));
  check(
    'O5: ONE shipment classified as DELIVERED',
    one && one.current_state === 'DELIVERED',
    one ? `state=${one.current_state}` : 'shipment not found',
  );

  // ─── Stress brief ───────────────────────────────────────────────────

  // §1A — LastMileNow → OUT_FOR_DELIVERY
  // natural_keys are canonicalized to lowercase before storage, so search
  // patterns must be lowercase too (see src/domain/identity.js).
  const lastMile = shipments.find((s) => (s.natural_key || '').includes('lmn-88492011'));
  check(
    '§1A: LastMileNow "final delivery vehicle" → OUT_FOR_DELIVERY',
    lastMile && lastMile.current_state === 'OUT_FOR_DELIVERY',
    lastMile ? `state=${lastMile.current_state}` : 'shipment not found',
  );

  // §1B — FinLogistics → VOIDED
  const finlog = invoices.find((i) => (i.natural_key || '').includes('inv-2026-99a'));
  check(
    '§1B: FinLogistics statement_annulled → VOIDED',
    finlog && finlog.current_state === 'VOIDED',
    finlog ? `state=${finlog.current_state}` : 'invoice not found',
  );

  // §1C — Stripe → REFUNDED
  const stripe = invoices.find((i) =>
    (i.natural_key || '').includes('stripe') ||
    (i.natural_key || '').includes('ch_3n9xx22l') ||
    (i.natural_key || '').includes('bkg-29910'),
  );
  check(
    '§1C: Stripe charge.refunded → REFUNDED',
    stripe && stripe.current_state === 'REFUNDED',
    stripe ? `state=${stripe.current_state}` : 'invoice not found',
  );

  // §2 — AirFreight: 2A and 2B were byte-identical, so the AirFreight
  // shipment should have exactly ONE history event despite two POSTs.
  const airFreight = shipments.find((s) => (s.natural_key || '').includes('125-88392011'));
  check(
    '§2: AirFreight dup-POST collapsed at body_hash; shipment has exactly 1 event',
    airFreight && airFreight.events.length === 1 && airFreight.current_state === 'IN_TRANSIT',
    airFreight ? `events=${airFreight.events.length} state=${airFreight.current_state}` : 'shipment not found',
  );

  // §3 — GroundForce: DELIVERED arrived first, PICKED_UP arrived after but
  // is chronologically earlier. Final state must remain DELIVERED; history
  // must contain BOTH events.
  const groundForce = shipments.find((s) => (s.natural_key || '').includes('gf-7738-992'));
  check(
    '§3: GroundForce out-of-order; state=DELIVERED, history has both events',
    groundForce && groundForce.current_state === 'DELIVERED' && groundForce.events.length === 2,
    groundForce ? `events=${groundForce.events.length} state=${groundForce.current_state}` : 'shipment not found',
  );

  // §4 — All noise payloads must classify as unclassified. The combined
  // fixture has THREE: O6 (marine advisory), §4A (Maersk maintenance), and
  // §4B (nginx 502).
  const unclassifiedCount = raws.filter((r) => r.classification === 'unclassified').length;
  check(
    '§4 (+O6): all three noise payloads → unclassified',
    unclassifiedCount === 3,
    `unclassified count=${unclassifiedCount}`,
  );

  // §5 — Combo: PAID arrived first, ISSUED arrived after, then PAID arrived
  // again as a byte-identical duplicate. Expected: PAID + ISSUED in history
  // (exactly 2 events; the dup is absorbed at body_hash), current_state PAID,
  // and BOTH timestamps (issued_at, paid_at) populated from payload data.
  const fp = invoices.find((i) => (i.natural_key || '').includes('fp-9902'));
  if (fp) {
    const stateOk = fp.current_state === 'PAID';
    const countOk = fp.events.length === 2;
    const issuedOk = fp.issued_at && new Date(fp.issued_at).toISOString().startsWith('2026-05-01');
    const paidOk = fp.paid_at && new Date(fp.paid_at).toISOString().startsWith('2026-05-20');
    check(
      '§5: FP-9902 combo (out-of-order + dup) → PAID with 2 events, accurate timestamps',
      stateOk && countOk && issuedOk && paidOk,
      `state=${fp.current_state} events=${fp.events.length} issued=${fp.issued_at} paid=${fp.paid_at}`,
    );
  } else {
    check('§5: FP-9902 combo (out-of-order + dup)', false, 'invoice not found');
  }

  process.exit(0);
})().catch((err) => {
  console.error('replay failed:', err);
  process.exit(1);
});
