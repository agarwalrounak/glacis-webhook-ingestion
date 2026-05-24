'use strict';

/**
 * Exponential backoff with full jitter, for transient processing failures.
 *
 * Attempts 1..N map to roughly: 5s, 20s, 80s, 320s, 1280s (~21 min) before
 * jitter. Jitter is uniform in [0.5x, 1.5x] of the base delay so a swarm
 * of failures doesn't synchronise their retries.
 */
function backoffSeconds(attempt) {
  const base = 5 * Math.pow(4, Math.max(0, attempt - 1));
  const jitter = 0.5 + Math.random();
  return Math.min(3600, Math.floor(base * jitter));
}

module.exports = { backoffSeconds };
