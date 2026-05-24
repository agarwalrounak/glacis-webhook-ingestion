'use strict';

const OpenAI = require('openai');
const config = require('../../config');
const logger = require('../../logger');
const { openaiTool, SYSTEM_PROMPT, TOOL_NAME } = require('../normalizeTool');
const { validateToolInput } = require('../validate');

const client = new OpenAI({
  apiKey: config.openai.apiKey,
  maxRetries: config.openai.maxRetries,
  timeout: config.openai.timeoutMs,
});

/**
 * Call OpenAI to classify and normalize one payload. Returns the unified
 * result shape documented in src/llm/client.js.
 *
 * Notable provider differences vs Anthropic:
 *   - System prompt goes in the messages array as role:'system' rather than
 *     as a top-level parameter.
 *   - Function-calling result lives in choices[0].message.tool_calls[i] and
 *     `function.arguments` is a JSON-encoded STRING, not an object. We must
 *     JSON.parse it (and catch parse errors) before validating.
 *   - tool_choice forces a specific function: { type:'function', function: { name } }.
 */
async function normalize(payload) {
  const started = Date.now();
  try {
    const response = await client.chat.completions.create({
      model: config.openai.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: `Classify and normalize this webhook payload:\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``,
        },
      ],
      tools: [openaiTool],
      tool_choice: { type: 'function', function: { name: TOOL_NAME } },
      max_tokens: 1024,
    });

    const latencyMs = Date.now() - started;
    const message = response.choices?.[0]?.message;
    const call = message?.tool_calls?.find((c) => c.function?.name === TOOL_NAME);

    if (!call) {
      logger.warn({ finish_reason: response.choices?.[0]?.finish_reason }, 'openai did not invoke tool');
      return { ok: false, kind: 'invocation', error: 'no tool_call', latencyMs };
    }

    // OpenAI returns function.arguments as a STRING. Parse defensively —
    // a malformed JSON here is functionally identical to an invocation
    // failure but we tag it as 'schema' since the model "tried" to call.
    let parsedArgs;
    try {
      parsedArgs = JSON.parse(call.function.arguments);
    } catch (e) {
      logger.warn({ args: call.function.arguments }, 'openai tool arguments not valid JSON');
      return {
        ok: false,
        kind: 'schema',
        error: `arguments not valid JSON: ${e.message}`,
        latencyMs,
        rawInput: call.function.arguments,
      };
    }

    const validation = validateToolInput(parsedArgs);
    if (!validation.ok) {
      logger.warn({ error: validation.error, input: parsedArgs }, 'openai tool input failed schema validation');
      return { ok: false, kind: 'schema', error: validation.error, latencyMs, rawInput: parsedArgs };
    }

    return { ok: true, result: validation.value, latencyMs, model: response.model };
  } catch (err) {
    const latencyMs = Date.now() - started;
    logger.warn({ err: err.message, status: err.status }, 'openai call failed');
    return { ok: false, kind: 'network', error: err.message, status: err.status, latencyMs };
  }
}

module.exports = { normalize, name: 'openai', model: config.openai.model };
