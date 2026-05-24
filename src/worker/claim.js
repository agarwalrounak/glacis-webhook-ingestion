'use strict';

const { sequelize, RawEvent } = require('../models');
const config = require('../config');
const logger = require('../logger');

/**
 * Claim up to `batchSize` events for this worker.
 *
 * Two-phase: the SELECT ... FOR UPDATE SKIP LOCKED gives us an exclusive
 * but short row lock; the UPDATE flips status to 'processing' and extends
 * the lease via locked_until. We commit before doing any LLM work so the
 * row locks are released — the lease (locked_until + status='processing')
 * is what protects the claim during the long LLM call.
 *
 * Two sources of claimable work:
 *
 *   - status='pending' with expired lease: brand-new events, or events
 *     that the worker pushed back to 'pending' for backoff after a
 *     transient failure.
 *
 *   - status='processing' with expired lease: a worker died (crashed,
 *     OOMed, container killed) mid-LLM-call. Since the settle transaction
 *     is atomic, either the entity write committed and status flipped to
 *     'normalized' (in which case we don't see it here), or nothing was
 *     written and the row is safe to re-process. The L2 idempotency
 *     constraint UNIQUE(entity_id, raw_event_id) covers the corner case
 *     where the prior LLM call succeeded and a partial domain write
 *     somehow leaked — duplicate inserts at the entity layer are no-ops.
 *
 * Returns an array of RawEvent instances (re-fetched after the claim).
 */
async function claimBatch(workerId) {
  const leaseSeconds = config.worker.leaseSeconds;
  const batchSize = config.worker.batchSize;

  // Wrap the claim in a transaction so the row locks released atomically
  // with the status flip.
  const result = await sequelize.transaction(async (tx) => {
    const [candidates] = await sequelize.query(
      `SELECT id, status
         FROM raw_events
        WHERE status IN ('pending', 'processing')
          AND locked_until <= NOW(3)
        ORDER BY id
        LIMIT :batchSize
        FOR UPDATE SKIP LOCKED`,
      {
        replacements: { batchSize },
        transaction: tx,
      }
    );

    if (candidates.length === 0) return { ids: [], recovered: [] };

    const claimedIds = candidates.map((r) => r.id);
    // Surface lease-expiry reclaims as a separate signal — repeated
    // recoveries point at a crashing worker, a hanging LLM, or a lease
    // that's set too short for actual processing latency.
    const recovered = candidates.filter((r) => r.status === 'processing').map((r) => r.id);

    await sequelize.query(
      `UPDATE raw_events
          SET status = 'processing',
              locked_until = DATE_ADD(NOW(3), INTERVAL :lease SECOND),
              attempts = attempts + 1,
              worker_id = :workerId,
              updated_at = NOW(3)
        WHERE id IN (:ids)`,
      {
        replacements: { lease: leaseSeconds, workerId, ids: claimedIds },
        transaction: tx,
      }
    );

    return { ids: claimedIds, recovered };
  });

  const { ids, recovered } = result;
  if (recovered.length > 0) {
    logger.warn({ workerId, recovered_ids: recovered, count: recovered.length },
      'recovered events with expired lease (prior worker likely crashed or stalled)');
  }

  if (ids.length === 0) return [];

  // Re-fetch full rows. We could SELECT * in the claim query, but separating
  // the read from the lock keeps the locked transaction small and short.
  const rows = await RawEvent.findAll({
    where: { id: ids },
    order: [['id', 'ASC']],
  });

  logger.debug({ workerId, count: rows.length, ids }, 'claimed batch');
  return rows;
}

module.exports = { claimBatch };
