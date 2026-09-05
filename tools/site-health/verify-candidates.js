#!/usr/bin/env node
/**
 * Ground-truth every proposed fix in a real browser before it can be written.
 * Loads each proposedUrl in Chromium, judges live vs dead/parked/404, and (for
 * LTA + flagged false-positives) also re-tests the ORIGINAL dead URL to settle
 * whether the crawler's checkUrl false-positived.
 * Output: judgment-verified.json
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEAD_MARK = /(page not found|404 error|out of bounds|doesn'?t exist|no longer available|domain (is )?for sale|parked free|buy this domain|website coming soon)/i;

async function probe(page, url) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(1500);
    const status = r ? r.status() : null;
    const title = (await page.title().catch(() => '')) || '';
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 200).replace(/\s+/g, ' ');
    const live = status != null && status < 400 && !DEAD_MARK.test(title) && !DEAD_MARK.test(body);
    return { status, title: title.slice(0, 60), snippet: body.slice(0, 80), live };
  } catch (e) { return { status: null, live: false, err: e.message }; }
}

(async () => {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'reports', 'judgment-resolved.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();

  // 1) verify every proposed fix
  const cache = {};
  let i = 0;
  for (const r of rows) {
    i++;
    if (r.action === 'remove' || !r.proposedUrl) { r.verify = { skipped: 'remove/none' }; continue; }
    if (cache[r.proposedUrl]) { r.verify = cache[r.proposedUrl]; continue; }
    const v = await probe(page, r.proposedUrl);
    cache[r.proposedUrl] = v; r.verify = v;
    process.stdout.write(`${v.live ? '✅' : '❌'} [${i}/${rows.length}] ${r.proposedUrl}  (${v.status})${v.live ? '' : '  ⟵ agent said ' + r.action}\n`);
  }

  // 2) settle the LTA / flagged-false-positive question: re-test the ORIGINAL dead URLs in-browser
  const recheck = [...new Set(rows.filter((r) => /clubspark\.lta\.org\.uk|craigmillarparktennis/.test(r.dead)).map((r) => r.dead))];
  const origLive = {};
  console.log('\n── re-testing original "dead" URLs in real browser ──');
  for (const u of recheck) { const v = await probe(page, u); origLive[u] = v; console.log(`${v.live ? '🟢 LIVE' : '🔴 dead'} ${u} (${v.status})`); }

  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'reports', 'judgment-verified.json'), JSON.stringify({ rows, origLive }, null, 2));

  const bad = rows.filter((r) => r.proposedUrl && r.verify && r.verify.live === false);
  console.log(`\nProposed fixes that FAILED my browser check: ${bad.length}`);
  for (const r of bad) console.log(`  ✗ ${r.club}: ${r.proposedUrl} (${r.verify.status})`);
  const falsePos = Object.entries(origLive).filter(([, v]) => v.live).map(([u]) => u);
  console.log(`\nOriginal "dead" URLs that are actually LIVE in-browser (checkUrl false-positives): ${falsePos.length}/${recheck.length}`);
})();
