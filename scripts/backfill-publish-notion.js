#!/usr/bin/env node
/**
 * One-shot Notion backfill for listings that were published before
 * `afterPublishPipeline` was wired into publish-wave.js. Reads the
 * publish-wave-gold-*.json result file and syncs each published row to Notion.
 *
 * Usage:
 *   node scripts/backfill-publish-notion.js <wave-results-file>
 *   node scripts/backfill-publish-notion.js data/publish-wave-gold-2026-05-19.json
 */

const path = require('path');
const fs = require('fs');
const { afterPublishPipeline } = require(path.join(__dirname, '..', 'notion-sync'));

(async () => {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node scripts/backfill-publish-notion.js <wave-results-file>');
    process.exit(1);
  }
  const results = JSON.parse(fs.readFileSync(path.resolve(file), 'utf-8'));
  const published = results.filter(r => r.status === 'published');
  console.log(`[backfill] ${published.length} published listings in ${file}`);
  await afterPublishPipeline(published, { batch: true, waveLabel: 'gold/backfill' });
  console.log('[backfill] Done');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
