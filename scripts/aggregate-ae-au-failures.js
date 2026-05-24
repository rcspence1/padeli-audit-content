#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { auditSingleListing } = require(path.join(__dirname, '..', 'content-auditor'));
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

const isAE = a => /uae|dubai|abu dhabi|sharjah|ajman|ras al khaimah|umm al quwain|fujairah|al ain|united arab/i.test(a);
const isAU = a => /australia|sydney|melbourne|brisbane|perth|adelaide|canberra|gold coast|queensland|new south wales|victoria|tasmania|western australia/i.test(a);

// parse "[CODE] message..." from plain string
const parseCode = s => {
  const m = String(s).match(/^\[([A-Z0-9]+)\]\s*(.*)/);
  return m ? { code: m[1], message: m[2] } : { code: 'UNCODED', message: String(s) };
};

(async () => {
  const startedAt = Date.now();
  console.log('[aggregate] Fetching draft list...');
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
  const ae = all.filter(d => isAE(d.meta?._address || '') || isAE(d.title?.rendered || ''));
  const au = all.filter(d => isAU(d.meta?._address || '') || isAU(d.title?.rendered || ''));
  const targets = [...ae.map(d => ({ ...d, country: 'AE' })), ...au.map(d => ({ ...d, country: 'AU' }))];
  console.log(`[aggregate] AE: ${ae.length} | AU: ${au.length} | Total: ${targets.length}`);

  const findings = []; // each = { country, id, severity, code, layer, message }
  const CHUNK = 5;

  const auditOne = async (t, idx) => {
    try {
      const r = await auditSingleListing(t.id, { skipLive: true, skipLinks: true });
      // QC errors + warnings (strings like "[S4] ...")
      for (const e of r.errors || []) {
        const { code, message } = parseCode(e);
        findings.push({ country: t.country, id: t.id, severity: 'error', code, layer: 'qc', message });
      }
      for (const w of r.warnings || []) {
        const { code, message } = parseCode(w);
        findings.push({ country: t.country, id: t.id, severity: 'warning', code, layer: 'qc', message });
      }
      // Yoast / Expert checks — failed only (pass:false)
      for (const c of r.yoast?.checks || []) {
        if (c.pass === false) findings.push({ country: t.country, id: t.id, severity: c.severity || 'warning', code: c.id, layer: 'yoast', message: c.message });
      }
      for (const c of r.expert?.checks || []) {
        if (c.pass === false) findings.push({ country: t.country, id: t.id, severity: c.severity || 'warning', code: c.id, layer: 'expert', message: c.message });
      }
      if ((idx % 25) === 0) console.log(`[${idx}/${targets.length}] running...`);
    } catch (e) {
      console.log(`[${idx}/${targets.length}] ${t.country} #${t.id} ERROR: ${e.message}`);
    }
  };

  for (let i = 0; i < targets.length; i += CHUNK) {
    const chunk = targets.slice(i, i + CHUNK);
    await Promise.all(chunk.map((t, j) => auditOne(t, i + j + 1)));
  }

  // Aggregate by code+layer
  const byCode = {};
  for (const f of findings) {
    const key = `${f.layer}|${f.code}`;
    if (!byCode[key]) byCode[key] = { layer: f.layer, code: f.code, severity: f.severity, count: 0, sample: f.message };
    byCode[key].count++;
  }
  const sorted = Object.values(byCode).sort((a, b) => b.count - a.count);

  console.log(`\n=== TOP FINDINGS — ${targets.length} AE+AU drafts ===`);
  console.log(`Total findings: ${findings.length}\n`);
  console.log('LAYER   | CODE  | SEV     | COUNT |   %   | SAMPLE');
  console.log('--------|-------|---------|-------|-------|--------');
  sorted.slice(0, 30).forEach(f => {
    const pct = Math.round((f.count / targets.length) * 100);
    const truncMsg = (f.sample || '').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`${f.layer.padEnd(7)} | ${String(f.code).padEnd(5)} | ${String(f.severity).padEnd(7)} | ${String(f.count).padStart(5)} | ${String(pct).padStart(3)}% | ${truncMsg}`);
  });

  fs.writeFileSync(
    path.join(__dirname, '..', 'data', `ae-au-findings-aggregate-${new Date().toISOString().slice(0,10)}.json`),
    JSON.stringify({ totals: { targets: targets.length, findings: findings.length }, byCode: sorted, rawFindings: findings }, null, 2)
  );
  console.log(`\n[aggregate] Done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
