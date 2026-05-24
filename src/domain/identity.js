'use strict';

/**
 * Defense-in-depth canonicalization of the natural_key.
 *
 * The system prompt instructs the LLM to emit lowercase, two-part,
 * colon-separated keys — but no prompt-engineering is a hard guarantee.
 * We've seen real failures where the model emitted slight variants for
 * the same logical entity:
 *
 *    "GroundForce:MBL:GF-7738-992"   vs   "GroundForce:MBL:GF-7738-992:"
 *    "freightpay:FP-9902"            vs   "freightpay.api:FP-9902"
 *
 * The first pair differs only in a trailing colon (deterministically
 * fixable here). The second pair differs in a hallucinated ".api"
 * suffix (NOT fixable here — that's a prompt problem). This helper
 * handles the first class of failure; the prompt handles the second.
 *
 * What we normalize:
 *   - leading/trailing whitespace
 *   - case (lowercased; natural_key is opaque for matching, the original
 *     case is preserved on the per-field columns)
 *   - leading and trailing colons
 *   - repeated consecutive colons collapsed to one
 *
 * What we deliberately do NOT touch:
 *   - the internal structure beyond the rules above (we don't try to
 *     guess which "shape" was right when the LLM emitted three parts
 *     vs two — that's a semantic decision)
 *   - hyphens, dots, underscores within identifiers
 */
function canonicalizeNaturalKey(raw) {
  if (raw == null) return raw;
  if (typeof raw !== 'string') return raw;
  return raw
    .trim()
    .toLowerCase()
    .replace(/:+/g, ':')         // collapse repeated colons
    .replace(/^:+|:+$/g, '');    // strip leading/trailing colons
}

module.exports = { canonicalizeNaturalKey };
