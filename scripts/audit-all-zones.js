#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { auditSingleListing } = require(path.join(__dirname, '..', 'content-auditor'));
const { afterAuditPipeline } = require(path.join(__dirname, '..', 'notion-sync'));
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

const matchers = {
  AE: a => /uae|dubai|abu dhabi|sharjah|ajman|ras al khaimah|umm al quwain|fujairah|al ain|united arab/i.test(a),
  AU: a => /australia|sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|queensland|new south wales|victoria|tasmania|western australia/i.test(a),
  GB: a => /united kingdom|england|scotland|wales|northern ireland|london|manchester|birmingham|liverpool|leeds|sheffield|bristol|glasgow|edinburgh|cardiff|belfast|\bUK\b|\bGB\b/i.test(a),
  US: a => /united states|\bUSA\b|new york|california|texas|florida|miami|los angeles|chicago|seattle|boston|atlanta|denver|phoenix|las vegas|austin|dallas|houston|san francisco|san diego|washington|nyc/i.test(a),
};

(async () => {
  const startedAt = new Date();
  console.log(`[batch] Started ${startedAt.toISOString()}`);

  const all = [];
  let page = 1;
  while (true) {
    const batch = await wpGet(`/wp-json/wp/v2/listing?status=draft&per_page=100&page=${page}`);
    if (!batch || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 100) break;
    page++;
    if (page > 20) break;
  }

  const targets = [];
  for (const d of all) {
    const addr = (d.meta?._address || '');
    const title = (d.title?.rendered || '');
    for (const [country, fn] of Object.entries(matchers)) {
      if (fn(addr) || fn(title)) {
        targets.push({ ...d, country });
        break;
      }
    }
  }
  const byCountry = targets.reduce((acc, t) => { acc[t.country] = (acc[t.country] || 0) + 1; return acc; }, {});
  console.log(`[batch] Total drafts: ${all.length}`);
  console.log(`[batch] By country: ${JSON.stringify(byCountry)} | Total to audit: ${targets.length}`);

  const results = [];
  const CHUNK = 5;
  const auditOne = async (t, idx) => {
    const t0 = Date.now();
    try {
      const r = await auditSingleListing(t.id, { skipLive: true });
      try { await afterAuditPipeline('listing', r); } catch (e) { /* notion errors non-fatal */ }
      const ms = Date.now() - t0;
      const errs = r.errors?.length || 0;
      const warns = r.warnings?.length || 0;
      const score = r.score ?? 'n/a';
      console.log(`[${idx}/${targets.length}] ${t.country} #${t.id} ${r.name || '?'} — score:${score} errors:${errs} warns:${warns} (${ms}ms)`);
      return { id: t.id, country: t.country, title: r.name, score, errors: errs, warnings: warns, status: 'audited' };
    } catch (e) {
      console.log(`[${idx}/${targets.length}] ${t.country} #${t.id} ERROR: ${e.message}`);
      return { id: t.id, country: t.country, status: 'error', error: e.message };
    }
  };

  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const chunkNum = Math.floor(i / CHUNK) + 1;
    const totalChunks = Math.ceil(targets.length / CHUNK);
    const chunkStart = Date.now();
    const chunkResults = await Promise.all(chunk.map((t, j) => auditOne(t, i + j + 1)));
    results.push(...chunkResults);
    if (chunkNum % 10 === 0 || chunkNum === totalChunks) {
      console.log(`=== CHUNK ${chunkNum}/${totalChunks} done in ${Math.round((Date.now() - chunkStart) / 1000)}s ===`);
    }
  }

  // Per-country summary
  console.log('\n=== BATCH SUMMARY (CALIBRATED) ===');
  for (const country of Object.keys(matchers)) {
    const set = results.filter(r => r.country === country && r.status === 'audited');
    if (set.length === 0) continue;
    const avg = Math.round(set.reduce((s, x) => s + (x.score || 0), 0) / set.length);
    const gold = set.filter(x => x.errors === 0 && x.warnings === 0).length;
    const silver = set.filter(x => x.errors === 0 && x.warnings > 0).length;
    const ge80 = set.filter(x => x.score >= 80).length;
    const ge85 = set.filter(x => x.score >= 85).length;
    console.log(`${country}: ${set.length} audited | avg ${avg}% | GOLD: ${gold} | SILVER: ${silver} | ≥80%: ${ge80} | ≥85%: ${ge85}`);
  }
  const allAudited = results.filter(r => r.status === 'audited');
  const totalGold = allAudited.filter(x => x.errors === 0 && x.warnings === 0).length;
  const totalSilver = allAudited.filter(x => x.errors === 0 && x.warnings > 0).length;
  const totalGe80 = allAudited.filter(x => x.score >= 80).length;
  const totalZeroErr = allAudited.filter(x => x.errors === 0).length;
  console.log('');
  console.log(`TOTAL: ${allAudited.length} audited`);
  console.log(`  GOLD (0/0): ${totalGold}`);
  console.log(`  SILVER (0 err, has warnings): ${totalSilver}`);
  console.log(`  Zero-error pool: ${totalZeroErr}`);
  console.log(`  Score ≥80%: ${totalGe80}`);
  console.log(`  Errors: ${results.filter(r => r.status === 'error').length}`);
  console.log(`[batch] Finished ${new Date().toISOString()} (elapsed: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s)`);

  fs.writeFileSync(
    path.join(__dirname, '..', 'data', `all-zones-audit-${startedAt.toISOString().slice(0, 10)}.json`),
    JSON.stringify(results, null, 2)
  );
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
