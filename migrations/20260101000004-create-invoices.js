'use strict';

/**
 * invoices: materialized current state per financial document.
 *
 * Unlike shipments, the lifecycle branches: ISSUED can terminate at either
 * PAID or VOIDED, and PAID can subsequently move to REFUNDED. Rank alone
 * is insufficient — see domain/invoices.js for the allowed-transition map.
 *
 * amount_minor stores the monetary amount in the smallest unit (e.g.
 * cents) to avoid binary float drift on currency math.
 */
module.exports = {
  async up(qi, Sequelize) {
    await qi.createTable('invoices', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      natural_key: { type: Sequelize.STRING(255), allowNull: false },

      source: { type: Sequelize.STRING(100), allowNull: true },
      doc_ref: { type: Sequelize.STRING(100), allowNull: true },
      carrier: { type: Sequelize.STRING(200), allowNull: true },
      linked_bl: { type: Sequelize.STRING(100), allowNull: true },
      remitter: { type: Sequelize.STRING(200), allowNull: true },

      current_state: {
        type: Sequelize.ENUM('ISSUED', 'PAID', 'VOIDED', 'REFUNDED'),
        allowNull: true,
      },
      current_state_at: { type: Sequelize.DATE(3), allowNull: true },

      amount_minor: { type: Sequelize.BIGINT, allowNull: true },
      currency: { type: Sequelize.CHAR(3), allowNull: true },

      issued_at: { type: Sequelize.DATE(3), allowNull: true },
      due_at: { type: Sequelize.DATE(3), allowNull: true },
      paid_at: { type: Sequelize.DATE(3), allowNull: true },
      voided_at: { type: Sequelize.DATE(3), allowNull: true },
      refunded_at: { type: Sequelize.DATE(3), allowNull: true },

      attributes: { type: Sequelize.JSON, allowNull: true },

      created_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
      updated_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });

    await qi.addIndex('invoices', {
      fields: ['natural_key'],
      unique: true,
      name: 'uq_invoices_natural_key',
    });
    await qi.addIndex('invoices', {
      fields: ['doc_ref'],
      name: 'idx_invoices_doc_ref',
    });
    await qi.addIndex('invoices', {
      fields: ['linked_bl'],
      name: 'idx_invoices_linked_bl',
    });
  },

  async down(qi) {
    await qi.dropTable('invoices');
  },
};
