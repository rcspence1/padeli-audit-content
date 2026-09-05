#!/usr/bin/env node
/**
 * Unified dead-link writer: replaces each verified dead→fix pair wherever it
 * appears — body content AND the four booking/website meta fields
 * (_booking_link, _website, _playtomic_url, _direct_booking_url) — preserving
 * field semantics (a dead URL is fixed in the exact field it lives in).
 *
 * Safety: snapshots the wipe-protected Listeo meta, but OVERRIDES the snapshot
 * for any field this run intentionally changes, so the wipe-refill guard can
 * never revert an intended fix back to a dead value. Verifies _place_id / region
 * / _listing_type are untouched.
 *
 *   node write-all-fixes.js reports/fix-mapping-judgment.json          # DRY RUN
 *   node write-all-fixes.js reports/fix-mapping-judgment.json --apply
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
const META_FIELDS = ['_booking_link', '_website', '_playtomic_url', '_direct_booking_url'];

const mapPath = process.argv[2];
const APPLY = process.argv.includes('--apply');
const mapping = JSON.parse(fs.readFileSync(mapPath, 'utf8'));
const rows = mapping.rows.filter((r) => r.status === 'FIX' && r.fix);

const bySlug = {};
for (const r of rows) {
  const slug = r.listings[0].replace(/\/$/, '').split('/').pop();
  (bySlug[slug] ||= { slug, edits: [] }).edits.push({ dead: r.dead, fix: r.fix });
}

const slugToListing = async (slug) => {
  const arr = await wpGet(`/wp-json/wp/v2/listing?slug=${encodeURIComponent(slug)}&status=publish&context=edit`);
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
};
const applyEdits = (val, edits) => { let v = dec(val); for (const e of edits) if (v.includes(e.dead)) v = v.split(e.dead).join(e.fix); return v; };
// Normalize a URL for form-insensitive comparison (protocol / www / trailing slash).
const normUrl = (s) => dec(s).toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
// Meta values are whole URLs: match exact-substring first, else a form-variant whole-value match.
const applyMeta = (cur, edits) => {
  let v = dec(cur);
  for (const e of edits) {
    if (v.includes(e.dead)) v = v.split(e.dead).join(e.fix);
    else if (normUrl(v) === normUrl(e.dead)) v = e.fix;
  }
  return v;
};

(async () => {
  const out = [];
  const slugs = Object.keys(bySlug);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${rows.length} fixes across ${slugs.length} listings\n`);

  for (const slug of slugs) {
    const { edits } = bySlug[slug];
    const l = await slugToListing(slug);
    if (!l) { out.push({ slug, error: 'not found' }); console.log(`  ⁉️ ${slug} — not found`); continue; }
    const meta = l.meta || {};
    const body = dec(l.content && l.content.raw);
    const newBody = applyEdits(body, edits);
    const metaChanges = {};
    const where = [];
    for (const f of META_FIELDS) {
      const cur = dec(one(meta[f]));
      if (!cur) continue;
      const nv = applyMeta(cur, edits);
      if (nv !== cur) { metaChanges[f] = nv; where.push(f); }
    }
    const bodyChanged = newBody !== body;
    const changed = bodyChanged || where.length;

    if (!APPLY) {
      out.push({ slug, id: l.id, bodyChanged, metaFields: where, unmatched: edits.filter((e) => !body.includes(e.dead) && !META_FIELDS.some((f) => { const c = dec(one(meta[f])); return c.includes(e.dead) || normUrl(c) === normUrl(e.dead); })).map((e) => e.dead) });
      console.log(`  ${changed ? '✏️ ' : '· '} ${slug} (#${l.id}) — body:${bodyChanged ? 'y' : 'n'} meta:[${where.join(',') || '-'}]`);
      continue;
    }
    if (!changed) { out.push({ slug, id: l.id, noop: true }); console.log(`  · ${slug} noop`); continue; }

    // snapshot protected meta, then override snapshot for fields we intend to change
    const snap = snapshotProtectedMeta(l);
    for (const f of where) if (f in snap) snap[f] = metaChanges[f];

    const payload = {};
    if (bodyChanged) payload.content = newBody;
    if (where.length) payload.meta = metaChanges;
    await wpPost(`/wp-json/wp/v2/listing/${l.id}`, payload);
    await sleep(2200);
    let after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);

    // wipe-guard: refill any protected field Listeo emptied (using our intended values)
    const wiped = findWipedFields(snap, after);
    if (wiped.length) { const refill = {}; for (const k of wiped) refill[k] = snap[k]; await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: refill }); await sleep(1500); after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`); }

    // verify intended meta changes actually stuck; re-post any that didn't
    const am = after.meta || {};
    const stuckMiss = where.filter((f) => dec(one(am[f])) !== metaChanges[f]);
    if (stuckMiss.length) { const rep = {}; for (const f of stuckMiss) rep[f] = metaChanges[f]; await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: rep }); await sleep(1500); after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`); }

    const fBody = dec(after.content && after.content.raw);
    const fm = after.meta || {};
    const deadLeft = edits.filter((e) => fBody.includes(e.dead) || META_FIELDS.some((f) => dec(one(fm[f])).includes(e.dead))).map((e) => e.dead);
    const prot = ['_place_id', '_listing_type'].filter((k) => dec(one((l.meta || {})[k])) !== dec(one(fm[k])));
    if ((l.region || []).join(',') !== (after.region || []).join(',')) prot.push('region');
    out.push({ slug, id: l.id, body: bodyChanged, meta: where, wiped, deadLeft, protChanged: prot });
    console.log(`  ✅ ${slug} (#${l.id}) body:${bodyChanged ? 'y' : 'n'} meta:[${where.join(',')}] deadLeft:${deadLeft.length} prot:${prot.join('|') || 'clean'}`);
  }

  const outPath = path.join(path.dirname(mapPath), APPLY ? 'write-all-result.json' : 'write-all-dryrun.json');
  fs.writeFileSync(outPath, JSON.stringify({ apply: APPLY, at: new Date().toISOString(), out }, null, 2));
  const unresolved = out.flatMap((o) => o.unmatched || []);
  if (!APPLY && unresolved.length) console.log(`\n⚠️  ${unresolved.length} dead strings not found in body OR meta (may be theme-rendered / already changed).`);
  console.log(`\n${APPLY ? 'Result' : 'Dry run'}: ${outPath}`);
})();
