'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class ShipmentEvent extends Model {}
  ShipmentEvent.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    shipment_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    raw_event_id: { type: DataTypes.BIGINT.UNSIGNED, allowNull: false },
    state: { type: DataTypes.ENUM('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'), allowNull: false },
    state_rank: { type: DataTypes.INTEGER.UNSIGNED, allowNull: false },
    event_at: { type: DataTypes.DATE(3), allowNull: false },
    vendor: DataTypes.STRING,
    vendor_milestone_text: DataTypes.STRING(500),
    port_code: DataTypes.STRING,
    attributes: DataTypes.JSON,
    advanced_current_state: { type: DataTypes.BOOLEAN, defaultValue: false },
  }, {
    sequelize,
    tableName: 'shipment_events',
    modelName: 'ShipmentEvent',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: false,
  });
  return ShipmentEvent;
};
