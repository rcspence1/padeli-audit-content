#!/usr/bin/env node
/**
 * Padeli site-health crawler
 * ---------------------------
 * Walks published listing pages on padeli.com in a real (headless) Chromium and
 * verifies, per page:
 *   1. the page actually renders (HTTP 200 + real listing DOM, not a 404/error shell)
 *   2. the booking CTA / "visit website" buttons are present and point somewhere
 *   3. every link on the page (booking, website, internal) resolves — reusing the
 *      auditor's fixed checkUrl (real Chrome UA, HEAD→GET fallback, 403/405/429 = live)
 * Screenshots every failing page and writes a JSON + console report.
 *
 * A real browser is the point: it renders JS, sends a real UA, and follows the
 * same redirects a human would — so it doesn't mis-flag live pages as broken the
 * way a bare HEAD probe did.
 *
 * Usage:
 *   node crawl.js                 # crawl every published listing
 *   node crawl.js --limit 20      # first 20 (quick sample)
 *   node crawl.js --region ae     # only /clubs/ae/... listings
 *   node crawl.js --url https://padeli.com/clubs/gb/london/the-hive/   # one page
 *   node crawl.js --headed        # watch it run
 *   node crawl.js --deep-links    # also load each EXTERNAL link in-browser (slower, catches JS-404s)
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { checkUrl } = require('../../content-auditor.js');

const SITE = 'https://padeli.com';
const OUT_DIR = path.join(__dirname, 'reports');
const SHOT_DIR = path.join(OUT_DIR, 'screenshots');
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ── args ──────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const CFG = {
  limit: opt('limit') ? parseInt(opt('limit'), 10) : Infinity,
  region: (opt('region') || '').toLowerCase(),
  singleUrl: opt('url'),
  headed: flag('headed'),
  deepLinks: flag('deep-links'),
  concurrency: parseInt(opt('concurrency', '2'), 10),
  delay: parseInt(opt('delay', '500'), 10), // ms pause between page loads per worker (politeness — padeli.com is Cloudflare-fronted and 429s under load)
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** page.goto with retry+backoff on 429/503 (rate-limit / temporary block). */
async function gotoWithRetry(page, url, tries = 4) {
  let resp = null;
  for (let i = 0; i < tries; i++) {
    resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const s = resp ? resp.status() : 0;
    if (s !== 429 && s !== 503) return resp;
    await sleep(1500 * Math.pow(2, i)); // 1.5s, 3s, 6s, 12s
  }
  return resp;
}

// ── sitemap enumeration (auth-free) ─────────────────────────────────────────────
function fetchText(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': CHROME_UA }, timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.destroy(); return resolve(fetchText(res.headers.location));
      }
      let body = ''; res.on('data', (c) => (body += c)); res.on('end', () => resolve(body));
    }).on('error', () => resolve('')).on('timeout', function () { this.destroy(); resolve(''); });
  });
}
const locs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);

async function getListingUrls() {
  if (CFG.singleUrl) return [CFG.singleUrl];
  const index = await fetchText(`${SITE}/sitemap_index.xml`);
  // listing sub-sitemaps: Listeo emits listing-sitemap*.xml (fall back to any sitemap that yields /clubs/ URLs)
  const subs = locs(index).filter((u) => /listing|clubs|sitemap/i.test(u));
  const urls = new Set();
  for (const sm of subs) {
    for (const u of locs(await fetchText(sm))) {
      if (/\/clubs\//.test(u)) urls.add(u.replace(/#.*$/, ''));
    }
    if (urls.size && subs.length > 6) break; // avoid pulling every category sitemap once we have listings
  }
  let list = [...urls];
  if (CFG.region) list = list.filter((u) => new RegExp(`/clubs/${CFG.region}/`).test(u));
  return list.slice(0, CFG.limit);
}

// ── per-page crawl ──────────────────────────────────────────────────────────────
const ERROR_MARKERS = [/page not found/i, /404/i, /nothing found/i, /no results/i, /error 404/i];

async function crawlPage(context, url) {
  const page = await context.newPage();
  const rec = { url, ok: true, status: null, title: '', problems: [], links: { total: 0, dead: [], warn: [] }, ctas: [] };
  try {
    const resp = await gotoWithRetry(page, url);
    rec.status = resp ? resp.status() : null;
    if (!resp || resp.status() >= 400) { rec.ok = false; rec.problems.push(`page HTTP ${rec.status}`); }
    rec.title = (await page.title()) || '';

    const bodyText = (await page.locator('body').innerText().catch(() => '')) || '';
    if (rec.status < 400 && ERROR_MARKERS.some((re) => re.test(rec.title))) {
      rec.ok = false; rec.problems.push(`error-marker in title: "${rec.title}"`);
    }
    // Listeo listing pages carry a listing title header; its absence on a 200 = shell/redirect
    const hasListingBody = await page.locator('.listeo_core-single-listing, .single-listing-title, h1.page-title, .listing-titlebar-title').count().catch(() => 0);
    if (rec.status < 400 && !hasListingBody && bodyText.length < 400) {
      rec.ok = false; rec.problems.push('no listing content rendered (possible empty/redirected page)');
    }

    // Collect CTAs (booking / website buttons) and all anchors
    const anchors = await page.$$eval('a[href]', (as) => as.map((a) => ({
      href: a.href,
      text: (a.textContent || '').trim().slice(0, 40),
      cls: a.className || '',
    })));
    const ctaRe = /book|booking|reserve|visit website|website|playtomic|check availability/i;
    for (const a of anchors) {
      if (ctaRe.test(a.text) || /book|btn/i.test(a.cls)) {
        if (/^https?:/.test(a.href)) rec.ctas.push({ text: a.text || a.cls, href: a.href });
      }
    }

    // Validate links: external + internal padeli links present in the page.
    const seen = new Set();
    const toCheck = anchors
      .map((a) => a.href)
      .filter((h) => /^https?:\/\//.test(h))
      .filter((h) => !/^https?:\/\/(www\.)?padeli\.com\/?(#|$)/.test(h)) // skip bare homepage/self
      .filter((h) => { const k = h.replace(/#.*$/, ''); if (seen.has(k)) return false; seen.add(k); return true; });
    rec.links.total = toCheck.length;

    for (const href of toCheck) {
      let verdict = await checkUrl(href);
      // deep mode: for external links, confirm in-browser (catches SPA/JS 404s that return a 200 shell)
      if (CFG.deepLinks && verdict.ok && !/padeli\.com/.test(href)) {
        const p2 = await context.newPage();
        try {
          const r2 = await p2.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          const t2 = (await p2.title().catch(() => '')) || '';
          if ((r2 && r2.status() >= 400) || /not found|404|no longer/i.test(t2)) {
            verdict = { url: href, ok: false, category: 'FAIL', status: r2 ? r2.status() : null, message: `in-browser dead (${r2 ? r2.status() : 'no resp'} / "${t2.slice(0, 30)}")` };
          }
        } catch (e) { /* keep http verdict */ } finally { await p2.close(); }
      }
      // Browser re-verify any http-flagged-dead link before reporting it. Many
      // SPA/WAF hosts (LTA ClubSpark, some venue sites) 404 to a server-side
      // request even with a real UA, but render 200 to a real browser. Without
      // this, those live links get mis-reported as dead. (Runbook §9 item 11b.)
      if (verdict.category === 'FAIL') {
        const p3 = await context.newPage();
        try {
          const r3 = await p3.goto(href, { waitUntil: 'domcontentloaded', timeout: 20000 });
          const t3 = (await p3.title().catch(() => '')) || '';
          const b3 = ((await p3.locator('body').innerText().catch(() => '')) || '').slice(0, 200);
          const s3 = r3 ? r3.status() : null;
          if (s3 != null && s3 < 400 && !/page not found|404 error|out of bounds|no longer available|domain (is )?for sale/i.test(t3 + ' ' + b3)) {
            verdict = { url: href, ok: true, category: 'PASS', status: s3, message: `HTTP ${s3} (browser-verified live; server-side check was a false-positive)` };
          }
        } catch (e) { /* keep FAIL */ } finally { await p3.close(); }
      }
      if (verdict.category === 'FAIL') rec.links.dead.push({ href, status: verdict.status, msg: verdict.message });
      else if (verdict.category === 'WARN') rec.links.warn.push({ href, status: verdict.status, msg: verdict.message });
    }
    if (rec.links.dead.length) { rec.ok = false; rec.problems.push(`${rec.links.dead.length} dead link(s)`); }

    if (!rec.ok) {
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const shot = path.join(SHOT_DIR, url.replace(/https?:\/\//, '').replace(/[^\w.-]+/g, '_') + '.png');
      await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
      rec.screenshot = shot;
    }
  } catch (err) {
    rec.ok = false; rec.problems.push(`crawl error: ${err.message}`);
  } finally {
    await page.close();
  }
  return rec;
}

// ── simple concurrency pool ──────────────────────────────────────────────────────
async function pool(items, n, worker) {
  const out = []; let i = 0;
  const run = async () => { while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, run));
  return out;
}

// ── main ─────────────────────────────────────────────────────────────────────────
(async () => {
  console.log('[site-health] enumerating listings from sitemap…');
  const urls = await getListingUrls();
  if (!urls.length) { console.error('No listing URLs found. Check sitemap or --region filter.'); process.exit(1); }
  console.log(`[site-health] ${urls.length} listing page(s) to crawl` + (CFG.deepLinks ? ' (deep-links ON)' : '') + `\n`);

  const browser = await chromium.launch({ headless: !CFG.headed });
  const context = await browser.newContext({ userAgent: CHROME_UA, viewport: { width: 1366, height: 900 } });

  let done = 0;
  const results = await pool(urls, CFG.concurrency, async (url) => {
    const r = await crawlPage(context, url);
    done++;
    const badge = r.ok ? '✅' : '❌';
    process.stdout.write(`${badge} [${done}/${urls.length}] ${url}${r.ok ? '' : '  — ' + r.problems.join('; ')}\n`);
    await sleep(CFG.delay); // politeness pause before this worker grabs the next page
    return r;
  });

  await browser.close();

  const bad = results.filter((r) => !r.ok);
  const deadLinkPages = results.filter((r) => r.links.dead.length);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = path.join(OUT_DIR, `site-health-${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    site: SITE, config: CFG,
    summary: { crawled: results.length, healthy: results.length - bad.length, failing: bad.length, pagesWithDeadLinks: deadLinkPages.length },
    failing: bad,
    all: results,
  }, null, 2));

  console.log('\n────────────────────────────────────────');
  console.log(`Crawled:   ${results.length}`);
  console.log(`Healthy:   ${results.length - bad.length}`);
  console.log(`Failing:   ${bad.length}`);
  if (bad.length) {
    console.log('\nFailing pages:');
    for (const r of bad) console.log(`  ✗ ${r.url}\n      ${r.problems.join('; ')}` + (r.links.dead.length ? `\n      dead: ${r.links.dead.map((d) => d.href).join(', ')}` : ''));
  }
  console.log(`\nReport: ${outPath}`);
  if (fs.existsSync(SHOT_DIR)) console.log(`Screenshots: ${SHOT_DIR}`);
  process.exit(bad.length ? 1 : 0);
})();
