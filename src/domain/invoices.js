'use strict';

const { Invoice, InvoiceEvent } = require('../models');
const { INVOICE_RANK } = require('./states');
const { canonicalizeNaturalKey } = require('./identity');
const logger = require('../logger');

/**
 * Apply one normalized invoice event. Same shape and contract as
 * applyShipmentEvent — see that file for the rationale on locking,
 * upsert race handling, and idempotency.
 *
 * Invoice-specific behavior:
 *   - amount_minor / currency are persisted on the invoice row from the
 *     FIRST event that supplies them; subsequent events can override only
 *     if the value is currently null.
 *   - state-specific timestamp columns (issued_at, paid_at, voided_at,
 *     refunded_at) are set only on advancement to that state, preserving
 *     the original time even when later events arrive out-of-order.
 */
async function applyInvoiceEvent({ data, rawEventId, tx }) {
  const eventAt = new Date(data.event_at);
  const rank = INVOICE_RANK[data.state];
  if (!rank) throw new Error(`unknown invoice state: ${data.state}`);

  // See domain/shipments.js for the rationale on canonicalization.
  const naturalKey = canonicalizeNaturalKey(data.natural_key);

  let invoice = await Invoice.findOne({
    where: { natural_key: naturalKey },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });

  if (!invoice) {
    try {
      invoice = await Invoice.create({
        natural_key: naturalKey,
        source: data.source || null,
        doc_ref: data.doc_ref || null,
        carrier: data.carrier || null,
        linked_bl: data.linked_bl || null,
        remitter: data.remitter || null,
        amount_minor: data.amount_minor ?? null,
        currency: data.currency || null,
      }, { transaction: tx });
    } catch (err) {
      if (err.name === 'SequelizeUniqueConstraintError') {
        invoice = await Invoice.findOne({
          where: { natural_key: naturalKey },
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
      } else {
        throw err;
      }
    }
  }

  const currentRank = invoice.current_state ? INVOICE_RANK[invoice.current_state] : 0;
  const willAdvance = rank > currentRank;

  try {
    await InvoiceEvent.create({
      invoice_id: invoice.id,
      raw_event_id: rawEventId,
      state: data.state,
      event_at: eventAt,
      vendor: data.vendor || null,
      memo: data.memo || null,
      amount_minor: data.amount_minor ?? null,
      currency: data.currency || null,
      advanced_current_state: willAdvance,
    }, { transaction: tx });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      logger.info({ invoiceId: invoice.id, rawEventId }, 'invoice event already applied; idempotent skip');
      return { invoiceId: invoice.id, advanced: false, duplicate: true };
    }
    throw err;
  }

  // Per-state timestamp columns: set once, never overwrite. This survives
  // out-of-order arrival of the same state from a duplicate or retry.
  const stamps = {};
  if (data.state === 'ISSUED' && !invoice.issued_at) stamps.issued_at = eventAt;
  if (data.state === 'PAID' && !invoice.paid_at) stamps.paid_at = eventAt;
  if (data.state === 'VOIDED' && !invoice.voided_at) stamps.voided_at = eventAt;
  if (data.state === 'REFUNDED' && !invoice.refunded_at) stamps.refunded_at = eventAt;

  // Fill in fields that may have been unknown at first-create. Never clobber
  // existing values with nulls.
  const fillIn = {};
  if (data.source && !invoice.source) fillIn.source = data.source;
  if (data.doc_ref && !invoice.doc_ref) fillIn.doc_ref = data.doc_ref;
  if (data.carrier && !invoice.carrier) fillIn.carrier = data.carrier;
  if (data.linked_bl && !invoice.linked_bl) fillIn.linked_bl = data.linked_bl;
  if (data.remitter && !invoice.remitter) fillIn.remitter = data.remitter;
  if (data.amount_minor != null && invoice.amount_minor == null) fillIn.amount_minor = data.amount_minor;
  if (data.currency && !invoice.currency) fillIn.currency = data.currency;
  if (data.due_at && !invoice.due_at) fillIn.due_at = new Date(data.due_at);

  const patch = { ...stamps, ...fillIn };
  if (willAdvance) {
    patch.current_state = data.state;
    patch.current_state_at = eventAt;
  } else {
    logger.info(
      { invoiceId: invoice.id, incoming: data.state, current: invoice.current_state },
      'invoice event recorded but did not advance current_state'
    );
  }

  if (Object.keys(patch).length > 0) {
    await invoice.update(patch, { transaction: tx });
  }

  return { invoiceId: invoice.id, advanced: willAdvance, duplicate: false };
}

module.exports = { applyInvoiceEvent };
