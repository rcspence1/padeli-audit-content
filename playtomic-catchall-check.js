/**
 * playtomic-catchall-check.js — dynamic, self-discovering catch-all / wrong-tenant
 * detector across the LIVE corpus (published + draft club listings).
 *
 * A Playtomic "catch-all" tenant is one returned by Playtomic search for ANY
 * non-matching query — so MANY unrelated venues end up pointing at the SAME tenant.
 * Static blocklists only catch the ones we already know. This checker finds them
 * DYNAMICALLY from two independent signals, so it flags catch-alls we've never
 * seen before:
 *
 *   SIGNAL 1 — FREQUENCY (no API): one Playtomic tenant shared by ≥2 DISTINCT
 *     venues (distinct _place_id / distinct normalised name) is a catch-all suspect.
 *     A real tenant = one physical venue. Sharing across unrelated venues = catch-all.
 *
 *   SIGNAL 2 — NAME-MATCH (Playtomic API, deduped per tenant): fetch the tenant's
 *     real name and verify it matches the venue(s) linking to it (reuses the audit's
 *     verifyTenantMatchesVenue / PT05 logic). A tenant whose real name matches NONE
 *     of its venues is a catch-all or a wrong-attribution link — caught even at a
 *     single occurrence.
 *
 * Reuses existing assets (no reinvention): content-auditor.fetchAllListings,
 * playtomic-data {getCourts, tenantIdFromUrl, tenantSlugFromUrl, verifyTenantMatchesVenue}.
 *
 * Usage:
 *   node playtomic-catchall-check.js                 # frequency pass only (instant, no Playtomic API)
 *   node playtomic-catchall-check.js --verify        # + name-match every distinct tenant (Playtomic API, paced)
 *   node playtomic-catchall-check.js --verify --status publish   # restrict corpus
 * Read-only. Writes /tmp/padeli-catchall-<ts>.json + proposes blocklist additions.
 */
const A = require('./content-auditor');
const { getCourts, tenantIdFromUrl, tenantSlugFromUrl, verifyTenantMatchesVenue } = require('./playtomic-data');
const fs = require('fs');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Cross-reference only (NOT relied upon — detection is dynamic). Known catch-alls
// from qualify-queue's PLAYTOMIC_CATCHALL set, for labelling.
const KNOWN = new Set([
  '0ce49dbf-e3e3-4edb-8507-52fa96374af6', '91474bfc-57ee-4c11-bda3-1bb091710f4d',
]);

function mv(meta, key) { let v = meta && meta[key]; if (Array.isArray(v)) v = v[0]; return v == null ? '' : v; }
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
function tenantKey(url) {
  if (!url) return '';
  return tenantIdFromUrl(url) || tenantSlugFromUrl(url) || '';
}

(async () => {
  const args = process.argv.slice(2);
  const doVerify = args.includes('--verify');
  const statusArg = args.includes('--status') ? args[args.indexOf('--status') + 1] : null;
  const statuses = statusArg ? [statusArg] : ['publish', 'draft'];

  // 1. Pull the corpus (club listings only — coaches have no Playtomic tenant)
  let corpus = [];
  for (const st of statuses) {
    console.log(`[catchall] fetching ${st} listings...`);
    const arr = await A.fetchAllListings({ status: st, fullMeta: true });
    corpus = corpus.concat(arr.map(l => ({ ...l, _status: st })));
  }
  const lt = (l) => mv(l.meta, '_listing_type') || '';
  const clubs = corpus.filter(l => lt(l) === 'clubs' || lt(l) === '');
  console.log(`[catchall] ${corpus.length} listings, ${clubs.length} club/untyped to check`);

  // 2. FREQUENCY signal — build tenant -> venues map
  const byTenant = new Map();
  for (const l of clubs) {
    const url = mv(l.meta, '_playtomic_url') || mv(l.meta, '_booking_link') || '';
    const key = tenantKey(url);
    if (!key) continue;
    if (!byTenant.has(key)) byTenant.set(key, []);
    byTenant.get(key).push({
      id: l.id, status: l._status,
      name: (l.title && (l.title.raw || l.title.rendered)) || l.slug,
      slug: l.slug, placeId: mv(l.meta, '_place_id'), city: mv(l.meta, '_geolocation_city'), url,
    });
  }

  const tenants = [...byTenant.entries()].map(([key, venues]) => {
    const distinctPlaceIds = new Set(venues.map(v => v.placeId).filter(Boolean));
    const distinctNames = new Set(venues.map(v => norm(v.name)));
    return { key, venues, count: venues.length, distinctPlaceIds: distinctPlaceIds.size, distinctNames: distinctNames.size, known: KNOWN.has(key) };
  });

  // Frequency-based catch-all suspects: shared by ≥2 distinct venues
  const freqSuspects = tenants.filter(t => t.distinctPlaceIds >= 2 || (t.distinctPlaceIds === 0 && t.distinctNames >= 2))
    .sort((a, b) => b.count - a.count);

  console.log(`\n===== FREQUENCY SIGNAL (no API) =====`);
  console.log(`distinct tenants in corpus: ${tenants.length}`);
  console.log(`CATCH-ALL SUSPECTS (shared by ≥2 distinct venues): ${freqSuspects.length}`);
  for (const t of freqSuspects) {
    console.log(`  ${t.key}${t.known ? ' [KNOWN]' : ' [NEW?]'} — ${t.count} listings, ${t.distinctPlaceIds} distinct place_ids, ${t.distinctNames} distinct names`);
    for (const v of t.venues.slice(0, 6)) console.log(`       #${v.id} (${v.status}) ${v.name}`);
    if (t.venues.length > 6) console.log(`       ...+${t.venues.length - 6} more`);
  }

  // 3. NAME-MATCH signal — verify each distinct tenant against its venues (API, deduped)
  let verified = [];
  if (doVerify) {
    console.log(`\n===== NAME-MATCH SIGNAL (Playtomic API, ${tenants.length} distinct tenants) =====`);
    let n = 0;
    for (const t of tenants) {
      n++;
      let pt;
      try { pt = await getCourts(t.venues[0].url); }
      catch (e) { pt = { ok: false, error: e.message }; }
      const tenantName = pt && pt.ok ? (pt.tenantName || '') : '';
      // does the tenant's real name match ANY of the venues pointing at it?
      const matches = t.venues.map(v => ({ v, m: verifyTenantMatchesVenue(v.name, tenantName, { cityHint: v.city }) }));
      const anyMatch = matches.some(x => x.m && x.m.ok);
      const noneMatch = pt && pt.ok && tenantName && !anyMatch;
      const verdict = !pt || !pt.ok ? 'api_fail'
        : noneMatch ? 'WRONG_TENANT'            // real name matches none of its venues
        : (t.distinctPlaceIds >= 2) ? 'CATCHALL_SHARED'
        : 'ok';
      t.tenantName = tenantName; t.verdict = verdict;
      t.mismatchVenues = matches.filter(x => !(x.m && x.m.ok)).map(x => x.v);
      verified.push(t);
      if (verdict !== 'ok') {
        console.log(`  [${verdict}] tenant ${t.key} real="${tenantName||'?'}" — ${t.count} listing(s)`);
        for (const v of (verdict === 'WRONG_TENANT' ? t.venues : t.mismatchVenues).slice(0, 6)) console.log(`       #${v.id} (${v.status}) ${v.name}`);
      }
      if (n % 25 === 0) console.log(`   ...verified ${n}/${tenants.length}`);
      await sleep(280);
    }
  }

  // 4. Output report + proposed blocklist additions
  const flaggedTenants = doVerify
    ? verified.filter(t => t.verdict === 'WRONG_TENANT' || t.verdict === 'CATCHALL_SHARED')
    : freqSuspects;
  const flaggedListings = [];
  for (const t of flaggedTenants) {
    const vs = (doVerify && t.verdict === 'CATCHALL_SHARED') ? t.venues
      : (doVerify && t.verdict === 'WRONG_TENANT') ? t.venues
      : t.venues;
    for (const v of vs) flaggedListings.push({ ...v, tenant: t.key, verdict: t.verdict || 'freq_suspect', tenantName: t.tenantName || '' });
  }
  const newCatchalls = (doVerify ? verified : tenants).filter(t => !t.known && (t.distinctPlaceIds >= 3 || t.verdict === 'CATCHALL_SHARED'));

  const ts = Date.now();
  const out = {
    ts, statuses, distinctTenants: tenants.length,
    freqSuspectCount: freqSuspects.length,
    verified: doVerify,
    wrongTenant: doVerify ? verified.filter(t => t.verdict === 'WRONG_TENANT').length : null,
    catchallShared: doVerify ? verified.filter(t => t.verdict === 'CATCHALL_SHARED').length : null,
    proposedBlocklistAdditions: newCatchalls.map(t => t.key),
    flaggedListings,
    tenants: doVerify ? verified : freqSuspects,
  };
  const path = `/tmp/padeli-catchall-${ts}.json`;
  fs.writeFileSync(path, JSON.stringify(out, null, 2));
  console.log(`\n===== SUMMARY =====`);
  console.log(`distinct tenants: ${tenants.length} | freq catch-all suspects: ${freqSuspects.length}` + (doVerify ? ` | WRONG_TENANT: ${out.wrongTenant} | CATCHALL_SHARED: ${out.catchallShared}` : ' (run --verify for name-match)'));
  console.log(`flagged listings (need _playtomic_url cleared/re-sourced): ${flaggedListings.length}`);
  if (newCatchalls.length) console.log(`PROPOSED blocklist additions (new catch-alls): ${newCatchalls.map(t => t.key).join(', ')}`);
  console.log(`saved ${path}`);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
