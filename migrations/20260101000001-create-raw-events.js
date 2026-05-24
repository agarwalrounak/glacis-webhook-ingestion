'use strict';

/**
 * raw_events: the inbox AND the queue.
 *
 * - body_hash is the dedupe key (SHA-256 of normalized body bytes). UNIQUE
 *   makes duplicate POSTs a cheap no-op at the storage layer.
 * - status + locked_until + id is the claim index. The worker query is
 *     SELECT ... WHERE status='pending' AND locked_until < NOW()
 *     ORDER BY id LIMIT N FOR UPDATE SKIP LOCKED
 *   so the leading columns of this index must match that predicate to avoid
 *   over-locking rows we never intend to claim.
 * - llm_response stores the raw tool_use input so we can audit, replay,
 *   and debug without re-paying LLM cost.
 */
module.exports = {
  async up(qi, Sequelize) {
    await qi.createTable('raw_events', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      body_hash: { type: Sequelize.CHAR(64), allowNull: false },
      vendor_hint: { type: Sequelize.STRING(100), allowNull: true },
      payload: { type: Sequelize.JSON, allowNull: false },
      headers: { type: Sequelize.JSON, allowNull: true },
      received_at: { type: Sequelize.DATE(3), allowNull: false },

      status: {
        type: Sequelize.ENUM(
          'pending',         // awaiting worker
          'processing',      // claimed by a worker (lease active)
          'normalized',      // successfully classified + persisted
          'unclassified',    // LLM said it doesn't belong to shipment/invoice
          'needs_review',    // schema-invalid or low-confidence LLM output
          'dead'             // exceeded max attempts; manual intervention
        ),
        allowNull: false,
        defaultValue: 'pending',
      },
      attempts: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      locked_until: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
      worker_id: { type: Sequelize.STRING(100), allowNull: true },
      last_error: { type: Sequelize.TEXT, allowNull: true },

      classification: {
        type: Sequelize.ENUM('shipment', 'invoice', 'unclassified'),
        allowNull: true,
      },
      entity_type: { type: Sequelize.ENUM('shipment', 'invoice'), allowNull: true },
      entity_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: true },

      llm_model: { type: Sequelize.STRING(100), allowNull: true },
      llm_latency_ms: { type: Sequelize.INTEGER.UNSIGNED, allowNull: true },
      llm_response: { type: Sequelize.JSON, allowNull: true },

      processed_at: { type: Sequelize.DATE(3), allowNull: true },
      created_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
      updated_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });

    await qi.addIndex('raw_events', {
      fields: ['body_hash'],
      unique: true,
      name: 'uq_raw_events_body_hash',
    });
    // The claim index. Order matters: equality on status, range on
    // locked_until, then id for stable ORDER BY.
    await qi.addIndex('raw_events', {
      fields: ['status', 'locked_until', 'id'],
      name: 'idx_raw_events_claim',
    });
    await qi.addIndex('raw_events', {
      fields: ['received_at'],
      name: 'idx_raw_events_received_at',
    });
    await qi.addIndex('raw_events', {
      fields: ['entity_type', 'entity_id'],
      name: 'idx_raw_events_entity',
    });
  },

  async down(qi) {
    await qi.dropTable('raw_events');
  },
};
