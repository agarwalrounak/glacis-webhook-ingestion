'use strict';

const { sequelize } = require('../db');
const RawEvent = require('./rawEvent')(sequelize);
const Shipment = require('./shipment')(sequelize);
const ShipmentEvent = require('./shipmentEvent')(sequelize);
const Invoice = require('./invoice')(sequelize);
const InvoiceEvent = require('./invoiceEvent')(sequelize);

Shipment.hasMany(ShipmentEvent, { foreignKey: 'shipment_id', as: 'events' });
ShipmentEvent.belongsTo(Shipment, { foreignKey: 'shipment_id' });
ShipmentEvent.belongsTo(RawEvent, { foreignKey: 'raw_event_id' });

Invoice.hasMany(InvoiceEvent, { foreignKey: 'invoice_id', as: 'events' });
InvoiceEvent.belongsTo(Invoice, { foreignKey: 'invoice_id' });
InvoiceEvent.belongsTo(RawEvent, { foreignKey: 'raw_event_id' });

module.exports = {
  sequelize,
  RawEvent,
  Shipment,
  ShipmentEvent,
  Invoice,
  InvoiceEvent,
};
