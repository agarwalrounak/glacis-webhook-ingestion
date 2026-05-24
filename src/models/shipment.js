'use strict';

const { DataTypes, Model } = require('sequelize');

module.exports = (sequelize) => {
  class Shipment extends Model {}
  Shipment.init({
    id: { type: DataTypes.BIGINT.UNSIGNED, primaryKey: true, autoIncrement: true },
    natural_key: { type: DataTypes.STRING(255), allowNull: false },
    carrier_scac: DataTypes.STRING,
    carrier_name: DataTypes.STRING,
    doc_number: DataTypes.STRING,
    container_no: DataTypes.STRING,
    current_state: DataTypes.ENUM('PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'),
    current_state_rank: { type: DataTypes.INTEGER.UNSIGNED, defaultValue: 0 },
    current_state_at: DataTypes.DATE(3),
    vessel_name: DataTypes.STRING,
    vessel_imo: DataTypes.STRING,
    voyage: DataTypes.STRING,
    last_port_code: DataTypes.STRING,
    last_port_name: DataTypes.STRING,
    consignee: DataTypes.STRING,
    shipper_ref: DataTypes.STRING,
    attributes: DataTypes.JSON,
  }, {
    sequelize,
    tableName: 'shipments',
    modelName: 'Shipment',
    underscored: true,
    timestamps: true,
    createdAt: 'created_at',
    updatedAt: 'updated_at',
  });
  return Shipment;
};
