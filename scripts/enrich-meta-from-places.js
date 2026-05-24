#!/usr/bin/env node
const path = require('path');
const { wpGet, wpPut } = require(path.join(__dirname, '..', 'wp-client'));
const { resolveOpeningHours } = require(path.join(__dirname, '..', 'opening-hours-resolver'));
const { parseOpeningHours } = require(path.join(__dirname, '..', 'wp-payload'));

// 15 listings flagged by substance audit (phone empty, website empty, hours bad/empty)
const TARGETS = [
  // Phone empty
  { id: 17238, country: 'GB', need: ['phone'] },
  { id: 17681, country: 'GB', need: ['phone'] },
  { id: 17712, country: 'GB', need: ['phone'] },
  { id: 17945, country: 'GB', need: ['phone'] },
  { id: 18237, country: 'GB', need: ['phone', 'website'] },
  { id: 18294, country: 'GB', need: ['phone'] },
  { id: 18332, country: 'GB', need: ['phone'] },
  { id: 18405, country: 'GB', need: ['phone'] },
  { id: 19662, country: 'US', need: ['phone'] },
  // Website empty
  { id: 14401, country: 'AE', need: ['website'] },
  // Hours issues
  { id: 17531, country: 'GB', need: ['hours'] },
  { id: 18496, country: 'GB', need: ['hours'] },
  { id: 18960, country: 'GB', need: ['hours'] },
  { id: 19555, country: 'US', need: ['hours'] },
  { id: 19936, country: 'US', need: ['hours'] },
];

async function fetchPlacesMeta(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!placeId) return { ok: false, reason: 'no_place_id' };
  if (!key) return { ok: false, reason: 'no_api_key' };
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'internationalPhoneNumber,nationalPhoneNumber,websiteUri,regularOpeningHours,businessStatus,displayName',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, reason: `http_${res.status}: ${body.slice(0, 80)}` };
  }
  const data = await res.json();
  return { ok: true, data };
}

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[enrich] ${dryRun ? 'DRY RUN' : 'WRITE MODE'} — ${TARGETS.length} listings\n`);

  const summary = { fixed: 0, partial: 0, unfixable: 0, errors: 0 };

  for (const t of TARGETS) {
    try {
      const wp = await wpGet(`/wp-json/wp/v2/listing/${t.id}?context=edit`);
      const placeId = wp.meta?._place_id;
      const title = wp.title?.rendered || '?';
      if (!placeId) {
        console.log(`⚠️  ${t.country} #${t.id} ${title} — no _place_id, cannot enrich`);
        summary.unfixable++;
        continue;
      }

      const places = await fetchPlacesMeta(placeId);
      if (!places.ok) {
        console.log(`⚠️  ${t.country} #${t.id} ${title} — Places API failed: ${places.reason}`);
        summary.errors++;
        continue;
      }

      const patch = {};
      const actions = [];

      // PHONE
      if (t.need.includes('phone')) {
        const phone = places.data.internationalPhoneNumber || places.data.nationalPhoneNumber;
        if (phone && /^\+/.test(phone)) {
          patch._phone = phone;
          actions.push(`phone: "" → "${phone}"`);
        } else if (phone) {
          // National format — prefix with country code best guess
          const ccMap = { GB: '+44', US: '+1', AE: '+971', AU: '+61' };
          const cc = ccMap[t.country] || '+';
          const fixed = `${cc} ${phone.replace(/^0/, '').replace(/[()\-\s]+/g, ' ').trim()}`;
          patch._phone = fixed;
          actions.push(`phone: "" → "${fixed}" (from national: ${phone})`);
        } else {
          actions.push('phone: NOT FOUND in Places');
        }
      }

      // WEBSITE
      if (t.need.includes('website')) {
        const site = places.data.websiteUri;
        const isSocial = site && /(instagram\.com|facebook\.com|tiktok\.com|x\.com|twitter\.com)/i.test(site);
        if (site && /^https?:\/\//.test(site) && !isSocial) {
          patch._website = site;
          actions.push(`website: "" → "${site}"`);
        } else if (isSocial) {
          actions.push(`website: SOCIAL URL only ("${site.slice(0, 60)}...") — skipped, needs proper website`);
        } else {
          actions.push('website: NOT FOUND in Places');
        }
      }

      // HOURS — use existing resolver
      if (t.need.includes('hours')) {
        const resolved = await resolveOpeningHours({ place_id: placeId });
        if (resolved.hours) {
          patch._opening_hours = resolved.hours;
          // Also patch Listeo per-day fields
          const dayFields = parseOpeningHours(resolved.hours);
          Object.assign(patch, dayFields);
          actions.push(`hours: → "${resolved.hours}" (+ 14 per-day fields)`);
        } else {
          actions.push(`hours: NOT RECOVERABLE (${resolved.sourcesTried.join(', ')})`);
        }
      }

      if (Object.keys(patch).length === 0) {
        console.log(`❌ ${t.country} #${t.id} ${title}: ${actions.join(' | ')}`);
        summary.unfixable++;
        continue;
      }

      if (dryRun) {
        console.log(`[DRY] ${t.country} #${t.id} ${title}\n        ${actions.join('\n        ')}`);
        continue;
      }

      await wpPut(`/wp-json/wp/v2/listing/${t.id}`, { meta: patch });
      const fullyFixed = actions.every(a => !a.includes('NOT FOUND') && !a.includes('NOT RECOVERABLE'));
      console.log(`${fullyFixed ? '✅' : '🟡'} ${t.country} #${t.id} ${title}\n        ${actions.join('\n        ')}`);
      if (fullyFixed) summary.fixed++;
      else summary.partial++;
    } catch (e) {
      console.log(`❌ ${t.country} #${t.id} ERROR: ${e.message}`);
      summary.errors++;
    }
  }

  console.log(`\n[enrich] Summary: ${summary.fixed} fixed, ${summary.partial} partial, ${summary.unfixable} unfixable, ${summary.errors} errors`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
