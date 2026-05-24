'use strict';

module.exports = {
  async up(qi, Sequelize) {
    await qi.createTable('invoice_events', {
      id: { type: Sequelize.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
      invoice_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },
      raw_event_id: { type: Sequelize.BIGINT.UNSIGNED, allowNull: false },

      state: {
        type: Sequelize.ENUM('ISSUED', 'PAID', 'VOIDED', 'REFUNDED'),
        allowNull: false,
      },
      event_at: { type: Sequelize.DATE(3), allowNull: false },

      vendor: { type: Sequelize.STRING(100), allowNull: true },
      memo: { type: Sequelize.STRING(500), allowNull: true },
      amount_minor: { type: Sequelize.BIGINT, allowNull: true },
      currency: { type: Sequelize.CHAR(3), allowNull: true },
      attributes: { type: Sequelize.JSON, allowNull: true },

      advanced_current_state: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },

      created_at: { type: Sequelize.DATE(3), allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP(3)') },
    });

    await qi.addConstraint('invoice_events', {
      fields: ['invoice_id', 'raw_event_id'],
      type: 'unique',
      name: 'uq_invoice_events_invoice_raw',
    });
    await qi.addIndex('invoice_events', {
      fields: ['invoice_id', 'event_at'],
      name: 'idx_invoice_events_timeline',
    });
    await qi.addConstraint('invoice_events', {
      fields: ['invoice_id'],
      type: 'foreign key',
      name: 'fk_invoice_events_invoice',
      references: { table: 'invoices', field: 'id' },
      onDelete: 'CASCADE',
    });
    await qi.addConstraint('invoice_events', {
      fields: ['raw_event_id'],
      type: 'foreign key',
      name: 'fk_invoice_events_raw',
      references: { table: 'raw_events', field: 'id' },
      onDelete: 'RESTRICT',
    });
  },

  async down(qi) {
    await qi.dropTable('invoice_events');
  },
};
