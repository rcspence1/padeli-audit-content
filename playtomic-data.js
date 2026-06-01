/**
 * Shim — re-exports playtomic-data from the padeli-notion pipeline so both
 * repos share one source of truth for Playtomic API calls (court counts now,
 * peak price in Phase B).
 *
 * If you relocate padeli-notion, update PADELI_PROJECT_DIR env var or this path.
 */
const path = require('path');
const target = process.env.PADELI_PROJECT_DIR
  ? path.join(process.env.PADELI_PROJECT_DIR, 'lib', 'playtomic-data.js')
  : '/Users/ariaactivewear/Projects/padeli-notion/lib/playtomic-data.js';

module.exports = require(target);
