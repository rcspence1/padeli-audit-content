/**
 * grade-drafts.js — run the all-9 BPA publish gate across listings.
 * Usage:
 *   node grade-drafts.js <id> [<id> ...]      # grade specific listings (draft mode)
 *   node grade-drafts.js --all-drafts          # grade every status=draft listing
 *   node grade-drafts.js --all-drafts --live   # (future) live mode on published
 * Read-only. Writes a ranked JSON report to /tmp/padeli-grade-<ts>.json.
 */
const A = require('./content-auditor');
const { evaluateGate } = require('./publish-gate');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, tries = 4) {
  for (let i = 1; i <= tries; i++) {
    try { return await fn(); }
    catch (e) {
      const transient = /\b(429|500|502|503|504|524)\b/.test(e.message || '');
      if (i === tries || !transient) throw e;
      await sleep(1200 * i);
    }
  }
}

async function gradeOne(id, mode) {
  const wp = await withRetry(() => A.fetchListing(id));
  const qc = A.auditListing(wp);
  const yoast = A.analyseYoastSeo(wp);
  const expert = A.analyseExpertSeo(wp, 'listing', {});
  const composite = Math.round(qc.score * 0.4 + yoast.score * 0.3 + expert.score * 0.3);
  let links = null, drift = null;
  try { links = await A.validateLinks(wp, 'listing'); } catch (e) { links = { error: e.message }; }
  try { drift = await A.auditPlaytomicDrift(wp); } catch (e) { drift = { error: e.message }; }
  const audit = { errors: qc.errors, warnings: qc.warnings, links, playtomicDrift: drift, score: composite, live: null };
  const gate = evaluateGate(wp, audit, { mode });
  return gate;
}

(async () => {
  const fs = require('fs');
  const args = process.argv.slice(2);
  const mode = args.includes('--live') ? 'live' : 'draft';
  let ids = args.filter(a => /^\d+$/.test(a)).map(Number);

  if (args.includes('--all-drafts')) {
    console.log('[grade] fetching all draft listing IDs...');
    const all = await A.fetchAllListings({ status: 'draft' });
    const lt = (l) => { let v = l.meta && l.meta._listing_type; if (Array.isArray(v)) v = v[0]; return v || '(unset)'; };
    let pool = all;
    if (args.includes('--clubs-only')) pool = all.filter(l => lt(l) === 'clubs');
    ids = pool.map(l => l.id);
    console.log(`[grade] ${ids.length} drafts to grade${args.includes('--clubs-only') ? ' (clubs only)' : ''}`);
  }
  if (!ids.length) { console.error('No IDs. Pass ids or --all-drafts'); process.exit(1); }

  const results = [];
  let done = 0;
  for (const id of ids) {
    try {
      const g = await gradeOne(id, mode);
      results.push(g);
      done++;
      const tag = g.readyToPublish ? 'READY' : `FAIL(${g.failCount})`;
      console.log(`[${done}/${ids.length}] ${id} ${g.slug} — ${tag} score=${g.score} ${g.pass ? '' : '| ' + g.failures.join('; ')}`);
    } catch (e) {
      console.log(`[${done}/${ids.length}] ${id} — ERROR ${(e.message||'').slice(0,80)}`);
      results.push({ listingId: id, error: e.message });
    }
    await sleep(280);
  }

  // Aggregate
  const graded = results.filter(r => !r.error);
  const ready = graded.filter(r => r.readyToPublish);
  const byGap = {};
  for (const r of graded) for (const it of (r.items || [])) if (it.status === 'fail') byGap[it.key] = (byGap[it.key] || 0) + 1;
  const ts = Date.now();
  const out = { ts, mode, total: ids.length, graded: graded.length, ready: ready.length, errors: results.length - graded.length, gapFrequency: byGap, results };
  const path = `/tmp/padeli-grade-${ts}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\n===== GRADE SUMMARY (${mode}) =====`);
  console.log(`graded ${graded.length}/${ids.length} | READY ${ready.length} | needs-fix ${graded.length - ready.length} | errors ${results.length - graded.length}`);
  console.log('gap frequency (fails by non-negotiable):');
  Object.entries(byGap).sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log(`   ${k}: ${n}`));
  console.log(`\nsaved ${path}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
