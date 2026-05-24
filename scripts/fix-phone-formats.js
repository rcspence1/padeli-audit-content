#!/usr/bin/env node
const path = require('path');
const { wpGet, wpPut } = require(path.join(__dirname, '..', 'wp-client'));

// 4 listings with phone format issues (top 200 substance audit)
const fixes = [
  { id: 18496, country: 'GB', current: '07517 803572', fixed: '+44 7517 803572' },
  { id: 18960, country: 'GB', current: '020 7224 1625', fixed: '+44 20 7224 1625' },
  { id: 19555, country: 'US', current: '(305) 615-9731', fixed: '+1 305 615 9731' },
  { id: 19936, country: 'US', current: '(410) 296-0601', fixed: '+1 410 296 0601' },
];

(async () => {
  const dryRun = process.argv.includes('--dry-run');
  console.log(`[fix-phones] ${dryRun ? 'DRY RUN' : 'WRITE MODE'} — patching ${fixes.length} listings\n`);

  for (const f of fixes) {
    // Pull current state to verify
    const wp = await wpGet(`/wp-json/wp/v2/listing/${f.id}?context=edit`);
    const currentPhone = wp.meta?._phone || '';
    const currentTitle = wp.title?.rendered || '?';

    if (currentPhone !== f.current) {
      console.log(`⚠️  #${f.id} ${currentTitle} — phone has changed since audit (now: "${currentPhone}"). Skipping.`);
      continue;
    }

    if (dryRun) {
      console.log(`[DRY] #${f.id} ${currentTitle} (${f.country}): "${f.current}" → "${f.fixed}"`);
      continue;
    }

    try {
      await wpPut(`/wp-json/wp/v2/listing/${f.id}`, { meta: { _phone: f.fixed } });
      // Verify
      const after = await wpGet(`/wp-json/wp/v2/listing/${f.id}?context=edit&_fields=meta._phone`);
      const newPhone = after.meta?._phone || '';
      const ok = newPhone === f.fixed;
      console.log(`${ok ? '✅' : '❌'} #${f.id} ${currentTitle} (${f.country}): "${f.current}" → "${newPhone}"`);
    } catch (e) {
      console.log(`❌ #${f.id} ERROR: ${e.message}`);
    }
  }
  console.log('\n[fix-phones] Done');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
