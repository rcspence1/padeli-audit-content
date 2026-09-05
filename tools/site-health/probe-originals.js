#!/usr/bin/env node
/**
 * Re-test every judgment-tier ORIGINAL dead URL in a real browser to separate
 * truly-dead links from checkUrl false-positives (SPA/WAF sites that 404 to a
 * server-side request but render fine to a browser — e.g. LTA ClubSpark).
 * Output: originals-verdict.json  { dead -> {live, status} }
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const DEAD_MARK = /(page not found|404 error|out of bounds|doesn'?t exist|no longer available|domain (is )?for sale|parked free|buy this domain|website coming soon|könnte nicht gefunden)/i;

async function probe(page, url) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 22000 });
    await page.waitForTimeout(1400);
    const status = r ? r.status() : null;
    const title = (await page.title().catch(() => '')) || '';
    const body = ((await page.locator('body').innerText().catch(() => '')) || '').slice(0, 220).replace(/\s+/g, ' ');
    // 403 = bot-blocked but host up → treat as "reachable" (our own rule); not a clear dead verdict
    const blocked = status === 403 || status === 429;
    const live = (status != null && status < 400 && !DEAD_MARK.test(title) && !DEAD_MARK.test(body)) || blocked;
    return { status, live, blocked, title: title.slice(0, 50) };
  } catch (e) { return { status: null, live: false, err: (e.message || '').slice(0, 40) }; }
}

(async () => {
  const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'reports', 'judgment-tier.json'), 'utf8'));
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ userAgent: UA });
  const page = await ctx.newPage();
  const verdict = {};
  let i = 0;
  for (const it of items) {
    i++;
    const v = await probe(page, it.dead);
    verdict[it.dead] = v;
    process.stdout.write(`${v.live ? (v.blocked ? '🟡' : '🟢') : '🔴'} [${i}/${items.length}] ${it.dead} (${v.status ?? 'err'})\n`);
  }
  await browser.close();
  fs.writeFileSync(path.join(__dirname, 'reports', 'originals-verdict.json'), JSON.stringify(verdict, null, 2));
  const live = Object.values(verdict).filter((v) => v.live && !v.blocked).length;
  const blocked = Object.values(verdict).filter((v) => v.blocked).length;
  const dead = Object.values(verdict).filter((v) => !v.live).length;
  console.log(`\nTruly dead: ${dead} | live (false-positives): ${live} | blocked-403/429 (ambiguous): ${blocked}`);
})();
