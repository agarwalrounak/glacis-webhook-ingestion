'use strict';

require('dotenv').config();

const required = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
};

module.exports = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  logLevel: process.env.LOG_LEVEL || 'info',
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root',
    database: process.env.DB_NAME || 'glacis',
  },
  llm: {
    // Which provider client to use. Switching between providers requires
    // only an env change — see src/llm/client.js for the dispatch.
    provider: (process.env.LLM_PROVIDER || 'anthropic').toLowerCase(),
  },
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
    // Cap the LLM wall-clock. If the API stalls we want the worker to recover
    // via lease expiry rather than wedge forever.
    timeoutMs: parseInt(process.env.ANTHROPIC_TIMEOUT_MS || '30000', 10),
    maxRetries: parseInt(process.env.ANTHROPIC_MAX_RETRIES || '2', 10),
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    timeoutMs: parseInt(process.env.OPENAI_TIMEOUT_MS || '30000', 10),
    maxRetries: parseInt(process.env.OPENAI_MAX_RETRIES || '2', 10),
  },
  worker: {
    // How long a claim is held before another worker may steal it.
    leaseSeconds: parseInt(process.env.WORKER_LEASE_SECONDS || '120', 10),
    // Max processing attempts before we give up and mark the event 'dead'.
    maxAttempts: parseInt(process.env.WORKER_MAX_ATTEMPTS || '5', 10),
    // How many events a single worker tick claims at once.
    batchSize: parseInt(process.env.WORKER_BATCH_SIZE || '5', 10),
    // Idle sleep between empty polls; jittered ±50%.
    idlePollMs: parseInt(process.env.WORKER_IDLE_POLL_MS || '500', 10),
  },
  ingest: {
    // Reject obviously hostile payloads early; LLM tokens are not free.
    maxBodyBytes: parseInt(process.env.MAX_BODY_BYTES || '262144', 10), // 256 KiB
  },
  required,
};
