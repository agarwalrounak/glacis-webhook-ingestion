'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class InvoiceEvent extends Model {}
  InvoiceEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    invoice_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    raw_event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    state: { type: DataTypes.ENUM('ISSUED', 'PAID', 'VOIDED', 'REFUNDED'), allowNull: false },
    event_at: { type: DataTypes.DATE(3), allowNull: false },
    vendor: DataTypes.STRING,
    memo: DataTypes.STRING(500),
    amount_minor: DataTypes.BIGINT,
    currency: DataTypes.CHAR(3),
    attributes: DataTypes.JSON,
    advanced_current_state: { type: DataTypes.BOOLEAN, defaultValue: false },
  }, {
    sequelize,
    tableName: 'invoice_events',
    modelName: 'InvoiceEvent',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
  return InvoiceEvent;
};
