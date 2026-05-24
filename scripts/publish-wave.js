#!/usr/bin/env node
/**
 * Staged publisher for top-200 manifest.
 *
 * Publishes draft listings in chunks of 5 with an inter-chunk delay for SEO-
 * safe pacing. Exits if any listing fails sanity check (missing booking_link,
 * geolocation, hero, or place_id). Skips listings flagged for manual review.
 *
 * Usage:
 *   node scripts/publish-wave.js --tier gold        # publish ≥90% GOLD listings (~25)
 *   node scripts/publish-wave.js --tier silver-hi   # publish 85-89%
 *   node scripts/publish-wave.js --tier silver-lo   # publish 80-84%
 *   node scripts/publish-wave.js --tier gold --dry-run
 *   node scripts/publish-wave.js --tier gold --gap 30   # 30s between chunks
 */

const path = require('path');
const fs = require('fs');
const { wpGet, wpPut } = require(path.join(__dirname, '..', 'wp-client'));
const { afterPublishPipeline } = require(path.join(__dirname, '..', 'notion-sync'));

// Listings to EXCLUDE from any wave — manual review required
const HOLD = new Set([
  17081, // Wigan Sports Club — opening year 1848
  18235, // Tennis England Club — name + 0800 phone + dupe slug
  18960, // Park Sports Regent's Park — suspicious Fri-only hours
  19485, // Padel39 East Austin — phone format issue
  17681, 17945, 18332, 18405, 19662, // empty phones
  18237, 14401, // instagram-as-website
  18701, // already published as test
]);

const TIER_RANGES = {
  'gold':      { min: 90, max: 100 },
  'silver-hi': { min: 85, max: 89 },
  'silver-lo': { min: 80, max: 84 },
};

async function sanityCheck(id) {
  const wp = await wpGet(`/wp-json/wp/v2/listing/${id}?context=edit`);
  const m = wp.meta || {};
  const issues = [];
  if (!m._booking_link || !String(m._booking_link).trim()) issues.push('_booking_link empty');
  if (!m._geolocation_lat || !m._geolocation_long) issues.push('geolocation empty');
  if (!wp.featured_media) issues.push('hero missing');
  if (!m._place_id) issues.push('_place_id missing');
  return { wp, issues };
}

async function publishOne(id) {
  const { wp, issues } = await sanityCheck(id);
  if (issues.length) {
    return { id, status: 'skip', reason: issues.join(', '), title: wp.title?.rendered };
  }
  const patch = { status: 'publish' };
  if (!wp.slug) patch.slug = wp.generated_slug;
  await wpPut(`/wp-json/wp/v2/listing/${id}`, patch);
  // Verify
  const after = await wpGet(`/wp-json/wp/v2/listing/${id}?context=edit&_fields=id,status,slug,link`);
  if (after.status !== 'publish') {
    return { id, status: 'error', reason: `status is ${after.status} after publish`, title: wp.title?.rendered };
  }
  // HEAD check
  let httpOk = false;
  try {
    const res = await fetch(after.link, { method: 'HEAD', headers: { 'User-Agent': 'Mozilla/5.0' } });
    httpOk = res.ok;
  } catch (e) { /* swallow */ }
  return {
    id, status: 'published', title: wp.title?.rendered,
    url: after.link, slug: after.slug, httpOk,
  };
}

(async () => {
  const args = process.argv.slice(2);
  const tier = (args[args.indexOf('--tier') + 1] || 'gold').toLowerCase();
  const dryRun = args.includes('--dry-run');
  const gapSec = Number(args[args.indexOf('--gap') + 1]) || 180; // default 3 min between chunks
  const range = TIER_RANGES[tier];
  if (!range) { console.error(`Unknown tier: ${tier}. Use gold/silver-hi/silver-lo`); process.exit(1); }

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'publish-manifest-top200-2026-05-19.json')));
  const candidates = manifest
    .filter(x => x.score >= range.min && x.score <= range.max)
    .filter(x => !HOLD.has(x.id))
    .sort((a, b) => b.score - a.score);

  console.log(`[publish-wave] Tier: ${tier} (${range.min}-${range.max}%)`);
  console.log(`[publish-wave] Candidates: ${candidates.length} (after excluding ${HOLD.size} held)`);
  console.log(`[publish-wave] Mode: ${dryRun ? 'DRY RUN' : 'LIVE PUBLISH'} | inter-chunk gap: ${gapSec}s`);
  console.log('');

  if (dryRun) {
    console.log('Would publish:');
    candidates.forEach((c, i) => console.log(`  ${i+1}. ${c.country} #${c.id} — ${c.score}% — ${c.title || ''}`));
    return;
  }

  const CHUNK = 5;
  const results = [];
  for (let i = 0; i < candidates.length; i += CHUNK) {
    const chunk = candidates.slice(i, i + CHUNK);
    const chunkNum = Math.floor(i / CHUNK) + 1;
    const totalChunks = Math.ceil(candidates.length / CHUNK);
    console.log(`=== CHUNK ${chunkNum}/${totalChunks} ===`);
    const chunkStart = Date.now();
    const chunkResults = await Promise.all(chunk.map(c => publishOne(c.id).catch(e => ({ id: c.id, status: 'error', reason: e.message }))));
    chunkResults.forEach(r => {
      const icon = r.status === 'published' ? (r.httpOk ? '✅' : '🟡') : r.status === 'skip' ? '⏭️ ' : '❌';
      const detail = r.status === 'published' ? r.url + (r.httpOk ? '' : ' (HEAD failed)') : r.reason;
      console.log(`${icon} #${r.id} ${r.title || ''} → ${detail}`);
      results.push(r);
    });
    console.log(`Chunk ${chunkNum} done in ${Math.round((Date.now() - chunkStart) / 1000)}s`);

    // Notion sync for this chunk (Club Tracker → Published + log)
    try {
      await afterPublishPipeline(chunkResults, { batch: true, waveLabel: `${tier}/chunk-${chunkNum}` });
    } catch (e) {
      console.log(`  [notion-sync] non-fatal: ${e.message}`);
    }

    if (i + CHUNK < candidates.length) {
      console.log(`...waiting ${gapSec}s before next chunk...\n`);
      await new Promise(r => setTimeout(r, gapSec * 1000));
    }
  }

  // Summary
  const published = results.filter(r => r.status === 'published').length;
  const skipped = results.filter(r => r.status === 'skip').length;
  const errors = results.filter(r => r.status === 'error').length;
  console.log('=== WAVE SUMMARY ===');
  console.log(`Published: ${published}`);
  console.log(`Skipped (sanity check failed): ${skipped}`);
  console.log(`Errors: ${errors}`);
  if (skipped) {
    console.log('\nSkipped (need fixing):');
    results.filter(r => r.status === 'skip').forEach(r => console.log(`  #${r.id} ${r.title} — ${r.reason}`));
  }

  fs.writeFileSync(
    path.join(__dirname, '..', 'data', `publish-wave-${tier}-${new Date().toISOString().slice(0,10)}.json`),
    JSON.stringify(results, null, 2)
  );
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
