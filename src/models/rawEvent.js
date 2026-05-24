'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class RawEvent extends Model {}
  RawEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    body_hash: { type: DataTypes.CHAR(64), allowNull: false },
    vendor_hint: DataTypes.STRING,
    payload: { type: DataTypes.JSON, allowNull: false },
    headers: DataTypes.JSON,
    received_at: { type: DataTypes.DATE(3), allowNull: false },
    status: { type: DataTypes.ENUM('pending', 'processing', 'normalized', 'unclassified', 'needs_review', 'dead'), allowNull: false, defaultValue: 'pending' },
    attempts: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 },
    locked_until: { type: DataTypes.DATE(3), allowNull: false },
    worker_id: DataTypes.STRING,
    last_error: DataTypes.TEXT,
    classification: DataTypes.ENUM('shipment', 'invoice', 'unclassified'),
    entity_type: DataTypes.ENUM('shipment', 'invoice'),
    entity_id: DataTypes.BIGINT.UNSIGNED,
    llm_model: DataTypes.STRING,
    llm_latency_ms: DataTypes.INTEGER.UNSIGNED,
    llm_response: DataTypes.JSON,
    processed_at: DataTypes.DATE(3),
  }, {
    sequelize,
    tableName: 'raw_events',
    modelName: 'RawEvent',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return RawEvent;
};
