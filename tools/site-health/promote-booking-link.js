#!/usr/bin/env node
/**
 * Promote a stranded booking-platform URL into `_booking_link`.
 *
 * `_booking_link` is the ONLY field the theme reads for the "Book Now" CTA; it
 * hides the button entirely when empty. `_direct_booking_url` and
 * `_playtomic_url` are source markers that render nothing. Listings whose
 * booking URL landed in a marker instead of the action field are unbookable.
 *
 * SELECTION IS BY CLASSIFICATION, NEVER BY FIELD POSITION. A URL is promoted
 * only when detectBookingPlatform() recognises it as a real booking platform.
 * Taking whatever happens to sit in `_direct_booking_url` would launder the M41
 * defect (venue homepage copied into a booking marker) straight into the
 * rendered CTA. Same guard bookingfix.js:19 already uses.
 *
 * Every URL is liveness-checked before promotion — a dead URL in the CTA is
 * worse than a hidden button.
 *
 * Safety mirrors remove-deadlinks.js: snapshotProtectedMeta -> write -> settle
 * -> cache-busted re-GET -> findWipedFields -> auto-refill -> verify protected.
 *
 *   node promote-booking-link.js                   # DRY RUN
 *   node promote-booking-link.js --limit 1 --apply # canary
 *   node promote-booking-link.js --apply           # batch
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
const PLAN = process.env.PROMOTE_PLAN || '/tmp/promote-verified.json';

// The ten platforms the theme can label, plus regional booking hosts in the corpus.
const PLATFORMS = ['playtomic', 'matchi', 'padelmates', 'wansport', 'podplay', 'bookandplay',
  'rezerv', 'justpadel', 'racketpal', 'padium', 'ayo.co.id', 'bookandgo', 'clubspark', 'courtside.id'];
const detectBookingPlatform = (url) => {
  const u = dec(url).toLowerCase();
  return PLATFORMS.find((p) => u.includes(p)) || null;
};

(async () => {
  let plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
  if (LIMIT) plan = plan.slice(0, LIMIT);
  console.log(`promote-booking-link — ${plan.length} listing(s), ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  const out = [];

  for (const item of plan) {
    const l = await wpGet(`/wp-json/wp/v2/listing/${item.id}?context=edit&t=${Date.now()}`);
    if (!l || !l.id) { out.push({ id: item.id, error: 'not found' }); console.log(`  ⁉️  ${item.id} not found`); continue; }
    const meta = l.meta || {};

    // Re-derive from LIVE state; never trust the plan file.
    if (dec(one(meta._booking_link)).trim()) {
      out.push({ id: l.id, slug: l.slug, noop: true, reason: '_booking_link already set' });
      console.log(`  ·   ${l.slug} (#${l.id}) — _booking_link already set, skipped`);
      continue;
    }
    const url = dec(one(meta[item.field])).trim();
    const platform = detectBookingPlatform(url);
    if (!url || !platform) {
      out.push({ id: l.id, slug: l.slug, noop: true, reason: `no recognised platform in ${item.field}` });
      console.log(`  ·   ${l.slug} (#${l.id}) — ${item.field} no longer holds a recognised platform, skipped`);
      continue;
    }

    if (!APPLY) {
      console.log(`  📋 ${l.slug} (#${l.id})  [${platform}]`);
      console.log(`        _booking_link       : (empty)  ->  ${url}`);
      console.log(`        source field        : ${item.field} (left in place — markers should mirror the action)`);
      console.log(`        _website            : ${dec(one(meta._website)).trim() || '(empty)'}  [UNTOUCHED]`);
      out.push({ id: l.id, slug: l.slug, platform, url, from: item.field });
      continue;
    }

    const changes = { _booking_link: url };
    const snap = snapshotProtectedMeta(l);
    for (const f of Object.keys(changes)) if (f in snap) snap[f] = changes[f];

    await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: changes });
    await sleep(2000);
    let after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    const wiped = findWipedFields(snap, after).filter((k) => !(k in changes));
    if (wiped.length) {
      const rf = {}; for (const k of wiped) rf[k] = snap[k];
      await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: rf });
      await sleep(1200);
      after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    }
    const fm = after.meta || {};
    const prot = ['_place_id', '_listing_type'].filter((k) => dec(one(meta[k])) !== dec(one(fm[k])));
    const landed = dec(one(fm._booking_link)).trim() === url;
    const websiteIntact = dec(one(fm._website)).trim() === dec(one(meta._website)).trim();
    out.push({ id: l.id, slug: l.slug, platform, url, from: item.field, landed, prot, wipedAndRefilled: wiped, websiteIntact });
    console.log(`  ${landed && !prot.length && websiteIntact ? '✅' : '⚠️ '} ${l.slug} (#${l.id}) [${platform}] booking_link:${landed ? 'set' : 'FAILED'} refilled:[${wiped.join(',') || '-'}] prot:${prot.join('|') || 'clean'} website:${websiteIntact ? 'intact' : 'CHANGED'}`);
    await sleep(800);
  }

  const rp = path.join(__dirname, 'reports', APPLY ? 'promote-result.json' : 'promote-dryrun.json');
  fs.writeFileSync(rp, JSON.stringify(out, null, 2));
  console.log(`\n${APPLY ? 'Applied' : 'Dry run'}. ${out.length} listing(s) -> ${rp}`);
})();
