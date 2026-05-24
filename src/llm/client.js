'use strict';

const config = require('../config');
const logger = require('../logger');

/**
 * Provider dispatcher. The rest of the application imports `normalize` from
 * this file and is completely unaware which LLM provider is in use.
 *
 * Unified result shape — both providers must return this exact contract:
 *
 *   Success:
 *     { ok: true, result, latencyMs, model }
 *       result  — validated tool input matching src/llm/normalizeTool.js
 *       model   — provider's reported model id (for telemetry)
 *
 *   Failure (caller decides retry/dead-letter/needs_review based on `kind`):
 *     { ok: false, kind, error, latencyMs, rawInput?, status? }
 *       kind = 'invocation'  — model returned but didn't call the tool
 *              'schema'      — tool result failed AJV validation
 *              'network'     — transport / API / timeout error
 *       rawInput — the offending model output, if available
 *       status   — HTTP status for network failures, if available
 *
 * Switch providers by setting LLM_PROVIDER=anthropic|openai. No code changes
 * required anywhere outside this directory.
 */

const providers = {
  anthropic: () => require('./providers/anthropic'),
  openai: () => require('./providers/openai'),
};

const providerName = config.llm.provider;
const load = providers[providerName];
if (!load) {
  throw new Error(`unknown LLM_PROVIDER: "${providerName}". Use one of: ${Object.keys(providers).join(', ')}`);
}

const provider = load();
logger.info({ provider: provider.name, model: provider.model }, 'llm provider selected');

module.exports = {
  normalize: provider.normalize,
  providerName: provider.name,
  model: provider.model,
};
