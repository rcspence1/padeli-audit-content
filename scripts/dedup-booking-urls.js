#!/usr/bin/env node
const path = require('path');
const { wpGet, wpPut } = require(path.join(__dirname, '..', 'wp-client'));

// 3 listings with duplicate URLs across booking fields
const fixes = [
  {
    id: 14401,
    label: 'Padel Plus Academy',
    description: 'Playtomic URL in 3 fields → keep _playtomic_url, clear others',
    patch: { _booking_link: '', _direct_booking_url: '' },
  },
  {
    id: 17681,
    label: 'This is Padel Dronfield',
    description: 'Playtomic URL in 2 fields → keep _playtomic_url, clear _booking_link',
    patch: { _booking_link: '' },
  },
  {
    id: 18727,
    label: 'Smash Padel Whitstable',
    description: 'Same URL in _booking_link and _website → move to _direct_booking_url, clear _booking_link',
    patch: { _booking_link: '', _direct_booking_url: 'https://smashpadel.co/whitstable/' },
  },
];

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[dedup-urls] ${dryRun ? 'DRY RUN' : 'WRITE MODE'} — ${fixes.length} listings\n`);

  for (const f of fixes) {
    try {
      const before = await wpGet(`/wp-json/wp/v2/listing/${f.id}?context=edit`);
      const bm = before.meta || {};
      console.log(`#${f.id} ${f.label}`);
      console.log(`  Plan: ${f.description}`);
      console.log(`  Before: _booking_link="${bm._booking_link || ''}" | _playtomic_url="${bm._playtomic_url || ''}" | _direct_booking_url="${bm._direct_booking_url || ''}" | _website="${bm._website || ''}"`);
      console.log(`  Patch: ${JSON.stringify(f.patch)}`);

      if (dryRun) { console.log(''); continue; }

      await wpPut(`/wp-json/wp/v2/listing/${f.id}`, { meta: f.patch });
      const after = await wpGet(`/wp-json/wp/v2/listing/${f.id}?context=edit&_fields=meta`);
      const am = after.meta || {};
      console.log(`  After:  _booking_link="${am._booking_link || ''}" | _playtomic_url="${am._playtomic_url || ''}" | _direct_booking_url="${am._direct_booking_url || ''}" | _website="${am._website || ''}"`);
      console.log('  ✅ patched\n');
    } catch (e) {
      console.log(`  ❌ ERROR: ${e.message}\n`);
    }
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
