#!/usr/bin/env node
/**
 * Booking-link scan
 *
 * For each top-200 publish-ready listing, check:
 *   - _booking_link populated?
 *   - If empty, do _playtomic_url / _direct_booking_url have a value we
 *     can promote to _booking_link?
 *
 * Output: counts + an actionable patch list (no writes).
 */
const path = require('path');
const fs = require('fs');
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'publish-manifest-top200-2026-05-19.json')));
  console.log(`[scan] Checking _booking_link on ${manifest.length} top-200 listings...\n`);

  const empty = [];
  const fixable = [];
  const unfixable = [];
  const CHUNK = 10;
  for (let i = 0; i < manifest.length; i += CHUNK) {
    const batch = manifest.slice(i, i + CHUNK);
    await Promise.all(batch.map(async m => {
      try {
        const wp = await wpGet(`/wp-json/wp/v2/listing/${m.id}?context=edit&_fields=id,title,meta._booking_link,meta._playtomic_url,meta._direct_booking_url,meta._website`);
        const meta = wp.meta || {};
        const link = (meta._booking_link || '').trim();
        if (link) return;
        // empty
        empty.push(m.id);
        const promote = (meta._playtomic_url || '').trim() || (meta._direct_booking_url || '').trim();
        if (promote) fixable.push({ id: m.id, country: m.country, title: wp.title?.rendered, promote, fromField: meta._playtomic_url ? '_playtomic_url' : '_direct_booking_url' });
        else unfixable.push({ id: m.id, country: m.country, title: wp.title?.rendered, website: meta._website });
      } catch (e) { /* skip */ }
    }));
  }
  console.log('=== BOOKING-LINK SCAN — TOP 200 ===');
  console.log(`Empty _booking_link: ${empty.length}/200 (${Math.round(empty.length / 2)}%)`);
  console.log(`  Auto-fixable (have _playtomic_url or _direct_booking_url): ${fixable.length}`);
  console.log(`  Unfixable (no booking URL anywhere): ${unfixable.length}`);
  console.log('');
  if (fixable.length) {
    console.log('Auto-fixable (sample 20):');
    fixable.slice(0, 20).forEach(f => console.log(`  ${f.country} #${f.id} ${f.title} — promote ${f.fromField}: "${f.promote.slice(0, 70)}"`));
  }
  if (unfixable.length) {
    console.log('\nUnfixable — needs manual review:');
    unfixable.forEach(u => console.log(`  ${u.country} #${u.id} ${u.title} — only has _website: "${u.website || '(none)'}"`));
  }
  fs.writeFileSync(
    path.join(__dirname, '..', 'data', 'booking-link-scan.json'),
    JSON.stringify({ empty, fixable, unfixable }, null, 2)
  );
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
