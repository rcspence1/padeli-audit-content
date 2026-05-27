#!/usr/bin/env node
/**
 * Backfill historical audit SCORES into the Notion Club Tracker.
 * Before 2026-05-27 the Club Tracker had no `Audit Score` / `Last Audited`
 * properties, so syncAuditToClubTracker()'s writes were silently dropped by Notion.
 * Those fields now exist. This reads the local audit JSON outputs and pushes the
 * score onto each listing's Club Tracker row.
 *
 * Matches a row by WP Listing ID; if that's empty in Notion (common — many rows
 * never had it written), it resolves the listing's Google Place ID from WP and
 * matches on that, AND backfills the missing WP Listing ID.
 *
 * Reads: data/*-audit-*.json  (gb-audit-*, ae-au-audit-*, all-zones-audit-*, etc.)
 * Each entry shape: { id, country, title, score, errors, warnings, status }
 *
 * Usage:
 *   node scripts/backfill-scores.js            # dry-run (prints what it would do)
 *   node scripts/backfill-scores.js --apply    # write Audit Score + Last Audited
 *
 * Env: NOTION_API_KEY, PADELI_WP_USER, PADELI_WP_APP_PASSWORD
 */
const fs = require('fs'), path = require('path');
const NK = process.env.NOTION_API_KEY, WPU = process.env.PADELI_WP_USER, WPP = process.env.PADELI_WP_APP_PASSWORD;
const DB = '35bd1b51-fb30-8106-a719-ec603a1a3616';
const WPAUTH = Buffer.from(`${WPU}:${WPP}`).toString('base64');
const APPLY = process.argv.includes('--apply');
const DATA = path.join(__dirname, '..', 'data');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function notion(method, p, body) { const r = await fetch('https://api.notion.com/v1' + p, { method, headers: { Authorization: `Bearer ${NK}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, j: await r.json().catch(() => null) }; }
async function wpPlaceId(id) { const r = await fetch(`https://padeli.com/wp-json/wp/v2/listing/${id}?context=edit&_fields=meta`, { headers: { Authorization: `Basic ${WPAUTH}`, 'User-Agent': 'Mozilla/5.0' } }); const j = await r.json().catch(() => null); const v = j?.meta?._place_id; return (Array.isArray(v) ? v[0] : v) || ''; }

(async () => {
  if (!NK || !WPU) { console.error('Missing NOTION_API_KEY / PADELI_WP_USER in env'); process.exit(1); }
  // 1) gather scores from all audit JSON files; latest file date wins per id
  const files = fs.readdirSync(DATA).filter(f => /audit-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!files.length) { console.error(`No *-audit-YYYY-MM-DD.json files in ${DATA}`); process.exit(1); }
  const scores = {}; // id -> { score, date }
  for (const f of files) {
    const date = (f.match(/(\d{4}-\d{2}-\d{2})/) || [])[1];
    let arr; try { arr = JSON.parse(fs.readFileSync(path.join(DATA, f), 'utf8')); } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const r of arr) {
      if (typeof r.id !== 'number' || typeof r.score !== 'number') continue;
      if (!scores[r.id] || date >= scores[r.id].date) scores[r.id] = { score: r.score, date, errors: r.errors };
    }
  }
  const ids = Object.keys(scores).map(Number);
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY-RUN'} | files: ${files.length} | listings with numeric score: ${ids.length}\n`);

  let updated = 0, byPlace = 0, missing = 0, errs = 0;
  for (const id of ids) {
    const { score, date } = scores[id];
    let row = null, how = 'wpid';
    let q = await notion('POST', `/databases/${DB}/query`, { filter: { property: 'WP Listing ID', number: { equals: id } }, page_size: 1 });
    if (q.j?.results?.[0]) row = q.j.results[0];
    if (!row) {
      const pid = await wpPlaceId(id); await sleep(150);
      if (pid) { q = await notion('POST', `/databases/${DB}/query`, { filter: { property: 'Google Place ID', rich_text: { equals: pid } }, page_size: 1 }); if (q.j?.results?.[0]) { row = q.j.results[0]; how = 'placeid'; } }
    }
    if (!row) { missing++; console.log(`  #${id}: no Notion row (score ${score})`); await sleep(120); continue; }
    const props = { 'Audit Score': { number: score }, 'Last Audited': { date: { start: date } } };
    if (how === 'placeid' && row.properties?.['WP Listing ID']?.number == null) props['WP Listing ID'] = { number: id };
    if (APPLY) {
      const u = await notion('PATCH', `/pages/${row.id}`, { properties: props });
      if (u.status === 200) { updated++; if (how === 'placeid') byPlace++; } else { errs++; console.log(`  #${id}: PATCH ERR ${u.status}`); }
    } else { updated++; if (how === 'placeid') byPlace++; }
    if (updated % 25 === 0) console.log(`  ...${updated} processed`);
    await sleep(260);
  }
  console.log(`\n=== SUMMARY ===`);
  console.log(`  ${APPLY ? 'updated' : 'would update'}: ${updated}  (matched by place_id: ${byPlace})`);
  console.log(`  no Notion row: ${missing} | errors: ${errs}`);
  if (!APPLY) console.log('Re-run with --apply to write Audit Score + Last Audited.');
})();
