'use strict';

/**
 * BACKUP of the pre-stress-test replay harness.
 *
 * This is the original version that consumed the 6 sample payloads from
 * ./samples.js (the original brief, not the stress-test brief). Kept here
 * so you can switch back to the simpler fixture if needed:
 *
 *   node scripts/replay-samples-original.js
 *
 * The live harness is scripts/replay-samples.js — it consumes ./samples-stress.
 *
 * End-to-end replay harness.
 *
 * Sends the 6 sample payloads to the running API, then polls until the
 * worker drains the queue, then prints the resulting shipments/invoices
 * state. The output is the "does this thing work?" evidence.
 *
 * Also exercises:
 *   - duplicate detection (POSTs payload #1 twice)
 *   - concurrent POSTs (all 6 in parallel — vendors don't queue)
 *
 * Usage:
 *   API_URL=http://localhost:3000 node scripts/replay-samples-original.js
 */

const samples = require('./samples');

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

  // Phase 1: POST all 6 in parallel — vendors don't politely serialize.
  console.log('Phase 1: POST 6 sample payloads concurrently');
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
    console.log(`    container=${s.container_no} doc=${s.doc_type}/${s.doc_number} vessel=${s.vessel_name || '-'}`);
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

  // Quick correctness checks (would be proper assertions in a real test suite).
  console.log('\nSanity checks:');
  const maersk = shipments.find((s) => (s.natural_key || '').includes('MAEU240498712'));
  if (maersk) {
    const ok = maersk.current_state === 'IN_TRANSIT' && maersk.events.length === 2;
    console.log(`  Maersk shipment advanced to IN_TRANSIT despite out-of-order: ${ok ? 'PASS' : 'FAIL'}`);
  }
  const gfp = invoices.find((i) => (i.natural_key || '').includes('GFP-INV-2026-Q2-08821'));
  if (gfp) {
    const ok = gfp.current_state === 'PAID' && gfp.events.length === 2;
    console.log(`  GFP invoice ended PAID with both events recorded: ${ok ? 'PASS' : 'FAIL'}`);
  }
  // The advisory is the only payload that should classify as unclassified.
  // Check by classification rather than introspecting payload — the JSON
  // column's runtime shape (parsed object vs string) is driver-dependent.
  const advisoryUnclassified = raws.some((r) => r.classification === 'unclassified');
  console.log(`  Advisory routed to unclassified: ${advisoryUnclassified ? 'PASS' : 'FAIL'}`);

  process.exit(0);
})().catch((err) => {
  console.error('replay failed:', err);
  process.exit(1);
});
