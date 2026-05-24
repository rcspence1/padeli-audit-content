#!/usr/bin/env node
const path = require('path');
const { auditSingleListing } = require(path.join(__dirname, '..', 'content-auditor'));
const { afterAuditPipeline } = require(path.join(__dirname, '..', 'notion-sync'));
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

const isGB = a => /united kingdom|england|scotland|wales|northern ireland|london|manchester|birmingham|liverpool|leeds|sheffield|bristol|glasgow|edinburgh|cardiff|belfast|\bUK\b|\bGB\b/i.test(a);

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

  const gb = all.filter(d => isGB(d.meta?._address || '') || isGB(d.title?.rendered || ''));
  const targets = gb.map(d => ({ ...d, country: 'GB' }));
  console.log(`[batch] GB: ${gb.length}`);

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
      const score = r.score ?? r.composite ?? 'n/a';
      console.log(`[${idx}/${targets.length}] ${t.country} #${t.id} ${r.title || '?'} — score:${score} errors:${errs} warns:${warns} (${ms}ms)`);
      return { id: t.id, country: t.country, title: r.title, score, errors: errs, warnings: warns, status: 'audited' };
    } catch (e) {
      console.log(`[${idx}/${targets.length}] ${t.country} #${t.id} ERROR: ${e.message}`);
      return { id: t.id, country: t.country, status: 'error', error: e.message };
    }
  };

  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    const chunkNum = Math.floor(i / CHUNK) + 1;
    const totalChunks = Math.ceil(targets.length / CHUNK);
    console.log(`\n=== CHUNK ${chunkNum}/${totalChunks} (items ${i + 1}-${Math.min(i + CHUNK, targets.length)}) ===`);
    const chunkStart = Date.now();
    const chunkResults = await Promise.all(chunk.map((t, j) => auditOne(t, i + j + 1)));
    results.push(...chunkResults);
    console.log(`=== CHUNK ${chunkNum} done in ${Math.round((Date.now() - chunkStart) / 1000)}s ===`);
  }

  const audited = results.filter(r => r.status === 'audited');
  const errors = results.filter(r => r.status === 'error');
  const avg = arr => arr.length ? Math.round(arr.reduce((s, r) => s + (typeof r.score === 'number' ? r.score : 0), 0) / arr.length) : 0;
  console.log('');
  console.log('=== BATCH SUMMARY ===');
  console.log(`GB audited: ${audited.length} | avg score: ${avg(audited)}%`);
  console.log(`Errors: ${errors.length}`);
  console.log('');
  console.log('Publishable (0 errors):');
  audited.filter(r => r.errors === 0).sort((a, b) => b.score - a.score).forEach(r => {
    console.log(`  GB #${r.id} ${r.title} — score ${r.score}%, ${r.warnings} warnings`);
  });
  console.log('');
  console.log('Worst 10 by error count:');
  audited.sort((a, b) => b.errors - a.errors).slice(0, 10).forEach(r => {
    console.log(`  GB #${r.id} ${r.title} — ${r.errors} errors, ${r.warnings} warnings, score ${r.score}%`);
  });
  console.log('');
  console.log(`[batch] Finished ${new Date().toISOString()} (elapsed: ${Math.round((Date.now() - startedAt.getTime()) / 1000)}s)`);

  const fs = require('fs');
  fs.writeFileSync(path.join(__dirname, '..', 'data', `gb-audit-${startedAt.toISOString().slice(0, 10)}.json`), JSON.stringify(results, null, 2));
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
