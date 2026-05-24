'use strict';

const Ajv = require('ajv');
const { schema } = require('./normalizeTool');

const ajv = new Ajv({ allErrors: true, strict: false });
const validate = ajv.compile(schema);

/**
 * Validate a tool-call payload (already parsed to an object) against our
 * canonical schema. Returns either { ok: true, value } or { ok: false, error }.
 * Also enforces the cross-field invariant that JSON Schema can't easily
 * express: type=shipment requires a shipment block; type=invoice requires
 * invoice.
 */
function validateToolInput(input) {
  if (!validate(input)) {
    return { ok: false, error: ajv.errorsText(validate.errors) };
  }
  if (input.type === 'shipment' && !input.shipment) {
    return { ok: false, error: 'type=shipment but no shipment block' };
  }
  if (input.type === 'invoice' && !input.invoice) {
    return { ok: false, error: 'type=invoice but no invoice block' };
  }
  return { ok: true, value: input };
}

module.exports = { validateToolInput };
