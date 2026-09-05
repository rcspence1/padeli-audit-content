#!/usr/bin/env node
/**
 * Quality-gate ALL draft listings (Mark Mac lane).
 *
 * Audits every draft with the calibrated auditor (G70/G71/M41, E08/E10/E33),
 * classifies by country, tiers by publish-readiness, and writes a fresh
 * per-country manifest. Read-only — no region tagging, no publishing, no Notion.
 *
 * WAF-aware: chunks of 5, inter-chunk gap, exponential backoff on 403/429.
 *
 * Standard: composite = QC 40% + Yoast 30% + Expert 30%
 *   publish-ready = score >= 80 AND zero blocking errors
 *   BPA tier      = score >= 85
 *
 * Usage:
 *   node scripts/gate-all-drafts.js
 *   node scripts/gate-all-drafts.js --limit 20   # smoke test
 */

const path = require('path');
const fs = require('fs');
const { auditSingleListing } = require(path.join(__dirname, '..', 'content-auditor'));
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

// Drafts with no Place ID — exclude per handover (can't enrich geo/reviews)
const NO_PLACE_ID = new Set([16671, 18639, 18545, 18439]);

const US_STATES = 'AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC';
const COUNTRY = a => {
  const s = String(a || '');
  if (/uae|dubai|abu dhabi|abu dabi|sharjah|ajman|ras al khaimah|umm al quwain|fujairah|al ain|united arab|khalifa city/i.test(s)) return 'AE';
  if (/australia|sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|queensland|new south wales|victoria|tasmania|western australia/i.test(s)) return 'AU';
  if (/united kingdom|england|scotland|wales|northern ireland|london|manchester|birmingham|liverpool|leeds|sheffield|bristol|glasgow|edinburgh|cardiff|belfast|cheshire|\bUK\b|\bGB\b|inggris raya/i.test(s)) return 'GB';
  // UK postcode pattern anywhere (e.g. "M3 7AQ", "NR10 4SB", "SY14 8HN") — distinctive enough to not false-positive on US
  if (/\b[A-Z]{1,2}\d{1,2}[A-Z]?\s+\d[A-Z]{2}\b/i.test(s)) return 'GB';
  if (/united states|\bUSA\b|new york|california|texas|florida|miami|los angeles|chicago|seattle|boston|atlanta|denver|phoenix|las vegas|austin|dallas|houston|san francisco|san diego|washington|\bNYC\b|maryland|virginia|arizona|utah|colorado|nevada|oregon|georgia/i.test(s)) return 'US';
  // US "STATE ZIP" near end (e.g. "TX 77407", "FL 33409", "PA 19123")
  if (new RegExp(`\\b(${US_STATES})\\s+\\d{5}(-\\d{4})?\\s*(,\\s*(USA|United States))?\\s*$`).test(s.trim())) return 'US';
  if (/indonesia|jakarta|bali|surabaya|bandung|denpasar|canggu|seminyak|ubud/i.test(s)) return 'ID';
  if (/españa|spain|madrid|barcelona|valencia|sevilla|malaga|bilbao|marbella/i.test(s)) return 'ES';
  if (/italia|italy|roma|\brome\b|milano|milan|napoli|torino|bologna/i.test(s)) return 'IT';
  if (/germany|deutschland|berlin|munich|münchen|hamburg|frankfurt|köln|cologne/i.test(s)) return 'DE';
  if (/france|paris|lyon|marseille|nice|toulouse|bordeaux/i.test(s)) return 'FR';
  if (/sweden|sverige|stockholm|gothenburg|göteborg|malmö/i.test(s)) return 'SE';
  if (/portugal|lisboa|lisbon|porto|cascais/i.test(s)) return 'PT';
  if (/thailand|bangkok|phuket|chiang mai|pattaya/i.test(s)) return 'TH';
  return 'OTHER';
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Audit with backoff on WAF (403/429)
async function auditWithBackoff(id, attempt = 0) {
  try {
    return await auditSingleListing(id, { skipLive: true, skipLinks: true });
  } catch (e) {
    const waf = /\b(403|429)\b/.test(e.message) || /just a moment|cloudflare/i.test(e.message);
    if (waf && attempt < 4) {
      const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s, 16s
      console.log(`   [backoff] #${id} hit WAF, waiting ${wait}ms (attempt ${attempt + 1})`);
      await sleep(wait);
      return auditWithBackoff(id, attempt + 1);
    }
    throw e;
  }
}

(async () => {
  const startedAt = new Date();
  const limitIdx = process.argv.indexOf('--limit');
  const limit = limitIdx >= 0 ? Number(process.argv[limitIdx + 1]) : Infinity;
  console.log(`[gate] Started ${startedAt.toISOString()}`);

  // 1. Fetch all draft IDs (paginated)
  const all = [];
  let page = 1;
  while (true) {
    const batch = await wpGet(`/wp-json/wp/v2/listing?status=draft&per_page=100&page=${page}&_fields=id,title,meta._address,meta._place_id`);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 20) break;
  }
  console.log(`[gate] Fetched ${all.length} drafts`);

  // 2. Classify + exclude no-place-id
  const targets = [];
  const excluded = [];
  for (const d of all) {
    const country = COUNTRY(d.meta?._address);
    const hasPlaceId = !!(d.meta?._place_id && String(d.meta._place_id).trim());
    if (NO_PLACE_ID.has(d.id) || !hasPlaceId) {
      excluded.push({ id: d.id, country, title: d.title?.rendered, reason: 'no _place_id' });
    } else {
      targets.push({ id: d.id, country, title: d.title?.rendered });
    }
  }
  const byCountry = targets.reduce((a, t) => { a[t.country] = (a[t.country] || 0) + 1; return a; }, {});
  console.log(`[gate] To audit: ${targets.length} | Excluded (no place_id): ${excluded.length}`);
  console.log(`[gate] By country: ${JSON.stringify(byCountry)}`);

  const queue = targets.slice(0, limit);
  // 3. Audit in chunks of 5 with inter-chunk gap
  const CHUNK = 5;
  const GAP_MS = 1500;
  const results = [];
  for (let i = 0; i < queue.length; i += CHUNK) {
    const chunk = queue.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(chunk.map(async t => {
      try {
        const r = await auditWithBackoff(t.id);
        const errCodes = (r.errors || []).map(e => (String(e).match(/^\[([A-Z0-9]+)\]/) || [])[1] || 'UNCODED');
        const yoastScore = r.yoast?.score ?? null;
        const expertScore = r.expert?.score ?? null;
        // content-quality = avg of Yoast + Expert (the SEO/content layers, excludes QC mechanical fields)
        const contentScore = (yoastScore != null && expertScore != null)
          ? Math.round((yoastScore + expertScore) / 2) : null;
        return {
          id: t.id, country: t.country, title: r.name || t.title,
          score: r.score ?? 0,
          yoastScore, expertScore, contentScore,
          errors: r.errors?.length ?? 0,
          warnings: r.warnings?.length ?? 0,
          errorCodes: errCodes,
          status: 'audited',
        };
      } catch (e) {
        return { id: t.id, country: t.country, title: t.title, status: 'error', error: e.message.slice(0, 80) };
      }
    }));
    results.push(...chunkResults);
    const done = Math.min(i + CHUNK, queue.length);
    if (done % 50 === 0 || done === queue.length) {
      console.log(`[gate] ${done}/${queue.length} audited`);
    }
    if (i + CHUNK < queue.length) await sleep(GAP_MS);
  }

  // 4. Tier + per-country manifest
  const audited = results.filter(r => r.status === 'audited');
  const errored = results.filter(r => r.status === 'error');
  const publishReady = audited.filter(r => r.score >= 80 && r.errors === 0);
  const bpa = publishReady.filter(r => r.score >= 85);

  const perCountry = {};
  for (const c of [...new Set(targets.map(t => t.country))]) {
    const set = audited.filter(r => r.country === c);
    const ready = set.filter(r => r.score >= 80 && r.errors === 0);
    perCountry[c] = {
      audited: set.length,
      avgScore: set.length ? Math.round(set.reduce((s, r) => s + r.score, 0) / set.length) : 0,
      publishReady: ready.length,
      bpa: ready.filter(r => r.score >= 85).length,
    };
  }

  const stamp = startedAt.toISOString().slice(0, 10);
  const manifest = publishReady.sort((a, b) => b.score - a.score);
  fs.writeFileSync(path.join(__dirname, '..', 'data', `gate-manifest-${stamp}.json`), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(__dirname, '..', 'data', `gate-full-results-${stamp}.json`), JSON.stringify({ results, excluded, perCountry }, null, 2));
  const csv = ['country,wp_id,title,score,errors,warnings'];
  manifest.forEach(r => csv.push(`${r.country},${r.id},"${String(r.title||'').replace(/"/g,'""')}",${r.score},${r.errors},${r.warnings}`));
  fs.writeFileSync(path.join(__dirname, '..', 'data', `gate-manifest-${stamp}.csv`), csv.join('\n'));

  // 5. Report
  console.log('\n=== QUALITY GATE SUMMARY ===');
  console.log(`Audited: ${audited.length} | Errors: ${errored.length} | Excluded (no place_id): ${excluded.length}`);
  console.log(`Publish-ready (≥80% + 0 errors): ${publishReady.length}`);
  console.log(`  of which BPA (≥85%): ${bpa.length}`);
  console.log('\nPer country (audited | avg | publish-ready | BPA):');
  Object.entries(perCountry).sort((a,b) => b[1].publishReady - a[1].publishReady).forEach(([c, s]) => {
    console.log(`  ${c.padEnd(6)}: ${String(s.audited).padStart(3)} | ${String(s.avgScore).padStart(3)}% | ready ${String(s.publishReady).padStart(3)} | BPA ${s.bpa}`);
  });
  if (errored.length) {
    console.log(`\nErrored (${errored.length}):`);
    errored.slice(0, 15).forEach(r => console.log(`  #${r.id} ${r.country} — ${r.error}`));
  }
  console.log(`\n[gate] Manifest: data/gate-manifest-${stamp}.json (+ .csv)`);
  console.log(`[gate] Finished ${new Date().toISOString()} (elapsed ${Math.round((Date.now()-startedAt.getTime())/1000)}s)`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
