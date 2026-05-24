'use strict';

const os = require('os');
const crypto = require('crypto');
const { sequelize } = require('../models');
const { claimBatch } = require('./claim');
const { processOne } = require('./process');
const { providerName, model } = require('../llm/client');
const config = require('../config');
const logger = require('../logger');

const workerId = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
let running = true;

/**
 * Main worker loop.
 *
 * One worker process can handle many concurrent in-flight events (each LLM
 * call is mostly I/O). We claim a batch, then await all of them in parallel.
 * Within a batch, processOne is independent per event — there's no inter-row
 * coordination beyond the shipment/invoice row locks the domain layer takes.
 *
 * Stops on SIGTERM/SIGINT: we let the current batch finish, then exit. Any
 * 'processing' rows whose worker dies mid-batch will be re-claimed once
 * their lease expires.
 */
async function tick() {
  const rows = await claimBatch(workerId);
  if (rows.length === 0) return false;

  await Promise.allSettled(rows.map((row) => processOne(row, logger.child({ worker_id: workerId }))));
  return true;
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitteredSleep(baseMs) {
  const jitter = 0.5 + Math.random();
  return sleep(Math.floor(baseMs * jitter));
}

async function start() {
  await sequelize.authenticate();
  logger.info({ workerId, provider: providerName, model }, 'worker started');

  const keyVar = providerName === 'openai' ? 'OPENAI_API_KEY' : 'ANTHROPIC_API_KEY';
  const keyPresent = providerName === 'openai' ? config.openai.apiKey : config.anthropic.apiKey;
  if (!keyPresent) {
    logger.warn(`${keyVar} not set — every LLM call will fail. Set it in .env to actually process events.`);
  }

  while (running) {
    try {
      const didWork = await tick();
      if (!didWork) await jitteredSleep(config.worker.idlePollMs);
    } catch (err) {
      // Top-level safety net. Should be rare — processOne handles its own
      // errors. If we crash repeatedly, container restart policy takes over.
      logger.error({ err: err.message, stack: err.stack }, 'worker tick crashed');
      await sleep(1000);
    }
  }

  logger.info('worker stopping');
  await sequelize.close();
  process.exit(0);
}

const shutdown = (signal) => {
  logger.info({ signal }, 'worker received shutdown signal');
  running = false;
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
  start().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'worker failed to start');
    process.exit(1);
  });
}
