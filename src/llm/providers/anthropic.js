'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const config = require('../../config');
const logger = require('../../logger');
const { anthropicTool, SYSTEM_PROMPT, TOOL_NAME } = require('../normalizeTool');
const { validateToolInput } = require('../validate');

const client = new Anthropic({
  apiKey: config.anthropic.apiKey,
  // The SDK retries 429/5xx with backoff up to maxRetries. We add our own
  // outer retry at the worker level for everything else (schema, network).
  maxRetries: config.anthropic.maxRetries,
  timeout: config.anthropic.timeoutMs,
});

/**
 * Call Claude to classify and normalize one payload. Returns the unified
 * result shape documented in src/llm/client.js.
 */
async function normalize(payload) {
  const started = Date.now();
  try {
    const response = await client.messages.create({
      model: config.anthropic.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: [anthropicTool],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Classify and normalize this webhook payload:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
            },
          ],
        },
      ],
    });

    const latencyMs = Date.now() - started;
    const toolUse = response.content.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!toolUse) {
      logger.warn({ stop_reason: response.stop_reason }, 'anthropic did not invoke tool');
      return { ok: false, kind: 'invocation', error: 'no tool_use block', latencyMs };
    }

    const validation = validateToolInput(toolUse.input);
    if (!validation.ok) {
      logger.warn({ error: validation.error, input: toolUse.input }, 'anthropic tool input failed schema validation');
      return { ok: false, kind: 'schema', error: validation.error, latencyMs, rawInput: toolUse.input };
    }

    return { ok: true, result: validation.value, latencyMs, model: response.model };
  } catch (err) {
    const latencyMs = Date.now() - started;
    logger.warn({ err: err.message, status: err.status }, 'anthropic call failed');
    return { ok: false, kind: 'network', error: err.message, status: err.status, latencyMs };
  }
}

module.exports = { normalize, name: 'anthropic', model: config.anthropic.model };
