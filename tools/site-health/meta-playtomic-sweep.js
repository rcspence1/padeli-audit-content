#!/usr/bin/env node
/**
 * Site-wide meta + body Playtomic canonicalization sweep.
 * The July bodyfix only swept body; dead-format Playtomic URLs still live in the
 * booking meta fields. This finds every listing whose body OR
 * _booking_link/_playtomic_url/_direct_booking_url contains a dead-format
 * Playtomic URL with a recoverable UUID, and rewrites it to the served form
 * https://app.playtomic.io/clubs/<uuid>. Slug-only URLs (no UUID, API-blocked)
 * are left untouched. Protected _place_id/region/_listing_type verified unchanged.
 *
 *   node meta-playtomic-sweep.js          # DRY RUN (counts + samples)
 *   node meta-playtomic-sweep.js --apply
 */
const fs = require('fs');
const path = require('path');
const PDIR = process.env.PADELI_PROJECT_DIR;
if (!PDIR) { console.error('Set PADELI_PROJECT_DIR'); process.exit(1); }
const A = require('../../content-auditor.js');
const { wpGet, wpPost } = require(PDIR + '/lib/wp-client');
const { snapshotProtectedMeta, findWipedFields } = require(PDIR + '/lib/wp-payload.js');
const one = (v) => (Array.isArray(v) ? v[0] : v);
const dec = (s) => String(s == null ? '' : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPLY = process.argv.includes('--apply');
const META_FIELDS = ['_booking_link', '_playtomic_url', '_direct_booking_url'];

const UUID = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
// A dead-format Playtomic URL = any playtomic.(io|com) URL that is NOT already the app.playtomic.io/clubs/<uuid> served form.
const DEAD_PT = /https?:\/\/(?:www\.)?playtomic\.(?:io|com)\/[^\s"'<)]+/gi;
function canon(u) {
  if (/app\.playtomic\.io\/clubs\//i.test(u)) return u;        // already canonical
  const m = u.match(UUID);
  if (m) return `https://app.playtomic.io/clubs/${m[0].toLowerCase()}`;
  return u;                                                    // slug-only → cannot canonicalize
}
const rewrite = (s) => dec(s).replace(DEAD_PT, (m) => canon(m));

(async () => {
  console.log('[sweep] fetching all published listings…');
  const all = await A.fetchAllListings({ status: 'publish', fullMeta: true });
  console.log(`[sweep] ${all.length} listings`);

  const hits = [];
  for (const l of all) {
    const meta = l.meta || {};
    const body = dec(l.content && (l.content.raw || l.content.rendered));
    const metaChanges = {};
    for (const f of META_FIELDS) { const cur = dec(one(meta[f])); if (!cur) continue; const nv = rewrite(cur); if (nv !== cur) metaChanges[f] = nv; }
    const newBody = rewrite(body);
    const bodyChanged = newBody !== body;
    if (bodyChanged || Object.keys(metaChanges).length) hits.push({ id: l.id, slug: l.slug, bodyChanged, metaChanges, l, newBody });
  }
  console.log(`\n[sweep] listings needing canonicalization: ${hits.length}`);
  const metaOnly = hits.filter((h) => Object.keys(h.metaChanges).length && !h.bodyChanged).length;
  const bodyOnly = hits.filter((h) => h.bodyChanged && !Object.keys(h.metaChanges).length).length;
  console.log(`  meta-only: ${metaOnly} | body-only: ${bodyOnly} | both: ${hits.length - metaOnly - bodyOnly}`);
  for (const h of hits.slice(0, 8)) console.log(`   ${h.slug} (#${h.id}) meta:[${Object.keys(h.metaChanges).join(',')||'-'}] body:${h.bodyChanged}`);

  if (!APPLY) { fs.writeFileSync(path.join(__dirname, 'reports', 'meta-sweep-dryrun.json'), JSON.stringify(hits.map((h) => ({ id: h.id, slug: h.slug, bodyChanged: h.bodyChanged, metaChanges: h.metaChanges })), null, 2)); console.log('\nDry run written. Re-run with --apply to write.'); return; }

  const out = [];
  for (const h of hits) {
    const snap = snapshotProtectedMeta(h.l);
    for (const f of Object.keys(h.metaChanges)) if (f in snap) snap[f] = h.metaChanges[f];
    const payload = {};
    if (h.bodyChanged) payload.content = h.newBody;
    if (Object.keys(h.metaChanges).length) payload.meta = h.metaChanges;
    await wpPost(`/wp-json/wp/v2/listing/${h.id}`, payload);
    await sleep(2000);
    let after = await wpGet(`/wp-json/wp/v2/listing/${h.id}?context=edit&t=${Date.now()}`);
    const wiped = findWipedFields(snap, after);
    if (wiped.length) { const rf = {}; for (const k of wiped) rf[k] = snap[k]; await wpPost(`/wp-json/wp/v2/listing/${h.id}`, { meta: rf }); await sleep(1200); after = await wpGet(`/wp-json/wp/v2/listing/${h.id}?context=edit&t=${Date.now()}`); }
    const fm = after.meta || {};
    const badLeft = [dec(after.content && after.content.raw), ...META_FIELDS.map((f) => dec(one(fm[f])))].join(' ').match(/playtomic\.(io\/tenant|com\/clubs\/tenant|io)\/[a-z0-9-]*[a-f0-9]{8}-/i) ? 1 : 0;
    const prot = ['_place_id', '_listing_type'].filter((k) => dec(one((h.l.meta || {})[k])) !== dec(one(fm[k])));
    if ((h.l.region || []).join(',') !== (after.region || []).join(',')) prot.push('region');
    out.push({ id: h.id, slug: h.slug, badLeft, prot });
    process.stdout.write(`  ✅ ${h.slug} (#${h.id}) badLeft:${badLeft} prot:${prot.join('|') || 'clean'}\n`);
  }
  fs.writeFileSync(path.join(__dirname, 'reports', 'meta-sweep-result.json'), JSON.stringify(out, null, 2));
  console.log(`\nApplied to ${out.length} listings. protChanged: ${out.filter((o) => o.prot.length).length}, badLeft>0: ${out.filter((o) => o.badLeft).length}`);
})();
