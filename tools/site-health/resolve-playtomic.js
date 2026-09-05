#!/usr/bin/env node
/**
 * Playtomic dead-link resolver (Stage 1 — deterministic).
 * Reads the latest site-health crawl, pulls every dead Playtomic link, and for
 * any with a recoverable tenant UUID rebuilds the canonical served form
 * (app.playtomic.io/clubs/<uuid>) and VERIFIES it loads a real club page in a
 * real browser (the API is 403-blocked, so browser is the only ground truth).
 *
 * Output: fix-mapping-playtomic.json + a console table.
 *   status = FIX      → uuid recovered, app URL verified live → safe to write
 *            DEAD      → uuid recovered but app URL is 404 → club left Playtomic → remove
 *            NO-UUID   → slug-only, no uuid in URL → defer to Stage 2 (meta/fallback)
 *            BAD-URL   → malformed (data-entry error) → remove/replace
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const REPORTS = path.join(__dirname, 'reports');
const UUID_RE = /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

function latestReport() {
  const f = fs.readdirSync(REPORTS).filter((x) => /^site-health-.*\.json$/.test(x)).sort().pop();
  return require(path.join(REPORTS, f));
}

// Is a loaded app.playtomic.io/clubs page a REAL club, or the 404 "out of bounds" page?
async function verifyClub(page, url) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(2000);
    const status = r ? r.status() : null;
    const body = (await page.locator('body').innerText().catch(() => '')) || '';
    if (status >= 400 || /out of bounds|page not found|404/i.test(body)) return { live: false, status };
    return { live: true, status };
  } catch (e) { return { live: false, status: null, err: e.message }; }
}

(async () => {
  const report = latestReport();
  const dead = {}; // href -> Set(listingUrls)
  for (const p of report.all) for (const d of p.links.dead) (dead[d.href] ||= new Set()).add(p.url);
  const ptLinks = Object.entries(dead).filter(([h]) => /playtomic/i.test(h) || /books%20via%20playtomic/i.test(h));

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  const rows = [];

  for (const [href, set] of ptLinks) {
    const listings = [...set];
    const m = href.match(UUID_RE);
    if (/%20/.test(href) || !/^https?:\/\/(www\.)?playtomic\./i.test(href)) {
      rows.push({ dead: href, listings, uuid: null, fix: null, status: 'BAD-URL', note: 'malformed URL (data-entry error) — remove/replace' });
      continue;
    }
    if (!m) { rows.push({ dead: href, listings, uuid: null, fix: null, status: 'NO-UUID', note: 'slug-only; API 403 → recover uuid from listing meta in Stage 2' }); continue; }
    const uuid = m[0].toLowerCase();
    const fix = `https://app.playtomic.io/clubs/${uuid}`;
    const v = await verifyClub(page, fix);
    rows.push({ dead: href, listings, uuid, fix, status: v.live ? 'FIX' : 'DEAD', note: v.live ? `verified live (${v.status})` : `app URL ${v.status || 'err'} — club left Playtomic → remove`, sharedAcross: listings.length });
    process.stdout.write(`${v.live ? '✅ FIX ' : '❌ DEAD'} ${uuid}  (${listings.length} listing${listings.length > 1 ? 's' : ''})\n`);
  }

  await browser.close();
  const out = path.join(REPORTS, 'fix-mapping-playtomic.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), rows }, null, 2));

  const by = (s) => rows.filter((r) => r.status === s);
  console.log('\n──────── Playtomic resolution ────────');
  console.log(`FIX (verified live): ${by('FIX').length}   DEAD (remove): ${by('DEAD').length}   NO-UUID (stage 2): ${by('NO-UUID').length}   BAD-URL: ${by('BAD-URL').length}`);
  const multi = rows.filter((r) => r.listings.length > 1);
  if (multi.length) { console.log('\n⚠️  shared across multiple listings (check these are really the same club):'); for (const r of multi) console.log(`   ${r.status}  ${r.uuid || r.dead}  → ${r.listings.length} listings`); }
  console.log(`\nMapping: ${out}`);
})();
