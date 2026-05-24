'use strict';

const { sequelize, Shipment, ShipmentEvent } = require('../models');
const { SHIPMENT_RANK } = require('./states');
const { canonicalizeNaturalKey } = require('./identity');
const logger = require('../logger');

/**
 * Apply one normalized shipment event to durable state.
 *
 * Inputs:
 *   data        - the validated `shipment` block from the LLM tool call
 *   rawEventId  - the raw_events.id for this webhook
 *   tx          - the active Sequelize transaction (caller owns the txn)
 *
 * Behavior:
 *   1. Upsert the shipment row by natural_key.
 *   2. Lock the row FOR UPDATE so concurrent workers can't race the
 *      current_state advance.
 *   3. Insert into shipment_events with UNIQUE(shipment_id, raw_event_id).
 *      If a duplicate (worker retry after partial commit), swallow and exit
 *      idempotently.
 *   4. If the incoming event has a strictly higher state_rank, advance
 *      current_state on the shipment.
 *
 * Returns: { shipmentId, advanced, duplicate }
 */
async function applyShipmentEvent({ data, rawEventId, tx }) {
  const eventAt = new Date(data.event_at);
  const rank = SHIPMENT_RANK[data.state];
  if (!rank) throw new Error(`unknown shipment state: ${data.state}`);

  // Canonicalize the LLM-emitted key (lowercase, trim trailing colons, etc.)
  // before any lookup or insert. This is the join-key guarantee — without
  // it, the same logical shipment can split across multiple rows whenever
  // the LLM drifts on whitespace/case/punctuation.
  const naturalKey = canonicalizeNaturalKey(data.natural_key);

  // Step 1: upsert by natural_key.
  // Sequelize doesn't have a clean upsert-with-row-lock primitive on MySQL,
  // so we do the find/create dance explicitly under the transaction. The
  // UNIQUE constraint on natural_key keeps us correct under concurrent
  // inserts (one side gets a duplicate-key error and retries the find).
  let shipment = await Shipment.findOne({
    where: { natural_key: naturalKey },
    transaction: tx,
    lock: tx.LOCK.UPDATE,
  });

  if (!shipment) {
    try {
      shipment = await Shipment.create({
        natural_key: naturalKey,
        carrier_scac: data.carrier_scac || null,
        carrier_name: data.carrier_name || null,
        doc_number: data.doc_number || null,
        container_no: data.container_no || null,
        vessel_name: data.vessel_name || null,
        vessel_imo: data.vessel_imo || null,
        voyage: data.voyage || null,
        last_port_code: data.port_code || null,
        last_port_name: data.port_name || null,
        consignee: data.consignee || null,
        shipper_ref: data.shipper_ref || null,
        current_state_rank: 0,
      }, { transaction: tx });
    } catch (err) {
      // Concurrent creator won the race. Re-fetch with the lock and continue.
      if (err.name === 'SequelizeUniqueConstraintError') {
        shipment = await Shipment.findOne({
          where: { natural_key: naturalKey },
          transaction: tx,
          lock: tx.LOCK.UPDATE,
        });
      } else {
        throw err;
      }
    }
  }

  // Step 2: insert the event row. UNIQUE(shipment_id, raw_event_id) makes
  // re-processing a raw_event a no-op at this layer.
  const willAdvance = rank > (shipment.current_state_rank || 0);
  try {
    await ShipmentEvent.create({
      shipment_id: shipment.id,
      raw_event_id: rawEventId,
      state: data.state,
      state_rank: rank,
      event_at: eventAt,
      vendor: data.vendor || null,
      vendor_milestone_text: data.milestone_text || null,
      port_code: data.port_code || null,
      attributes: null,
      advanced_current_state: willAdvance,
    }, { transaction: tx });
  } catch (err) {
    if (err.name === 'SequelizeUniqueConstraintError') {
      logger.info({ shipmentId: shipment.id, rawEventId }, 'shipment event already applied; idempotent skip');
      return { shipmentId: shipment.id, advanced: false, duplicate: true };
    }
    throw err;
  }

  // Step 3: advance current_state if strictly forward.
  if (willAdvance) {
    await shipment.update({
      current_state: data.state,
      current_state_rank: rank,
      current_state_at: eventAt,
      // Best-effort denormalization: prefer the freshest vendor-provided values
      // when they advance the state. Older/out-of-order events do not clobber.
      vessel_name: data.vessel_name || shipment.vessel_name,
      vessel_imo: data.vessel_imo || shipment.vessel_imo,
      voyage: data.voyage || shipment.voyage,
      last_port_code: data.port_code || shipment.last_port_code,
      last_port_name: data.port_name || shipment.last_port_name,
      consignee: data.consignee || shipment.consignee,
      shipper_ref: data.shipper_ref || shipment.shipper_ref,
      carrier_scac: data.carrier_scac || shipment.carrier_scac,
      carrier_name: data.carrier_name || shipment.carrier_name,
    }, { transaction: tx });
  } else {
    logger.info(
      { shipmentId: shipment.id, incoming: data.state, current: shipment.current_state },
      'shipment event recorded but did not advance current_state (out-of-order or duplicate-rank)'
    );
  }

  return { shipmentId: shipment.id, advanced: willAdvance, duplicate: false };
}

module.exports = { applyShipmentEvent };
