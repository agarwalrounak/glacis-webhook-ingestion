'use strict';

const { sequelize, RawEvent } = require('../models');
const { normalize } = require('../llm/client');
const { applyShipmentEvent } = require('../domain/shipments');
const { applyInvoiceEvent } = require('../domain/invoices');
const { backoffSeconds } = require('./backoff');
const config = require('../config');
const logger = require('../logger');

/**
 * Process a single claimed raw_event.
 *
 * The high-level shape is:
 *   1. Call the LLM (long, outside any DB transaction).
 *   2. If successful, open a short transaction that BOTH writes the
 *      normalized entity AND flips raw_events.status atomically. This is
 *      the key property MySQL-as-queue gives us that a separate broker
 *      cannot without 2PC: we can't end up with normalized data missing
 *      its status flip, or vice versa.
 *   3. On transient failure (LLM network error), return to 'pending' with
 *      a backoff via locked_until.
 *   4. On non-transient failure (schema violation, bad tool invocation),
 *      route to 'needs_review' for human inspection — these are usually
 *      model bugs and retrying won't help.
 *   5. If attempts exceeds the configured max, mark 'dead' (DLQ).
 */
async function processOne(rawEvent, log = logger) {
  const child = log.child({ raw_event_id: rawEvent.id, attempts: rawEvent.attempts });
  child.info('processing');

  const llmResult = await normalize(rawEvent.payload);

  // --- Failure paths -----------------------------------------------------
  if (!llmResult.ok) {
    // Schema or invocation failure: the model returned but its output is
    // unusable. Don't burn retries on this — surface to humans.
    if (llmResult.kind === 'schema' || llmResult.kind === 'invocation') {
      await rawEvent.update({
        status: 'needs_review',
        last_error: `${llmResult.kind}: ${llmResult.error}`,
        llm_response: llmResult.rawInput || null,
        llm_latency_ms: llmResult.latencyMs,
        processed_at: new Date(),
      });
      child.warn({ kind: llmResult.kind, error: llmResult.error }, 'routed to needs_review');
      return { outcome: 'needs_review' };
    }

    // Network / transient: back off and retry, unless we've exhausted attempts.
    if (rawEvent.attempts >= config.worker.maxAttempts) {
      await rawEvent.update({
        status: 'dead',
        last_error: `network: ${llmResult.error}`,
        llm_latency_ms: llmResult.latencyMs,
        processed_at: new Date(),
      });
      child.error({ error: llmResult.error }, 'dead-lettered after max attempts');
      return { outcome: 'dead' };
    }

    const delaySec = backoffSeconds(rawEvent.attempts);
    await sequelize.query(
      `UPDATE raw_events
          SET status = 'pending',
              locked_until = DATE_ADD(NOW(3), INTERVAL :delay SECOND),
              last_error = :err,
              llm_latency_ms = :latency,
              updated_at = NOW(3)
        WHERE id = :id`,
      {
        replacements: {
          delay: delaySec,
          err: `network: ${llmResult.error}`.slice(0, 1000),
          latency: llmResult.latencyMs,
          id: rawEvent.id,
        },
      }
    );
    child.warn({ error: llmResult.error, delaySec }, 'transient failure; backing off');
    return { outcome: 'retry' };
  }

  // --- Success path ------------------------------------------------------
  const { result, latencyMs, model } = llmResult;

  if (result.type === 'unclassified') {
    await rawEvent.update({
      status: 'unclassified',
      classification: 'unclassified',
      llm_model: model,
      llm_latency_ms: latencyMs,
      llm_response: result,
      processed_at: new Date(),
      last_error: null,
    });
    child.info({ confidence: result.confidence }, 'unclassified');
    return { outcome: 'unclassified' };
  }

  // Low-confidence shipment/invoice: persist the normalization for audit but
  // do NOT write into the canonical tables. Humans review and either approve
  // (re-process at a higher confidence) or correct.
  if (result.confidence === 'low') {
    await rawEvent.update({
      status: 'needs_review',
      classification: result.type,
      llm_model: model,
      llm_latency_ms: latencyMs,
      llm_response: result,
      last_error: 'low_confidence',
      processed_at: new Date(),
    });
    child.warn({ type: result.type }, 'low-confidence classification routed to needs_review');
    return { outcome: 'needs_review' };
  }

  // The critical transaction: domain write + status flip together.
  try {
    const outcome = await sequelize.transaction(async (tx) => {
      let entityType, entityId;
      if (result.type === 'shipment') {
        const r = await applyShipmentEvent({ data: result.shipment, rawEventId: rawEvent.id, tx });
        entityType = 'shipment';
        entityId = r.shipmentId;
      } else if (result.type === 'invoice') {
        const r = await applyInvoiceEvent({ data: result.invoice, rawEventId: rawEvent.id, tx });
        entityType = 'invoice';
        entityId = r.invoiceId;
      }

      await RawEvent.update({
        status: 'normalized',
        classification: result.type,
        entity_type: entityType,
        entity_id: entityId,
        llm_model: model,
        llm_latency_ms: latencyMs,
        llm_response: result,
        processed_at: new Date(),
        last_error: null,
      }, {
        where: { id: rawEvent.id },
        transaction: tx,
      });

      return { entityType, entityId };
    });

    child.info(outcome, 'normalized');
    return { outcome: 'normalized', ...outcome };
  } catch (err) {
    // Database failure during the settle phase. The transaction rolled back,
    // so raw_events.status is still 'processing' and locked_until is still
    // ticking. Reset to pending with a short backoff — the lease would have
    // freed it eventually, but explicit is cleaner.
    child.error({ err: err.message }, 'settle transaction failed');
    if (rawEvent.attempts >= config.worker.maxAttempts) {
      await rawEvent.update({
        status: 'dead',
        last_error: `settle: ${err.message}`.slice(0, 1000),
        llm_response: result,
        llm_model: model,
        llm_latency_ms: latencyMs,
        processed_at: new Date(),
      });
      return { outcome: 'dead' };
    }
    await sequelize.query(
      `UPDATE raw_events
          SET status = 'pending',
              locked_until = DATE_ADD(NOW(3), INTERVAL :delay SECOND),
              last_error = :err,
              llm_response = :resp,
              llm_model = :model,
              llm_latency_ms = :latency,
              updated_at = NOW(3)
        WHERE id = :id`,
      {
        replacements: {
          delay: backoffSeconds(rawEvent.attempts),
          err: `settle: ${err.message}`.slice(0, 1000),
          resp: JSON.stringify(result),
          model,
          latency: latencyMs,
          id: rawEvent.id,
        },
      }
    );
    return { outcome: 'retry' };
  }
}

module.exports = { processOne };
