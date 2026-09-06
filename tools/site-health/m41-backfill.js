#!/usr/bin/env node
/**
 * M41 backfill — clear booking-SOURCE markers that were filled with the venue's
 * website.
 *
 * Root cause: create-listing.js:821-823 set `_direct_booking_url = venue.website`
 * as a "secondary booking path". `_website` is informational; the booking fields
 * are actions. Fixed at source 2026-09-05 (padeli-notion 21bc8d9); this script
 * repairs the listings already published with it.
 *
 * ONLY clears a field when it is byte-equal to `_website`. Never touches
 * `_booking_link` (the action URL), never touches `_website`, never touches body
 * content. A venue with no booking URL should have an EMPTY `_direct_booking_url`,
 * not its homepage.
 *
 * Deliberately does NOT act on `_booking_link === _website` alone — venues whose
 * only web presence IS their booking page (ayo.co.id, linktr.ee) are legitimately
 * in that state. Those are M41 warnings, not errors.
 *
 * Safety, following remove-deadlinks.js (the proven-safe pattern):
 *   - snapshotProtectedMeta() before the write
 *   - re-GET with a cache-buster after
 *   - findWipedFields() -> auto-refill anything Listeo dropped
 *   - verify _place_id / _listing_type unchanged
 *   - --limit N for canary / trial-on-N before the full batch
 *
 *   node m41-backfill.js                      # DRY RUN (default, no writes)
 *   node m41-backfill.js --limit 1 --apply    # canary
 *   node m41-backfill.js --apply              # full batch
 */
const fs = require('fs');
const path = require('path');
const PDIR = process.env.PADELI_PROJECT_DIR;
if (!PDIR) { console.error('Set PADELI_PROJECT_DIR'); process.exit(1); }
const { wpGet, wpPost } = require(PDIR + '/lib/wp-client');
const { snapshotProtectedMeta, findWipedFields } = require(PDIR + '/lib/wp-payload.js');

const one = (v) => (Array.isArray(v) ? v[0] : v);
const dec = (s) => String(s == null ? '' : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APPLY = process.argv.includes('--apply');
const LIMIT = (() => { const i = process.argv.indexOf('--limit'); return i > -1 ? parseInt(process.argv[i + 1], 10) : null; })();
const PLAN = process.env.M41_PLAN || '/tmp/m41-backfill-plan.json';
const SOURCE_MARKERS = ['_direct_booking_url', '_playtomic_url'];

(async () => {
  let plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  if (LIMIT) plan = plan.slice(0, LIMIT);
  console.log(`M41 backfill — ${plan.length} listing(s), ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  const out = [];
  for (const item of plan) {
    const l = await wpGet(`/wp-json/wp/v2/listing/${item.id}?context=edit&t=${Date.now()}`);
    if (!l || !l.id) { out.push({ id: item.id, error: 'not found' }); console.log(`  ⁉️  ${item.id} not found`); continue; }
    const meta = l.meta || {};
    const website = dec(one(meta._website)).trim();

    // Re-derive from LIVE state, never trust the plan file — the site may have
    // changed since the scan.
    const metaChanges = {};
    for (const f of SOURCE_MARKERS) {
      const cur = dec(one(meta[f])).trim();
      if (website && cur && cur === website) metaChanges[f] = '';
    }

    if (!Object.keys(metaChanges).length) {
      out.push({ id: l.id, slug: l.slug, noop: true, reason: 'no field equals _website at write time' });
      console.log(`  ·   ${l.slug} (#${l.id}) — no longer matches, skipped`);
      continue;
    }

    if (!APPLY) {
      console.log(`  📋 ${l.slug} (#${l.id})`);
      console.log(`        _website              : ${website}`);
      for (const f of Object.keys(metaChanges)) {
        console.log(`        ${f.padEnd(22)}: ${dec(one(meta[f])).trim()}`);
        console.log(`        ${''.padEnd(22)}  ->  (cleared)`);
      }
      console.log(`        _booking_link         : ${dec(one(meta._booking_link)).trim() || '(empty)'}  [UNTOUCHED]`);
      out.push({ id: l.id, slug: l.slug, website, clears: Object.keys(metaChanges), before: { _direct_booking_url: dec(one(meta._direct_booking_url)), _playtomic_url: dec(one(meta._playtomic_url)), _booking_link: dec(one(meta._booking_link)) } });
      continue;
    }

    const snap = snapshotProtectedMeta(l);
    for (const f of Object.keys(metaChanges)) if (f in snap) snap[f] = metaChanges[f];

    await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: metaChanges });
    await sleep(2000);
    let after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);

    const wiped = findWipedFields(snap, after).filter((k) => !(k in metaChanges));
    if (wiped.length) {
      const rf = {}; for (const k of wiped) rf[k] = snap[k];
      await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: rf });
      await sleep(1200);
      after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    }

    const fm = after.meta || {};
    const prot = ['_place_id', '_listing_type'].filter((k) => dec(one(meta[k])) !== dec(one(fm[k])));
    const stillSet = Object.keys(metaChanges).filter((f) => dec(one(fm[f])).trim() !== '');
    const websiteIntact = dec(one(fm._website)).trim() === website;
    const linkIntact = dec(one(fm._booking_link)).trim() === dec(one(meta._booking_link)).trim();

    out.push({ id: l.id, slug: l.slug, cleared: Object.keys(metaChanges), wipedAndRefilled: wiped, prot, stillSet, websiteIntact, linkIntact });
    const flag = prot.length || stillSet.length || !websiteIntact || !linkIntact ? '⚠️ ' : '✅';
    console.log(`  ${flag} ${l.slug} (#${l.id}) cleared:[${Object.keys(metaChanges).join(',')}] refilled:[${wiped.join(',') || '-'}] prot:${prot.join('|') || 'clean'} website:${websiteIntact ? 'intact' : 'CHANGED'} booking_link:${linkIntact ? 'intact' : 'CHANGED'}`);
    await sleep(800);
  }

  const rp = path.join(__dirname, 'reports', APPLY ? 'm41-backfill-result.json' : 'm41-backfill-dryrun.json');
  fs.writeFileSync(rp, JSON.stringify(out, null, 2));
  console.log(`\n${APPLY ? 'Applied' : 'Dry run'}. ${out.length} listing(s) -> ${rp}`);
  if (APPLY) {
    const bad = out.filter((o) => (o.prot && o.prot.length) || (o.stillSet && o.stillSet.length) || o.websiteIntact === false || o.linkIntact === false);
    console.log(bad.length ? `  ⚠️  ${bad.length} listing(s) need review` : '  All writes verified clean.');
  }
})();
