#!/usr/bin/env node
/**
 * Targeted repair of three listings carrying dead Playtomic URLs.
 *
 * All three were surfaced by the M41/G71 sweep as "booking URL exists but never
 * reached the CTA field". Promotion was blocked because the URLs 404 — verified
 * in a REAL BROWSER against a live control, so not the SPA/WAF false-positive
 * class documented in runbook §9 item 11.
 *
 * Resolution (browser-verified 2026-09-10):
 *   14674 Home of Padel Saadiyat Rotana
 *         meta held .../clubs/lacasadepadel (404) but the BODY held
 *         .../clubs/home-of-padel-saadiyat-rotana -> 200, title
 *         "Book a court in Home Of Padel Saadiyat Rotana". Meta was simply wrong.
 *   15305 Gaby Reca Padel Academy Abu Dhabi
 *         meta held .../clubs/active-al-maryah- (404, truncated slug) but the
 *         BODY held .../clubs/active-al-maryah-by-gaby-reca -> 200, title
 *         "Book a court in Active Al Maryah By Gaby Reca".
 *   13431 Al Hamra Padel Beach
 *         .../clubs/padel-beach-al-hamra-golf-club 404s. Playtomic search for
 *         "Al Hamra" / "Al Hamra Padel" returns other RAK clubs only
 *         (blue-padel-ras-al-khaimah, rak-padel-club) — no match. The club has
 *         left Playtomic. CLEAR the dead marker rather than invent a URL.
 *         Its _booking_link stays empty and it remains in the contact-path
 *         cohort pending the _contact_link decision.
 *
 * Safety mirrors remove-deadlinks.js: snapshotProtectedMeta -> write -> settle
 * -> cache-busted re-GET -> findWipedFields -> auto-refill -> verify protected.
 *
 *   node fix-dead-playtomic.js            # DRY RUN
 *   node fix-dead-playtomic.js --apply
 */
const fs = require('fs');
const path = require('path');
const PDIR = process.env.PADELI_PROJECT_DIR;
if (!PDIR) { console.error('Set PADELI_PROJECT_DIR'); process.exit(1); }
const { wpGet, wpPost } = require(PDIR + '/lib/wp-client');
const { snapshotProtectedMeta, findWipedFields } = require(PDIR + '/lib/wp-payload.js');

const one = (v) => (Array.isArray(v) ? v[0] : v);
const dec = (s) => String(s == null ? '' : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const APPLY = process.argv.includes('--apply');

const PLAN = [
  { id: 14674, action: 'replace', url: 'https://playtomic.com/clubs/home-of-padel-saadiyat-rotana',
    was: 'https://playtomic.com/clubs/lacasadepadel' },
  { id: 15305, action: 'replace', url: 'https://playtomic.com/clubs/active-al-maryah-by-gaby-reca',
    was: 'https://playtomic.com/clubs/active-al-maryah-' },
  { id: 13431, action: 'clear',
    was: 'https://playtomic.com/clubs/padel-beach-al-hamra-golf-club' },
];

(async () => {
  console.log(`fix-dead-playtomic — ${PLAN.length} listing(s), ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);
  const out = [];

  for (const item of PLAN) {
    const l = await wpGet(`/wp-json/wp/v2/listing/${item.id}?context=edit&t=${Date.now()}`);
    if (!l || !l.id) { out.push({ id: item.id, error: 'not found' }); console.log(`  ⁉️  ${item.id} not found`); continue; }
    const meta = l.meta || {};
    const cur = dec(one(meta._playtomic_url)).trim();

    // Re-derive from live state — only act if the dead URL is still there.
    if (cur !== item.was) {
      out.push({ id: l.id, slug: l.slug, noop: true, reason: `_playtomic_url changed since scan (now "${cur || 'empty'}")` });
      console.log(`  ·   ${l.slug} (#${l.id}) — changed since scan, skipped`);
      continue;
    }

    const changes = item.action === 'clear'
      ? { _playtomic_url: '' }
      : { _playtomic_url: item.url, _booking_link: item.url, _direct_booking_url: item.url };

    if (!APPLY) {
      console.log(`  📋 ${l.slug} (#${l.id})  [${item.action}]`);
      for (const [k, v] of Object.entries(changes)) {
        console.log(`        ${k.padEnd(22)}: ${dec(one(meta[k])).trim() || '(empty)'}`);
        console.log(`        ${''.padEnd(22)}  ->  ${v || '(cleared)'}`);
      }
      out.push({ id: l.id, slug: l.slug, action: item.action, changes });
      continue;
    }

    const snap = snapshotProtectedMeta(l);
    for (const f of Object.keys(changes)) if (f in snap) snap[f] = changes[f];

    await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: changes });
    await sleep(2000);
    let after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    const wiped = findWipedFields(snap, after).filter((k) => !(k in changes));
    if (wiped.length) {
      const rf = {}; for (const k of wiped) rf[k] = snap[k];
      await wpPost(`/wp-json/wp/v2/listing/${l.id}`, { meta: rf });
      await sleep(1200);
      after = await wpGet(`/wp-json/wp/v2/listing/${l.id}?context=edit&t=${Date.now()}`);
    }
    const fm = after.meta || {};
    const prot = ['_place_id', '_listing_type'].filter((k) => dec(one(meta[k])) !== dec(one(fm[k])));
    const landed = Object.entries(changes).every(([k, v]) => dec(one(fm[k])).trim() === v);
    out.push({ id: l.id, slug: l.slug, action: item.action, landed, prot, wipedAndRefilled: wiped });
    console.log(`  ${landed && !prot.length ? '✅' : '⚠️ '} ${l.slug} (#${l.id}) [${item.action}] landed:${landed} refilled:[${wiped.join(',') || '-'}] prot:${prot.join('|') || 'clean'}`);
    await sleep(800);
  }

  const rp = path.join(__dirname, 'reports', APPLY ? 'fix-dead-playtomic-result.json' : 'fix-dead-playtomic-dryrun.json');
  fs.writeFileSync(rp, JSON.stringify(out, null, 2));
  console.log(`\n${APPLY ? 'Applied' : 'Dry run'}. -> ${rp}`);
})();
