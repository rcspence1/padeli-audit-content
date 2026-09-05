#!/usr/bin/env node
/**
 * Apply verified dead-link fixes to WP listing bodies via exact string replacement.
 * Reuses the bodyfix.js safety pattern: snapshot LISTEO protected meta, write body,
 * verify protected fields unchanged, refill any Listeo wiped during save_post.
 *
 * Precise by construction: replaces the EXACT verified dead URL with the EXACT
 * verified fix — never a regex — so it can only change what Stage 1 confirmed.
 *
 *   node write-fixes.js reports/fix-mapping-playtomic.json           # DRY RUN
 *   node write-fixes.js reports/fix-mapping-playtomic.json --apply   # write
 *
 * Requires PADELI_PROJECT_DIR (padeli-notion) + WP creds (source ~/.padeli-env).
 */
const fs = require('fs');
const path = require('path');
const PDIR = process.env.PADELI_PROJECT_DIR;
if (!PDIR) { console.error('Set PADELI_PROJECT_DIR to the padeli-notion repo.'); process.exit(1); }
const { wpGet, wpPost } = require(PDIR + '/lib/wp-client');
const { snapshotProtectedMeta, findWipedFields } = require(PDIR + '/lib/wp-payload.js');

const mapPath = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!mapPath) { console.error('Usage: node write-fixes.js <mapping.json> [--apply]'); process.exit(1); }
const mapping = JSON.parse(fs.readFileSync(mapPath, 'utf8'));

// Clean, approved batch: single-listing verified fixes only (excludes the 91474bfc catch-all ×10).
const rows = mapping.rows.filter((r) => r.status === 'FIX' && r.fix && r.listings.length === 1);

// Group edits by listing slug: slug -> [{dead, fix}]
const bySlug = {};
for (const r of rows) {
  const slug = r.listings[0].replace(/\/$/, '').split('/').pop();
  (bySlug[slug] ||= []).push({ dead: r.dead, fix: r.fix });
}

const slugToId = async (slug) => {
  const arr = await wpGet(`/wp-json/wp/v2/listing?slug=${encodeURIComponent(slug)}&status=publish&context=edit`);
  return Array.isArray(arr) && arr[0] ? arr[0] : null;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const out = [];
  const slugs = Object.keys(bySlug);
  console.log(`${APPLY ? 'APPLYING' : 'DRY RUN'} — ${rows.length} fixes across ${slugs.length} listings\n`);

  for (const slug of slugs) {
    const edits = bySlug[slug];
    const l = await slugToId(slug);
    if (!l) { out.push({ slug, error: 'listing not found' }); console.log(`  ⁉️  ${slug} — not found`); continue; }
    const body = String((l.content && l.content.raw) || '');
    let newBody = body;
    const applied = [];
    for (const e of edits) {
      if (newBody.includes(e.dead)) { newBody = newBody.split(e.dead).join(e.fix); applied.push(e); }
    }
    const changed = newBody !== body;

    if (!APPLY) {
      out.push({ slug, id: l.id, wouldChange: changed, matched: applied.length, ofEdits: edits.length, missing: edits.filter((e) => !applied.includes(e)).map((e) => e.dead) });
      console.log(`  ${changed ? '✏️ ' : '· '} ${slug} (#${l.id}) — ${applied.length}/${edits.length} dead link(s) matched`);
      continue;
    }
    if (!changed) { out.push({ slug, id: l.id, noop: true, note: 'dead string not present (already fixed?)' }); console.log(`  · ${slug} (#${l.id}) — noop`); continue; }

    const snap = snapshotProtectedMeta(l);
    await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { content: newBody });
    await sleep(2500);
    let after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    const wiped = findWipedFields(snap, after);
    if (wiped.length) {
      const refill = {}; for (const k of wiped) refill[k] = snap[k];
      await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: refill });
      await sleep(1500);
      after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    }
    const fBody = String((after.content && after.content.raw) || '');
    const stillDead = applied.filter((e) => fBody.includes(e.dead)).map((e) => e.dead);
    const rec = { slug, id: l.id, applied: applied.length, wipedThenRefilled: wiped, stillDead };
    out.push(rec);
    console.log(`  ✅ ${slug} (#${l.id}) — fixed ${applied.length}, wiped=${wiped.length}, stillDead=${stillDead.length}`);
  }

  const outPath = path.join(path.dirname(mapPath), APPLY ? 'write-result.json' : 'write-dryrun.json');
  fs.writeFileSync(outPath, JSON.stringify({ apply: APPLY, at: new Date().toISOString(), out }, null, 2));
  console.log(`\n${APPLY ? 'Result' : 'Dry run'}: ${outPath}`);
})();
