#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { auditSingleListing } = require(path.join(__dirname, '..', 'content-auditor'));

// Map QC/Expert codes to substantive categories
const categoryMap = {
  // Hero hook / description
  'H23': 'description_hero_hook', 'H24': 'description_hero_hook', 'H25': 'description_hero_hook',
  'H26': 'description_hero_hook', 'H27': 'description_hero_hook',
  'C6': 'description_body', 'C7': 'description_body', 'C7b': 'description_body',
  'C8': 'description_body', 'C9': 'description_body', 'C10': 'description_body',
  'C11': 'description_body', 'C12': 'description_body', 'C13': 'description_body',
  'C14': 'description_body', 'C15': 'description_body', 'C16': 'description_body',
  'C17': 'description_body', 'C18': 'description_body', 'C19': 'description_body',
  'C20': 'description_body', 'C21': 'description_body', 'C22': 'description_body',
  // Hero image / gallery
  'I56': 'hero_image', 'E13': 'hero_image',
  'I60': 'gallery',
  // Booking URLs (Playtomic / MATI / direct)
  'M41': 'booking_urls',
  // Website
  'M31': 'website',
  // Contact details
  'M30': 'contact_phone', 'M32': 'contact_whatsapp',
  // Address / place
  'M28': 'address', 'M29': 'place_id',
  // Opening hours
  'M35': 'opening_hours',
  // Social
  'M38': 'social_instagram', 'M39': 'social_facebook',
  // FAQ
  'F42': 'faqs', 'F43': 'faqs', 'F44': 'faqs', 'F45': 'faqs', 'F46': 'faqs',
  // Features
  'S5': 'features', 'FT57': 'features', 'FT58': 'features', 'FT59': 'features',
  // Region taxonomy
  'S4': 'region_taxonomy',
  // Pricing
  'M36': 'pricing',
  // Surface / lighting
  'M33': 'surface_lighting', 'M34': 'surface_lighting',
  // Opening year
  'M37': 'opening_year',
  // FAQ toggle
  'M40': 'faq_settings',
  // Yoast
  'Y01': 'seo_keyword', 'Y02': 'seo_title', 'Y03': 'seo_meta_desc',
  'Y10': 'seo_og_image',
  // Expert SEO (post-calibration)
  'E01': 'seo_keyword', 'E02': 'seo_keyword', 'E03': 'seo_keyword', 'E07': 'seo_keyword',
  'E08': 'seo_internal_links',
  'E10': 'seo_images', 'E33': 'seo_images',
  'E26': 'seo_dates', 'E29': 'seo_voice', 'E31': 'seo_author',
  'E05': 'seo_word_count',
  'E18': 'seo_brevity',
  'E25': 'seo_entity', 'E34': 'seo_entity',
};

const parseCode = s => {
  const m = String(s).match(/^\[([A-Z0-9]+)\]\s*(.*)/);
  return m ? { code: m[1], message: m[2] } : { code: 'UNCODED', message: String(s) };
};

(async () => {
  const startedAt = Date.now();
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'publish-manifest-top200-2026-05-19.json')));
  console.log(`[substance] Re-auditing top 200 (no Notion writes — analysis only)`);

  const findings = [];
  const CHUNK = 5;
  const auditOne = async (t, idx) => {
    try {
      const r = await auditSingleListing(t.id, { skipLive: true, skipLinks: true });
      const push = (raw, severity, layer) => {
        const { code, message } = parseCode(raw);
        const category = categoryMap[code] || 'other';
        findings.push({ country: t.country, id: t.id, severity, code, layer, category, message });
      };
      for (const e of r.errors || []) push(e, 'error', 'qc');
      for (const w of r.warnings || []) push(w, 'warning', 'qc');
      for (const c of r.yoast?.checks || []) if (c.pass === false) {
        const category = categoryMap[c.id] || 'other';
        findings.push({ country: t.country, id: t.id, severity: c.severity || 'warning', code: c.id, layer: 'yoast', category, message: c.message });
      }
      for (const c of r.expert?.checks || []) if (c.pass === false) {
        const category = categoryMap[c.id] || 'other';
        findings.push({ country: t.country, id: t.id, severity: c.severity || 'warning', code: c.id, layer: 'expert', category, message: c.message });
      }
      if ((idx % 25) === 0) console.log(`[${idx}/200] running...`);
    } catch (e) {
      console.log(`[${idx}/200] #${t.id} ERROR: ${e.message}`);
    }
  };

  for (let i = 0; i < manifest.length; i += CHUNK) {
    const chunk = manifest.slice(i, i + CHUNK);
    await Promise.all(chunk.map((t, j) => auditOne(t, i + j + 1)));
  }

  // Aggregate by category
  const byCategory = {};
  const listingsAffectedByCategory = {};
  for (const f of findings) {
    if (!byCategory[f.category]) byCategory[f.category] = { count: 0, errors: 0, warnings: 0, sampleCodes: new Set() };
    byCategory[f.category].count++;
    if (f.severity === 'error') byCategory[f.category].errors++;
    else byCategory[f.category].warnings++;
    byCategory[f.category].sampleCodes.add(f.code);
    if (!listingsAffectedByCategory[f.category]) listingsAffectedByCategory[f.category] = new Set();
    listingsAffectedByCategory[f.category].add(f.id);
  }
  const sorted = Object.entries(byCategory)
    .map(([cat, d]) => ({ category: cat, ...d, listings: listingsAffectedByCategory[cat].size, sampleCodes: [...d.sampleCodes].sort() }))
    .sort((a, b) => b.listings - a.listings);

  console.log('\n=== SUBSTANCE AUDIT — TOP 200 LISTINGS ===');
  console.log(`Total findings: ${findings.length}\n`);
  console.log('CATEGORY                 | LISTINGS | ERR | WARN | CODES');
  console.log('-------------------------|----------|-----|------|------');
  sorted.forEach(c => {
    const pct = Math.round((c.listings / 200) * 100);
    console.log(`${c.category.padEnd(24)} | ${String(c.listings).padStart(3)}/200 (${String(pct).padStart(2)}%) | ${String(c.errors).padStart(3)} | ${String(c.warnings).padStart(4)} | ${c.sampleCodes.join(', ')}`);
  });

  // Per-country category breakdown for the most important fields
  const keyCategories = ['hero_image', 'gallery', 'booking_urls', 'website', 'contact_phone', 'contact_whatsapp', 'address', 'place_id', 'opening_hours', 'faqs', 'features', 'region_taxonomy'];
  console.log('\n=== KEY-FIELD COVERAGE (% of top 200 with issue) ===');
  keyCategories.forEach(cat => {
    const affected = listingsAffectedByCategory[cat] ? listingsAffectedByCategory[cat].size : 0;
    const pct = Math.round((affected / 200) * 100);
    const status = affected === 0 ? '✅ CLEAN' : affected < 10 ? '🟡 minor' : '🔴 systemic';
    console.log(`${cat.padEnd(20)}: ${String(affected).padStart(3)}/200 affected (${String(pct).padStart(2)}%) ${status}`);
  });

  fs.writeFileSync(
    path.join(__dirname, '..', 'data', `top200-substance-${new Date().toISOString().slice(0, 10)}.json`),
    JSON.stringify({ byCategory: sorted, rawFindings: findings }, null, 2)
  );
  console.log(`\n[substance] Done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
