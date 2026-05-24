'use strict';

const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const logger = require('../logger');
const { sequelize, RawEvent, Shipment, ShipmentEvent, Invoice, InvoiceEvent } = require('../models');

const app = express();

// Raw-body capture for hashing. express.json's `verify` hook runs BEFORE
// parsing, so we get the original bytes the vendor sent, not a re-serialized
// version that might differ from a retry's bytes.
app.use(express.json({
  limit: config.ingest.maxBodyBytes,
  verify: (req, _res, buf) => { req.rawBody = buf; },
}));

// Tag every request with an id so we can correlate logs across the
// ingest → worker → LLM pipeline.
app.use((req, _res, next) => {
  req.id = crypto.randomBytes(8).toString('hex');
  req.log = logger.child({ req_id: req.id, path: req.path });
  next();
});

// JSON parse errors land here. We want to surface them as 400 so vendors
// can fix obviously malformed payloads, rather than silently swallowing.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    req.log.warn({ err: err.message }, 'malformed json');
    return res.status(400).json({ error: 'malformed_json', message: err.message });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'payload_too_large', limit_bytes: config.ingest.maxBodyBytes });
  }
  next(err);
});

app.get('/healthz', (_req, res) => res.json({ ok: true }));

app.get('/readyz', async (_req, res) => {
  try {
    await sequelize.query('SELECT 1');
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: err.message });
  }
});

/**
 * POST /webhooks
 * POST /webhooks/:vendor
 *
 * Accepts any well-formed JSON payload. Persists it to raw_events and returns
 * 200 as quickly as possible — actual classification + extraction happens
 * asynchronously in the worker.
 *
 * Idempotency: SHA-256(body) is UNIQUE. Repeat POSTs from a flaky vendor
 * resolve to the same raw_event row and return 200 each time.
 */
app.post(['/webhooks', '/webhooks/:vendor'], async (req, res) => {
  if (!req.rawBody || req.rawBody.length === 0) {
    return res.status(400).json({ error: 'empty_body' });
  }

  const bodyHash = crypto.createHash('sha256').update(req.rawBody).digest('hex');
  const receivedAt = new Date();

  try {
    const [row, created] = await RawEvent.findOrCreate({
      where: { body_hash: bodyHash },
      defaults: {
        body_hash: bodyHash,
        vendor_hint: req.params.vendor || req.header('x-vendor') || null,
        payload: req.body,
        headers: pickSafeHeaders(req.headers),
        received_at: receivedAt,
        locked_until: receivedAt,
        status: 'pending',
      },
    });

    if (!created) {
      req.log.info({ raw_event_id: row.id, body_hash: bodyHash }, 'duplicate webhook absorbed');
      return res.status(200).json({
        ok: true,
        duplicate: true,
        raw_event_id: row.id,
        status: row.status,
      });
    }

    req.log.info({ raw_event_id: row.id, body_hash: bodyHash, size: req.rawBody.length }, 'webhook accepted');
    return res.status(200).json({ ok: true, raw_event_id: row.id });
  } catch (err) {
    req.log.error({ err: err.message }, 'failed to persist raw event');
    // Returning 500 prompts the vendor to retry, which is the correct
    // behavior — better a duplicate (which we'll dedupe) than data loss.
    return res.status(500).json({ error: 'persist_failed' });
  }
});

// Convenience read endpoints for the replay harness and ad-hoc inspection.
// In production these would be authenticated and behind a separate read API.
app.get('/shipments', async (_req, res) => {
  const rows = await Shipment.findAll({
    include: [{ model: ShipmentEvent, as: 'events', separate: true, order: [['event_at', 'ASC']] }],
    order: [['id', 'ASC']],
  });
  res.json(rows);
});

app.get('/invoices', async (_req, res) => {
  const rows = await Invoice.findAll({
    include: [{ model: InvoiceEvent, as: 'events', separate: true, order: [['event_at', 'ASC']] }],
    order: [['id', 'ASC']],
  });
  res.json(rows);
});

app.get('/raw-events', async (_req, res) => {
  const rows = await RawEvent.findAll({ order: [['id', 'ASC']], limit: 100 });
  res.json(rows);
});

// Last-resort error handler.
app.use((err, req, res, _next) => {
  (req.log || logger).error({ err: err.message, stack: err.stack }, 'unhandled error');
  res.status(500).json({ error: 'internal_error' });
});

function pickSafeHeaders(headers) {
  // Persist a small allowlist for debugging. Vendor signature headers go here
  // so we can re-verify offline; nothing sensitive about request internals.
  const allow = ['x-vendor', 'x-signature', 'x-request-id', 'user-agent', 'content-type'];
  const out = {};
  for (const k of allow) if (headers[k]) out[k] = headers[k];
  return out;
}

async function start() {
  // Fail loud at startup if the DB isn't reachable — better than serving
  // requests that all 500.
  await sequelize.authenticate();
  logger.info('db connection ok');

  const server = app.listen(config.port, () => {
    logger.info({ port: config.port }, 'api listening');
  });

  // Graceful shutdown: stop accepting new connections, let in-flight finish.
  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down api');
    server.close(() => {
      sequelize.close().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

if (require.main === module) {
  start().catch((err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'failed to start api');
    process.exit(1);
  });
}

module.exports = { app };
