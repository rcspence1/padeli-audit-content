#!/usr/bin/env node
/**
 * Place-ID dedup gate. The quality gate scores content but does NOT dedup against
 * already-live listings — so duplicates of live venues can slip through to publish
 * (the §4 2026-05-27 issue: 3/38 were dups of live). This bakes dedup into the gate.
 *
 * Builds a {place_id -> live id} map of all published listings, then checks draft
 * listings: any whose Google Place ID matches a live listing is a DupOfLive.
 *
 * Usage:
 *   node scripts/dedup-vs-live.js                 # dry-run, ALL drafts
 *   node scripts/dedup-vs-live.js --ids=11,22,33  # dry-run, specific drafts
 *   node scripts/dedup-vs-live.js --apply         # write Notion: Excluded + HoldReason=DupOfLive
 *
 * Env: PADELI_WP_USER, PADELI_WP_APP_PASSWORD, NOTION_API_KEY
 */
const WPU = process.env.PADELI_WP_USER, WPP = process.env.PADELI_WP_APP_PASSWORD, NK = process.env.NOTION_API_KEY;
const DB = '35bd1b51-fb30-8106-a719-ec603a1a3616';
const WPAUTH = Buffer.from(`${WPU}:${WPP}`).toString('base64');
const APPLY = process.argv.includes('--apply');
const IDS_ARG = (process.argv.find(a => a.startsWith('--ids=')) || '').slice(6);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function wp(path) {
  const r = await fetch('https://padeli.com/wp-json/wp/v2' + path, { headers: { Authorization: `Basic ${WPAUTH}`, 'User-Agent': 'Mozilla/5.0' } });
  return { status: r.status, total: r.headers.get('x-wp-total'), j: await r.json().catch(() => null) };
}
async function notion(method, path, body) {
  const r = await fetch('https://api.notion.com/v1' + path, { method, headers: { Authorization: `Bearer ${NK}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, j: await r.json().catch(() => null) };
}
const pidOf = m => { const v = (m || {})._place_id; return (Array.isArray(v) ? v[0] : v) || ''; };

async function findRow(wpId, placeId) {
  if (placeId) { const q = await notion('POST', `/databases/${DB}/query`, { filter: { property: 'Google Place ID', rich_text: { equals: placeId } }, page_size: 1 }); if (q.j?.results?.[0]) return q.j.results[0]; }
  if (wpId)    { const q = await notion('POST', `/databases/${DB}/query`, { filter: { property: 'WP Listing ID', number: { equals: wpId } }, page_size: 1 }); if (q.j?.results?.[0]) return q.j.results[0]; }
  return null;
}

(async () => {
  if (!WPU || !NK) { console.error('Missing PADELI_WP_USER / NOTION_API_KEY in env'); process.exit(1); }
  console.log(`Mode: ${APPLY ? 'APPLY (will write Notion)' : 'DRY-RUN'}\nBuilding live place_id map...`);
  const pub = {}; let page = 1;
  while (true) {
    const { status, j } = await wp(`/listing?status=publish&per_page=100&page=${page}&context=edit&_fields=id,meta`);
    if (status !== 200 || !Array.isArray(j) || !j.length) break;
    for (const it of j) { const p = pidOf(it.meta); if (p) pub[p] = pub[p] || it.id; }
    if (j.length < 100) break; page++; await sleep(1000);
  }
  console.log(`  live with place_id: ${Object.keys(pub).length}`);

  let drafts;
  if (IDS_ARG) drafts = IDS_ARG.split(',').map(s => +s.trim()).filter(Boolean).map(id => ({ id }));
  else {
    drafts = []; page = 1;
    while (true) {
      const { status, j } = await wp(`/listing?status=draft&per_page=100&page=${page}&context=edit&_fields=id,title,meta`);
      if (status !== 200 || !Array.isArray(j) || !j.length) break;
      drafts.push(...j); if (j.length < 100) break; page++; await sleep(1000);
    }
  }
  console.log(`  drafts to check: ${drafts.length}\n`);

  const dups = [], seen = {};
  for (const d of drafts) {
    let meta = d.meta, title = d.title?.raw;
    if (!meta) { const g = await wp(`/listing/${d.id}?context=edit&_fields=title,meta`); meta = g.j?.meta; title = g.j?.title?.raw; await sleep(150); }
    const pid = pidOf(meta); if (!pid) continue;
    let dupOf = null;
    if (pub[pid] && pub[pid] !== d.id) dupOf = pub[pid];
    else if (seen[pid]) dupOf = seen[pid] + ' (within drafts)';
    else { seen[pid] = d.id; continue; }
    dups.push({ id: d.id, title: title || '', dupOf, pid });
    console.log(`  DUP: draft #${d.id} ${(title||'').slice(0,32)} == live #${dupOf}`);
    if (APPLY && typeof dupOf === 'number') {
      const row = await findRow(d.id, pid);
      if (row) {
        const prev = (row.properties?.Notes?.rich_text || []).map(t => t.plain_text).join('');
        const note = `Place-ID dup of live #${dupOf} (gate dedup ${new Date().toISOString().slice(0,10)})`;
        const u = await notion('PATCH', `/pages/${row.id}`, { properties: {
          Status: { select: { name: 'Excluded' } },
          'Hold Reason': { multi_select: [{ name: 'DupOfLive' }] },
          Notes: { rich_text: [{ text: { content: (prev ? prev + '; ' : '') + note } }] },
        }});
        console.log(`     -> Notion ${u.status === 200 ? 'tagged Excluded+DupOfLive' : 'ERR ' + u.status}`);
        await sleep(280);
      } else console.log('     -> no Notion row found');
    }
  }
  console.log(`\n=== ${dups.length} duplicate draft(s) of live listings ===`);
  if (!APPLY && dups.length) console.log('Re-run with --apply to tag them Excluded + HoldReason=DupOfLive in Notion.');
})();
