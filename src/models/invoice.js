'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Invoice extends Model {}
  Invoice.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    natural_key: { type: DataTypes.STRING(255), allowNull: false },
    source: DataTypes.STRING,
    doc_ref: DataTypes.STRING,
    carrier: DataTypes.STRING,
    linked_bl: DataTypes.STRING,
    remitter: DataTypes.STRING,
    current_state: DataTypes.ENUM('ISSUED', 'PAID', 'VOIDED', 'REFUNDED'),
    current_state_at: DataTypes.DATE(3),
    amount_minor: DataTypes.BIGINT,
    currency: DataTypes.CHAR(3),
    issued_at: DataTypes.DATE(3),
    due_at: DataTypes.DATE(3),
    paid_at: DataTypes.DATE(3),
    voided_at: DataTypes.DATE(3),
    refunded_at: DataTypes.DATE(3),
    attributes: DataTypes.JSON,
  }, {
    sequelize,
    tableName: 'invoices',
    modelName: 'Invoice',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return Invoice;
};
