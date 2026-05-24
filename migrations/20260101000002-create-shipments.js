'use strict';

/**
 * shipments: materialized current state per physical parcel.
 *
 * natural_key is the cross-vendor identity string the LLM extracts (e.g.
 * "MAEU:MBL:MAEU240498712:MSKU7748112"). It is UNIQUE so the upsert is
 * deterministic. We let the LLM decide the composition because vendors
 * disagree on which identifiers are authoritative.
 *
 * current_state advances only forward by state_rank. Older events still
 * land in shipment_events for history but never regress the materialized
 * state — this is how we tolerate out-of-order delivery.
 */
module.exports = {
  async up(qi, Sequelize) {
    await qi.createTable('shipments', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      natural_key: { type: Sequelize.STRING(255), allowNull: false },

      carrier_scac: { type: Sequelize.STRING(10), allowNull: true },
      carrier_name: { type: Sequelize.STRING(200), allowNull: true },
      doc_number: { type: Sequelize.STRING(100), allowNull: true },
      container_no: { type: Sequelize.STRING(50), allowNull: true },

      current_state: {
        type: Sequelize.ENUM('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'),
        allowNull: true,
      },
      current_state_rank: { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
      current_state_at: { type: Sequelize.DATE(3), allowNull: true },

      vessel_name: { type: Sequelize.STRING(200), allowNull: true },
      vessel_imo: { type: Sequelize.STRING(20), allowNull: true },
      voyage: { type: Sequelize.STRING(50), allowNull: true },
      last_port_code: { type: Sequelize.STRING(10), allowNull: true },
      last_port_name: { type: Sequelize.STRING(200), allowNull: true },
      consignee: { type: Sequelize.STRING(200), allowNull: true },
      shipper_ref: { type: Sequelize.STRING(100), allowNull: true },

      attributes: { type: Sequelize.JSON, allowNull: true },

      created_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
      updated_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });

    await qi.addIndex('shipments', {
      fields: ['natural_key'],
      unique: true,
      name: 'uq_shipments_natural_key',
    });
    await qi.addIndex('shipments', {
      fields: ['doc_number'],
      name: 'idx_shipments_doc_number',
    });
    await qi.addIndex('shipments', {
      fields: ['container_no'],
      name: 'idx_shipments_container_no',
    });
  },

  async down(qi) {
    await qi.dropTable('shipments');
  },
};
