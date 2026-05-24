'use strict';

/**
 * Canonical state ranks.
 *
 * The materialized current_state advances only on STRICT rank increase. This
 * is what makes out-of-order delivery safe: a delayed PICKED_UP arriving
 * after IN_TRANSIT lands in history but does not regress the current state.
 *
 * Notes on the invoice lifecycle:
 *
 * - PAID and VOIDED share rank 20 — they are mutually-exclusive terminal-ish
 *   states reached from ISSUED. If both arrive (rare; would indicate a vendor
 *   data quality issue) we keep whichever landed first as current_state and
 *   record the second in invoice_events for review.
 *
 * - REFUNDED at rank 30 is reachable only after PAID in normal flow. We do
 *   not enforce the prior-PAID constraint here — vendors sometimes emit only
 *   terminal events. The history is the source of truth; the materialized
 *   current_state is a convenience.
 */
const SHIPMENT_RANK = {
  PICKED_UP: 10,
  IN_TRANSIT: 20,
  OUT_FOR_DELIVERY: 30,
  DELIVERED: 40,
};

const INVOICE_RANK = {
  ISSUED: 10,
  PAID: 20,
  VOIDED: 20,
  REFUNDED: 30,
};

module.exports = { SHIPMENT_RANK, INVOICE_RANK };
