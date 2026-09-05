#!/usr/bin/env node
/**
 * Strip dead links that have NO live replacement (the REMOVE bucket): clear the
 * dead URL from booking/website meta fields and unwrap the dead anchor in body
 * (keep the link text, drop the href). Also handles DHM's junk _website
 * ("No dedicated website; books via Playtomic" text rendered as a broken link).
 *
 * Catch-all note: for the 91474bfc listings marked remove, this also strips the
 * canonicalized app.playtomic.io/clubs/91474bfc the meta-sweep may have written.
 *
 *   node remove-deadlinks.js          # DRY RUN
 *   node remove-deadlinks.js --apply
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
const META_FIELDS = ['_booking_link', '_website', '_playtomic_url', '_direct_booking_url'];
const normUrl = (s) => dec(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');

// REMOVE targets: slug → list of dead identifiers to strip (matched by substring or normalized-URL).
// Catch-all removes also strip the 91474bfc tenant in both dead + canonicalized form.
const CATCHALL = ['playtomic.io/tenant/91474bfc', 'app.playtomic.io/clubs/91474bfc-57ee-4c11-bda3-1bb091710f4d', 'playtomic.io/91474bfc'];
const TARGETS = {
  'elevon-sports-complex': ['playtomic.com/clubs/xpark-padel-academy-middle-east', 'app.playtomic.io/clubs/xpark'],
  'uaejj-fitness-al-nahda': ['playtomic.io/uaejj-fitness-al-nahda'],
  'brentwood-padel-club': ['playtomic.com/clubs/padel-123'], // redundant duplicate link only
  'fauget-padel-court': CATCHALL,
  'fluxion-padel-park-arena-hub': CATCHALL,
  'padel-spot': CATCHALL,
  'padel-ranch': CATCHALL,
  'ism-padel-the-manor-by-ja': ['ismsports.org/padel-tennis-the-manor-by-ja'],
  'abu-dhabi-country-club': ['adcountryclub.com'],
  'dhm-padel': ['__CLEAR_JUNK_WEBSITE__'], // special: _website holds literal placeholder text
};

const matches = (val, deads) => deads.some((d) => d !== '__CLEAR_JUNK_WEBSITE__' && (val.includes(d) || normUrl(val) === normUrl(d)));

(async () => {
  const out = [];
  for (const [slug, deads] of Object.entries(TARGETS)) {
    const arr = await wpGet(`/wp-json/wp/v2/listing?slug=${encodeURIComponent(slug)}&status=publish&context=edit`);
    const l = Array.isArray(arr) && arr[0];
    if (!l) { out.push({ slug, error: 'not found' }); console.log(`  ⁉️ ${slug}`); continue; }
    const meta = l.meta || {};
    const body = dec(l.content && l.content.raw);
    const metaChanges = {};

    // DHM: clear the junk placeholder _website text
    if (deads.includes('__CLEAR_JUNK_WEBSITE__')) {
      const w = dec(one(meta._website));
      if (/no dedicated website|books via playtomic/i.test(w)) metaChanges._website = '';
    }
    // Clear any meta field whose value is one of the dead targets
    for (const f of META_FIELDS) { const cur = dec(one(meta[f])); if (cur && matches(cur, deads)) metaChanges[f] = ''; }

    // Unwrap dead anchors in body: <a ...href="...DEAD...">TEXT</a> -> TEXT
    let newBody = body;
    for (const d of deads) {
      if (d === '__CLEAR_JUNK_WEBSITE__') continue;
      const re = new RegExp('<a\\b[^>]*href="[^"]*' + d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^"]*"[^>]*>([\\s\\S]*?)<\\/a>', 'gi');
      newBody = newBody.replace(re, '$1');
    }
    const bodyChanged = newBody !== body;
    const changed = bodyChanged || Object.keys(metaChanges).length;

    if (!APPLY) { out.push({ slug, id: l.id, bodyChanged, metaCleared: Object.keys(metaChanges) }); console.log(`  ${changed ? '🗑️ ' : '· '} ${slug} (#${l.id}) body:${bodyChanged} metaCleared:[${Object.keys(metaChanges).join(',') || '-'}]`); continue; }
    if (!changed) { out.push({ slug, id: l.id, noop: true }); console.log(`  · ${slug} noop`); continue; }

    const snap = snapshotProtectedMeta(l);
    for (const f of Object.keys(metaChanges)) if (f in snap) snap[f] = metaChanges[f];
    const payload = {}; if (bodyChanged) payload.content = newBody; if (Object.keys(metaChanges).length) payload.meta = metaChanges;
    await wpPost(`/wp-json/wp/v2/listing/${l.id}`, payload);
    await sleep(2000);
    let after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    const wiped = findWipedFields(snap, after).filter((k) => !(k in metaChanges)); // don't "refill" fields we intentionally cleared
    if (wiped.length) { const rf = {}; for (const k of wiped) rf[k] = snap[k]; await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: rf }); await sleep(1200); after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`); }
    const fm = after.meta || {};
    const prot = ['_place_id', '_listing_type'].filter((k) => dec(one((l.meta || {})[k])) !== dec(one(fm[k])));
    out.push({ slug, id: l.id, bodyChanged, metaCleared: Object.keys(metaChanges), prot });
    console.log(`  ✅ ${slug} (#${l.id}) stripped body:${bodyChanged} meta:[${Object.keys(metaChanges).join(',')}] prot:${prot.join('|') || 'clean'}`);
  }
  fs.writeFileSync(path.join(__dirname, 'reports', APPLY ? 'remove-result.json' : 'remove-dryrun.json'), JSON.stringify(out, null, 2));
  console.log(`\n${APPLY ? 'Applied' : 'Dry run'}.`);
})();
