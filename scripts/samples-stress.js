'use strict';

// Combined fixture: the original 6 payloads from the assessment brief PLUS
// the 12 stress-test payloads. Exercises every environmental reality the
// system must handle: vocabulary normalization, duplicate detection,
// out-of-order arrival, unclassified noise, and a combined stress sequence
// on one entity.
//
// The replay harness fires these in PARALLEL — which is strictly harder than
// the brief's sequential ordering. The state machine must still converge to
// the same canonical outcome regardless of arrival order.
//
// Two pairs of entries below are byte-identical duplicates by design (2A/2B
// and 5A/5C). The API's body_hash UNIQUE constraint absorbs the second POST
// in each pair without invoking the LLM, so 18 sample entries collapse to 16
// distinct raw_events rows.

module.exports = [
  // ─────────────────────────────────────────────────────────────────────
  // ORIGINAL BRIEF — 6 payloads
  // Maersk ocean (out-of-order pair), GlobalFreightPay (out-of-order pair),
  // ONE delivered, Marine advisory.
  // ─────────────────────────────────────────────────────────────────────
  {
    label: 'O1) Maersk vessel departed (IN_TRANSIT) — arrives before PICKED_UP',
    body: {
      carrier_scac: 'MAEU',
      event_msg_id: 'MAEU-EVT-2026-04-22-0001',
      transport_doc: { type: 'MBL', number: 'MAEU240498712' },
      container: 'MSKU7748112',
      vessel: { name: 'MAERSK GUATEMALA', imo: '9778120', voyage: '424W' },
      milestone: 'Loaded onboard and sailed',
      milestone_at: '2026-04-21T22:47:00+08:00',
      port: { code: 'CNSHA', name: 'Shanghai' },
    },
  },
  {
    label: 'O2) Maersk gate-in at origin (PICKED_UP) — out-of-order precursor',
    body: {
      carrier_scac: 'MAEU',
      event_msg_id: 'MAEU-EVT-2026-04-19-0042',
      transport_doc: { type: 'MBL', number: 'MAEU240498712' },
      container: 'MSKU7748112',
      milestone: 'Empty container released to shipper; full container received at origin terminal',
      milestone_at: '2026-04-19T11:15:00+08:00',
      port: { code: 'CNSHA', name: 'Shanghai' },
      shipper_ref: 'ACME-IND-PO-2026-9921',
    },
  },
  {
    label: 'O3) GlobalFreightPay settled (PAID) — arrives before ISSUED',
    body: {
      source: 'globalfreightpay.api',
      channel: 'carrier_billing',
      doc_ref: 'GFP-INV-2026-Q2-08821',
      carrier: 'Hapag-Lloyd AG',
      linked_bl: 'HLCU2604OCEAN221',
      transaction: {
        kind: 'settled in full',
        settled_at: '2026-04-22 18:47:11+02:00',
        amount: 'EUR 24.350,75',
        remitter: 'ACME Logistics GmbH',
        memo: 'Ocean freight + THC + BAF, Shanghai → Hamburg, container HLBU4490221',
      },
    },
  },
  {
    label: 'O4) GlobalFreightPay raised (ISSUED) — out-of-order precursor',
    body: {
      source: 'globalfreightpay.api',
      channel: 'carrier_billing',
      doc_ref: 'GFP-INV-2026-Q2-08821',
      carrier: 'Hapag-Lloyd AG',
      linked_bl: 'HLCU2604OCEAN221',
      transaction: {
        kind: 'freight invoice raised',
        issued_at: '2026-04-15T09:00:00+02:00',
        amount: 'EUR 24.350,75',
        due_at: '2026-05-15T00:00:00+02:00',
        line_items: [
          { desc: 'Ocean freight Shanghai → Hamburg', amt: 'EUR 21.000,00' },
          { desc: 'Terminal handling charges (THC)', amt: 'EUR 1.850,75' },
          { desc: 'Bunker adjustment factor (BAF)', amt: 'EUR 1.500,00' },
        ],
      },
    },
  },
  {
    label: 'O5) Ocean Network Express released to consignee (DELIVERED)',
    body: {
      carrier: 'Ocean Network Express',
      carrier_scac: 'ONEY',
      event_id: 'ONE-2026-04-28-114',
      house_bl: 'ONEYJKTHKG2604113',
      master_bl: 'ONEYMBLHKG260499',
      container_no: 'TLLU2890442',
      consignee: 'ACME Manufacturing PT.',
      milestone_text: 'Cargo released to consignee at consignee facility — empty container returned to depot',
      milestone_local_time: '28/04/2026 09:42 WIB',
      port_of_discharge: 'IDJKT',
      delivery_order_no: 'DO-IDJKT-26044881',
    },
  },
  {
    label: 'O6) Marine traffic advisory (UNCLASSIFIED)',
    body: {
      issuer: 'marine-traffic-advisory',
      advisory_id: 'MTA-2026-04-26-EU-007',
      severity: 'AMBER',
      issued_at: '2026-04-26T06:00:00Z',
      subject: 'Ongoing congestion at Port of Antwerp-Bruges',
      body: 'Vessel waiting times at Antwerp-Bruges berths have increased to 4-6 days due to labour action by terminal operators. Carriers are advised to consider rerouting via Rotterdam or Zeebrugge. ETAs across all services calling at Antwerp-Bruges should be assumed delayed until further notice.',
      affected_services: ['AE7', 'FAL3', 'Mediterranean Bridge'],
      expires_at: '2026-05-03T00:00:00Z',
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // STRESS BRIEF §1 — Vocabulary normalization & state mapping
  // ─────────────────────────────────────────────────────────────────────
  {
    label: '1A) LastMileNow — final-vehicle scan (expect OUT_FOR_DELIVERY)',
    body: {
      system: 'LastMileNow API',
      tracking_reference: 'LMN-88492011',
      update: {
        status_code: 'LMD-04',
        description: 'Package loaded onto the final delivery vehicle. Driver ETA: 14:00 - 16:00.',
        location: 'Local Hub - Brooklyn, NY',
      },
      timestamp_utc: '2026-05-24T12:15:00Z',
    },
  },
  {
    label: '1B) FinLogistics — statement_annulled (expect invoice VOIDED)',
    body: {
      vendor_id: 'FINLOG',
      document_type: 'Billing Statement',
      document_id: 'INV-2026-99A',
      event: 'statement_annulled',
      details: 'Invoice generated in error. Duplicate of INV-2026-99B. No payment required.',
      effective_date: '2026-05-24T09:00:00Z',
    },
  },
  {
    label: '1C) Stripe — charge.refunded (expect invoice REFUNDED)',
    body: {
      id: 'evt_3N9xx22L',
      object: 'event',
      type: 'charge.refunded',
      created: 1716551000,
      data: {
        object: {
          id: 'ch_3N9xx22L',
          amount: 45000,
          amount_refunded: 45000,
          currency: 'usd',
          metadata: {
            freight_booking_ref: 'BKG-29910',
          },
        },
      },
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // STRESS BRIEF §2 — Idempotency: exact-byte duplicate
  // ─────────────────────────────────────────────────────────────────────
  {
    label: '2A) AirFreight Intl — departed transit (expect shipment IN_TRANSIT)',
    body: {
      carrier: 'AirFreight Intl',
      awb: '125-88392011',
      milestone: 'Departed transit facility',
      airport: 'LHR',
      event_time: '2026-05-24T08:30:00Z',
      webhook_id: 'wh_evt_881923',
    },
  },
  {
    label: '2B) AirFreight Intl — EXACT DUP of 2A (must be absorbed at body_hash layer)',
    body: {
      carrier: 'AirFreight Intl',
      awb: '125-88392011',
      milestone: 'Departed transit facility',
      airport: 'LHR',
      event_time: '2026-05-24T08:30:00Z',
      webhook_id: 'wh_evt_881923',
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // STRESS BRIEF §3 — Out-of-order arrival
  // ─────────────────────────────────────────────────────────────────────
  {
    label: '3A) GroundForce — handed to recipient (DELIVERED, arrives first)',
    body: {
      logistics_provider: 'GroundForce',
      parcel_id: 'GF-7738-992',
      scan_type: 'Handed to recipient',
      scan_time: '2026-05-25T14:45:00Z',
      signature_obtained: true,
    },
  },
  {
    label: '3B) GroundForce — collected from sender (PICKED_UP, arrives after but chronologically earlier)',
    body: {
      logistics_provider: 'GroundForce',
      parcel_id: 'GF-7738-992',
      scan_type: 'Collected from sender loading dock',
      scan_time: '2026-05-23T10:15:00Z',
      driver_id: 'DRV-991',
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // STRESS BRIEF §4 — Unclassified noise
  // ─────────────────────────────────────────────────────────────────────
  {
    label: '4A) Maersk Dev Platform maintenance alert (expect UNCLASSIFIED)',
    body: {
      source: 'Maersk Developer Platform',
      event_type: 'system_maintenance_scheduled',
      affected_apis: ['Track and Trace API', 'Booking API'],
      start_time: '2026-06-01T00:00:00Z',
      end_time: '2026-06-01T04:00:00Z',
      message: 'The API will experience intermittent downtime.',
    },
  },
  {
    label: '4B) nginx 502 gateway error (expect UNCLASSIFIED)',
    body: {
      error_code: 502,
      gateway: 'nginx',
      raw_dump: 'upstream prematurely closed connection while reading response header from upstream',
    },
  },

  // ─────────────────────────────────────────────────────────────────────
  // STRESS BRIEF §5 — Combo: single invoice, out-of-order + duplicate
  //
  // Expected: invoice FP-9902 ends PAID, history has exactly 2 events
  // (ISSUED at 2026-05-01, PAID at 2026-05-20), despite 3 POSTs hitting
  // the ingest path.
  // ─────────────────────────────────────────────────────────────────────
  {
    label: '5A) FreightPay FP-9902 — funds cleared (PAID, arrives 1st)',
    body: {
      system: 'FreightPay',
      ref: 'FP-9902',
      status: 'Funds cleared',
      date: '2026-05-20T10:00:00Z',
    },
  },
  {
    label: '5B) FreightPay FP-9902 — invoice generated (ISSUED, arrives 2nd, chronologically earlier)',
    body: {
      system: 'FreightPay',
      ref: 'FP-9902',
      status: 'Invoice generated for Ocean Freight',
      date: '2026-05-01T10:00:00Z',
    },
  },
  {
    label: '5C) FreightPay FP-9902 — EXACT DUP of 5A (must be absorbed at body_hash layer)',
    body: {
      system: 'FreightPay',
      ref: 'FP-9902',
      status: 'Funds cleared',
      date: '2026-05-20T10:00:00Z',
    },
  },
];
