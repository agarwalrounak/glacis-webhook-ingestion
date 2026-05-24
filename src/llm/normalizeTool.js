'use strict';

/**
 * The canonical contract between the LLM and the rest of the system.
 *
 * This is THE source of truth for the normalized schema. We define this JSON
 * Schema once; the per-provider adapters in src/llm/providers/* wrap it in
 * whatever shape the provider's tool/function-calling API requires. The
 * schema BODY is identical across providers — only the wrapper differs.
 *
 * It is NOT a hard guarantee that LLM output matches the schema — enum
 * violations, missing optional fields, and cross-field invariants can still
 * slip through. That's why src/llm/providers/* run the result through AJV
 * before we trust it, and route validation failures to `needs_review`
 * rather than into the canonical tables.
 *
 * Design choices:
 *
 * - Discriminated union on `type`. The model decides classification by which
 *   discriminator it emits, in the same call as extraction. No two-stage.
 *
 * - `natural_key` is the LLM's responsibility. The model picks the strongest
 *   stable identifier for the entity given the vendor's data, and joins it
 *   into a colon-separated string. This is the entity-identity primitive used
 *   everywhere downstream. We give the model explicit composition rules in
 *   the system prompt so its output is deterministic across vendors.
 *
 * - `amount_minor` is an integer in the smallest currency unit (e.g. cents).
 *   Vendors send strings like "EUR 24.350,75" with locale-specific punctuation
 *   — the model is asked to parse this and emit the integer 2435075 alongside
 *   the ISO currency code. This keeps money math out of binary floats.
 *
 * - `confidence` lets the worker route low-confidence results to a
 *   needs_review bucket instead of silently writing them through.
 */

const SHIPMENT_STATES = ['PICKED_UP', 'IN_TRANSIT', 'OUT_FOR_DELIVERY', 'DELIVERED'];
const INVOICE_STATES = ['ISSUED', 'PAID', 'VOIDED', 'REFUNDED'];

const TOOL_NAME = 'normalize_webhook';
const TOOL_DESCRIPTION =
  'Classify a vendor webhook payload and extract canonical fields. Always call this exactly once.';

// Pure JSON Schema. No provider-specific wrappers in here.
const schema = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'confidence', 'reasoning'],
  properties: {
    type: {
      type: 'string',
      enum: ['shipment', 'invoice', 'unclassified'],
      description:
        'shipment = an update about a physical parcel moving through a logistics network. invoice = a financial document the platform owes, is owed, or has settled. unclassified = anything else (advisories, alerts, generic notifications).',
    },
    confidence: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
      description:
        'How confident you are in BOTH the classification and the extracted fields. Use "low" if the payload is ambiguous or required fields had to be guessed.',
    },
    reasoning: {
      type: 'string',
      maxLength: 1000,
      description:
        'One or two sentences explaining the classification and any non-obvious extraction decisions. Used for human review.',
    },

    shipment: {
      // Nullable: some providers (notably OpenAI) emit `"shipment": null`
      // for non-shipment classifications rather than omitting the key. The
      // cross-field check in validate.js still enforces "if type=shipment
      // then shipment must be a populated object".
      //
      // additionalProperties is INTENTIONALLY NOT set to false here. The
      // universe of vendor-specific identifier fields is unbounded (parcel_id,
      // tracking_reference, awb, scan_type, driver_id, ...). Rejecting any
      // extras would route otherwise-correct events to needs_review whenever
      // the LLM helpfully echoes a vendor field name. Code reads only the
      // canonical fields below; the full tool_use input is preserved in
      // raw_events.llm_response for audit.
      type: ['object', 'null'],
      description: 'Required when type = "shipment". Use null otherwise.',
      required: ['natural_key', 'state', 'event_at'],
      properties: {
        natural_key: {
          type: 'string',
          description:
            'Stable cross-vendor identity. See the system prompt for the EXACT composition rules — the format is "<carrier>:<primary_id>", lowercase, exactly two colon-separated parts. Same physical parcel = same natural_key across every event.',
        },
        state: {
          type: 'string',
          enum: SHIPMENT_STATES,
          description:
            'Canonical lifecycle state. Collapse vendor phrasing: "gate-in at origin terminal" / "container received" → PICKED_UP. "loaded onboard" / "vessel departed" / arrival at intermediate port → IN_TRANSIT. "out for delivery" / "on vehicle" → OUT_FOR_DELIVERY. "released to consignee" / "handed to recipient" / "delivered" → DELIVERED.',
        },
        event_at: {
          type: 'string',
          description:
            'ISO 8601 timestamp of when the milestone occurred (NOT when the webhook was sent). Preserve the offset if the vendor provided one; convert local-time strings using the most plausible timezone given vendor/port context.',
        },
        carrier_scac: { type: ['string', 'null'] },
        carrier_name: { type: ['string', 'null'] },
        doc_number: {
          type: ['string', 'null'],
          description:
            'Master / House / Air Waybill number when present (e.g. MAEU240498712, ONEYJKTHKG2604113, 125-88392011). The TYPE of document is not modeled — only the number.',
        },
        container_no: { type: ['string', 'null'] },
        vessel_name: { type: ['string', 'null'] },
        vessel_imo: { type: ['string', 'null'] },
        voyage: { type: ['string', 'null'] },
        port_code: { type: ['string', 'null'], description: 'UN/LOCODE if available.' },
        port_name: { type: ['string', 'null'] },
        consignee: { type: ['string', 'null'] },
        shipper_ref: { type: ['string', 'null'] },
        vendor: { type: ['string', 'null'], description: 'Vendor system name as a short slug.' },
        milestone_text: { type: ['string', 'null'], description: 'Verbatim vendor milestone phrase.' },
      },
    },

    invoice: {
      // Nullable for the same reason as `shipment` above.
      // additionalProperties intentionally NOT false — see the shipment
      // block comment for rationale.
      type: ['object', 'null'],
      description: 'Required when type = "invoice". Use null otherwise.',
      required: ['natural_key', 'state', 'event_at'],
      properties: {
        natural_key: {
          type: 'string',
          description:
            'Stable cross-vendor identity. See the system prompt for the EXACT composition rules — the format is "<source>:<doc_ref>", lowercase, exactly two colon-separated parts. Same invoice = same natural_key across issued/paid/voided/refunded events.',
        },
        state: {
          type: 'string',
          enum: INVOICE_STATES,
          description:
            'Canonical lifecycle state. "raised" / "issued" / "billed" → ISSUED. "settled" / "paid" / "remitted" → PAID. "cancelled before payment" / "voided" → VOIDED. "reversed" / "refunded after settlement" → REFUNDED.',
        },
        event_at: {
          type: 'string',
          description:
            'ISO 8601 timestamp of when the state change occurred (issued_at, settled_at, etc.).',
        },
        source: { type: ['string', 'null'] },
        doc_ref: { type: ['string', 'null'] },
        carrier: { type: ['string', 'null'] },
        linked_bl: { type: ['string', 'null'] },
        remitter: { type: ['string', 'null'] },
        amount_minor: {
          type: ['integer', 'null'],
          description:
            'Monetary amount in the smallest currency unit (e.g. cents for USD/EUR). Parse vendor strings carefully: "EUR 24.350,75" is twenty-four thousand three hundred fifty euros and seventy-five cents → 2435075. "USD 1,234.50" → 123450.',
        },
        currency: {
          type: ['string', 'null'],
          description: 'ISO 4217 three-letter currency code.',
        },
        due_at: { type: ['string', 'null'] },
        memo: { type: ['string', 'null'] },
        vendor: { type: ['string', 'null'] },
      },
    },
  },
};

const SYSTEM_PROMPT = `You are a webhook classification and extraction service for a supply-chain platform.

Every input is a single vendor webhook payload (JSON). Your job is to:
  1. Decide if it is a SHIPMENT update, an INVOICE update, or UNCLASSIFIED.
  2. Extract canonical fields into the schema of the ${TOOL_NAME} tool.
  3. Compose a stable natural_key so that all events about the same entity collapse onto the same record.

You must call the ${TOOL_NAME} tool exactly once. Do not produce free-text output.

==============================================================
CLASSIFICATION
==============================================================
Be conservative. If the payload is an advisory, alert, maintenance notice, marketing message, generic error response, or anything that is NOT about a specific parcel/shipment or a specific financial document, classify as "unclassified". When in doubt, choose "unclassified".

==============================================================
NATURAL_KEY — THE MOST IMPORTANT FIELD
==============================================================
The natural_key is the primary join key that collapses events about the same entity. Two events for the same parcel or same invoice MUST produce byte-identical natural_keys, regardless of which optional fields appear in each payload.

GENERAL RULES (apply to both shipments and invoices):
  - The format is ALWAYS exactly two parts separated by ONE colon: "<scope>:<id>".
  - Both parts are LOWERCASE.
  - No trailing colons. No leading colons. No double colons. No extra parts.
  - Use values VERBATIM from the payload (with the case-folding noted above).
  - DO NOT add suffixes that aren't in the payload (do NOT append ".api", "/v2", etc.).
  - DO NOT include event-specific data: timestamps, milestone phrases, message ids, sequence numbers, event_ids.
  - DO NOT include the doc_type tag (do NOT put "mbl", "hbl", "awb" inside the key).

SHIPMENT natural_key — format: "<carrier>:<primary_id>"
  carrier (first part):
    - If the payload provides a 4-letter carrier SCAC, use it lowercased: "maeu", "oney", "hlcu".
    - Otherwise use the carrier/logistics-provider/vendor-system name from the payload, lowercased, VERBATIM (do not add or strip suffixes; preserve internal spaces and dots).
  primary_id (second part):
    - Choose ONE single identifier, in this strict priority order, and use it verbatim:
        1. container number (e.g. MSKU7748112, TLLU2890442)
        2. AWB / B/L / waybill number  (e.g. 125-88392011, MAEU240498712, ONEYJKTHKG2604113)
        3. parcel id / tracking reference  (e.g. GF-7738-992, LMN-88492011)
    - Stop at the first one that is present. Do NOT join multiple identifiers together.

SHIPMENT examples (these are the EXACT keys to emit):
  Maersk ocean payload with carrier_scac="MAEU", container="MSKU7748112"
    →  "maeu:msku7748112"
  ONE ocean payload with carrier_scac="ONEY", container_no="TLLU2890442"
    →  "oney:tllu2890442"
  AirFreight Intl payload with carrier="AirFreight Intl", awb="125-88392011" (no SCAC, no container)
    →  "airfreight intl:125-88392011"
  LastMileNow payload with system="LastMileNow API", tracking_reference="LMN-88492011"
    →  "lastmilenow api:lmn-88492011"
  GroundForce payload with logistics_provider="GroundForce", parcel_id="GF-7738-992"
    →  "groundforce:gf-7738-992"

INVOICE natural_key — format: "<source>:<doc_ref>"
  source (first part):
    - Use the payload's "source" or "system" or "vendor_id" field VERBATIM, lowercased.
    - If the payload says system="FreightPay", emit "freightpay".
    - If the payload says source="globalfreightpay.api", emit "globalfreightpay.api" (preserve the ".api" because it IS in the payload).
    - DO NOT invent suffixes. NEVER append ".api" to a source that doesn't have it.
  doc_ref (second part):
    - The vendor's invoice/document reference, verbatim, lowercased.
    - For Stripe-style events (type="charge.*"), use the underlying object id from data.object.id (e.g. "ch_3N9xx22L"), NOT the top-level event id (evt_*). Multiple events about the same charge — refunds, captures, etc. — must share one natural_key.

INVOICE examples (these are the EXACT keys to emit):
  GlobalFreightPay payload with source="globalfreightpay.api", doc_ref="GFP-INV-2026-Q2-08821"
    →  "globalfreightpay.api:gfp-inv-2026-q2-08821"
  FreightPay payload with system="FreightPay", ref="FP-9902"
    →  "freightpay:fp-9902"
  FinLogistics payload with vendor_id="FINLOG", document_id="INV-2026-99A"
    →  "finlog:inv-2026-99a"
  Stripe charge.refunded with data.object.id="ch_3N9xx22L"
    →  "stripe:ch_3n9xx22l"

==============================================================
STATE MAPPING (canonical lifecycle states)
==============================================================
Map vendor phrasing to the canonical enums. Examples:
  Shipment:
    "gate-in at origin terminal" / "container received" / "collected from sender" / "package picked up" → PICKED_UP
    "loaded onboard" / "vessel departed" / "departed transit facility" / arrival at intermediate port / customs cleared → IN_TRANSIT
    "out for delivery" / "loaded onto the final delivery vehicle" / "on vehicle for delivery" → OUT_FOR_DELIVERY
    "released to consignee" / "handed to recipient" / "delivered" / "POD captured" → DELIVERED
  Invoice:
    "raised" / "issued" / "billed" / "invoice generated" → ISSUED
    "settled" / "paid" / "remitted" / "funds cleared" → PAID
    "cancelled before payment" / "voided" / "annulled" / "statement_annulled" → VOIDED
    "reversed" / "refunded after settlement" / "charge.refunded" → REFUNDED

==============================================================
TIMESTAMPS
==============================================================
Emit fully-qualified ISO 8601 with a timezone offset.
Preserve the vendor's offset if present.
If only local time + a Unix epoch (e.g. Stripe's "created") is given, use the epoch to construct the ISO timestamp in UTC.
If only local time is given without a zone, infer the zone from context (port code, vendor country) and emit the fully-qualified value.

==============================================================
MONEY
==============================================================
Parse locale-specific punctuation. Examples:
  "EUR 24.350,75"  →  amount_minor: 2435075, currency: "EUR"  (European: dot=thousands, comma=decimal)
  "USD 1,234.50"   →  amount_minor: 123450,  currency: "USD"  (US: comma=thousands, dot=decimal)
  Stripe: amount=45000, currency="usd"  →  amount_minor: 45000, currency: "USD"
Always emit currency as the 3-letter uppercase ISO 4217 code.`;

// Provider-specific wrappers around the same schema body.
const anthropicTool = {
  name: TOOL_NAME,
  description: TOOL_DESCRIPTION,
  input_schema: schema,
};

const openaiTool = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: TOOL_DESCRIPTION,
    parameters: schema,
    // strict: true is intentionally OFF — OpenAI's strict mode requires
    // every property to be in `required` and disallows nullable enums in
    // some places, which would mean a schema refactor. We instead rely on
    // the AJV validator in each provider to enforce the contract at
    // runtime, same as we do for Anthropic.
  },
};

module.exports = {
  TOOL_NAME,
  TOOL_DESCRIPTION,
  schema,
  SYSTEM_PROMPT,
  anthropicTool,
  openaiTool,
  SHIPMENT_STATES,
  INVOICE_STATES,
};
