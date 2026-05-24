#!/usr/bin/env node
/**
 * Geolocation Enrichment
 *
 * For draft listings with empty _geolocation_lat / _geolocation_long but a
 * valid _place_id, pull coordinates + address components from Google Places
 * and patch WP. Listeo's location map widget requires lat/lng to render —
 * without them, the listing has no map even though place_id is set.
 *
 * Patches: _geolocation_lat, _geolocation_long, _geolocation_city,
 *          _geolocation_state, _geolocation_country, _geolocation_zip,
 *          _geolocation_formatted_address
 *
 * Usage:
 *   node scripts/enrich-geolocation.js --top200    # enrich the 81 affected listings in the top 200 manifest
 *   node scripts/enrich-geolocation.js --top200 --dry-run
 *   node scripts/enrich-geolocation.js --id 19485  # single listing
 */

const path = require('path');
const fs = require('fs');
const { wpGet, wpPut } = require(path.join(__dirname, '..', 'wp-client'));

async function fetchPlacesGeo(placeId) {
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!placeId) return { ok: false, reason: 'no_place_id' };
  if (!key) return { ok: false, reason: 'no_api_key' };
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  const res = await fetch(url, {
    headers: {
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'location,formattedAddress,addressComponents,displayName',
    },
  });
  if (!res.ok) {
    const body = await res.text();
    return { ok: false, reason: `http_${res.status}: ${body.slice(0, 80)}` };
  }
  const data = await res.json();
  return { ok: true, data };
}

function extractAddressParts(addressComponents = []) {
  const get = (...types) => {
    for (const t of types) {
      const c = addressComponents.find(c => c.types?.includes(t));
      if (c) return c.longText || c.shortText || '';
    }
    return '';
  };
  return {
    city: get('locality', 'postal_town', 'sublocality_level_1'),
    state: get('administrative_area_level_1'),
    country: get('country'),
    zip: get('postal_code'),
  };
}

async function enrichOne(id, opts = {}) {
  const wp = await wpGet(`/wp-json/wp/v2/listing/${id}?context=edit`);
  const title = wp.title?.rendered || '?';
  const placeId = wp.meta?._place_id;
  if (!placeId) return { id, title, status: 'skip', reason: 'no _place_id' };

  const lat = wp.meta?._geolocation_lat;
  const lng = wp.meta?._geolocation_long;
  if (lat && lng && !opts.force) {
    return { id, title, status: 'skip', reason: 'already has coords' };
  }

  const places = await fetchPlacesGeo(placeId);
  if (!places.ok) return { id, title, status: 'error', reason: places.reason };

  const loc = places.data.location;
  if (!loc || typeof loc.latitude !== 'number' || typeof loc.longitude !== 'number') {
    return { id, title, status: 'error', reason: 'no coords in Places response' };
  }

  const parts = extractAddressParts(places.data.addressComponents);
  const patch = {
    _geolocation_lat: String(loc.latitude),
    _geolocation_long: String(loc.longitude),
    _geolocation_city: parts.city,
    _geolocation_state: parts.state,
    _geolocation_country: parts.country,
    _geolocation_zip: parts.zip,
    _geolocation_formatted_address: places.data.formattedAddress || wp.meta?._address || '',
  };

  if (opts.dryRun) return { id, title, status: 'would_patch', patch };

  await wpPut(`/wp-json/wp/v2/listing/${id}`, { meta: patch });
  return { id, title, status: 'patched', patch };
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const top200 = process.argv.includes('--top200');
  const idIdx = process.argv.indexOf('--id');
  const singleId = idIdx >= 0 ? Number(process.argv[idIdx + 1]) : null;

  let ids;
  if (singleId) {
    ids = [singleId];
  } else if (top200) {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'publish-manifest-top200-2026-05-19.json')));
    // Pre-filter to listings actually missing coords
    console.log(`[geo-enrich] Scanning ${manifest.length} top-200 listings for missing coords...`);
    const missing = [];
    const SCAN_CHUNK = 10;
    for (let s = 0; s < manifest.length; s += SCAN_CHUNK) {
      const batch = manifest.slice(s, s + SCAN_CHUNK);
      await Promise.all(batch.map(async m => {
        try {
          const wp = await wpGet(`/wp-json/wp/v2/listing/${m.id}?context=edit&_fields=id,meta._geolocation_lat,meta._geolocation_long`);
          if (!wp.meta?._geolocation_lat || !wp.meta?._geolocation_long) missing.push(m.id);
        } catch (e) { /* skip */ }
      }));
    }
    ids = missing;
    console.log(`[geo-enrich] ${ids.length} listings need enrichment\n`);
  } else {
    console.error('Usage: node scripts/enrich-geolocation.js --top200 [--dry-run] | --id <wp_id>');
    process.exit(1);
  }

  console.log(`[geo-enrich] ${dryRun ? 'DRY RUN' : 'WRITE MODE'} — ${ids.length} listings\n`);
  const results = { patched: 0, would_patch: 0, skip: 0, error: 0 };
  const CHUNK = 5;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const chunkResults = await Promise.all(chunk.map(id => enrichOne(id, { dryRun }).catch(e => ({ id, status: 'error', reason: e.message }))));
    chunkResults.forEach((r, j) => {
      const idx = i + j + 1;
      results[r.status] = (results[r.status] || 0) + 1;
      const icon = r.status === 'patched' ? '✅' : r.status === 'would_patch' ? '🟡' : r.status === 'skip' ? '⏭️ ' : '❌';
      const detail = r.status === 'patched' || r.status === 'would_patch'
        ? `lat=${r.patch._geolocation_lat} lng=${r.patch._geolocation_long} city="${r.patch._geolocation_city}"`
        : r.reason;
      console.log(`${icon} [${idx}/${ids.length}] #${r.id} ${r.title || ''} — ${detail}`);
    });
  }

  console.log(`\n[geo-enrich] Summary: ${results.patched || 0} patched, ${results.would_patch || 0} would_patch, ${results.skip || 0} skipped, ${results.error || 0} errors`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
