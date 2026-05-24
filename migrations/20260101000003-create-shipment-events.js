'use strict';

/**
 * shipment_events: append-only history. One row per webhook accepted for
 * this shipment, including events that arrived out-of-order and did not
 * advance current_state.
 *
 * UNIQUE(shipment_id, raw_event_id) is the second idempotency layer:
 * re-processing the same raw_event (e.g. worker crashed after the LLM call
 * but before commit) cannot create duplicate history rows.
 */
module.exports = {
  async up(qi, Sequelize) {
    await qi.createTable('shipment_events', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      shipment_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      raw_event_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },

      state: {
        type: Sequelize.ENUM('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'),
        allowNull: false,
      },
      state_rank: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false },
      event_at: { type: Sequelize.DATE(3), allowNull: false },

      vendor: { type: Sequelize.STRING(100), allowNull: true },
      vendor_milestone_text: { type: Sequelize.STRING(500), allowNull: true },
      port_code: { type: Sequelize.STRING(10), allowNull: true },
      attributes: { type: Sequelize.JSON, allowNull: true },

      advanced_current_state: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },

      created_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });

    await qi.addConstraint('shipment_events', {
      fields: ['shipment_id', 'raw_event_id'],
      type: 'unique',
      name: 'uq_shipment_events_shipment_raw',
    });
    await qi.addIndex('shipment_events', {
      fields: ['shipment_id', 'event_at'],
      name: 'idx_shipment_events_timeline',
    });
    await qi.addConstraint('shipment_events', {
      fields: ['shipment_id'],
      type: 'foreign key',
      name: 'fk_shipment_events_shipment',
      references: { table: 'shipments', field: 'id' },
      onDelete: 'CASCADE',
    });
    await qi.addConstraint('shipment_events', {
      fields: ['raw_event_id'],
      type: 'foreign key',
      name: 'fk_shipment_events_raw',
      references: { table: 'raw_events', field: 'id' },
      onDelete: 'RESTRICT',
    });
  },

  async down(qi) {
    await qi.dropTable('shipment_events');
  },
};
