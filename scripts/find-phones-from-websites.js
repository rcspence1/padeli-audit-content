#!/usr/bin/env node
/**
 * Phone-lookup investigation — accuracy-first.
 *
 * For the 5 listings with empty phones, try to extract candidate phone numbers
 * from their own venue websites. Present candidates with context. Does NOT
 * write to WP — Ryan reviews and decides.
 *
 * Key safety rules (per Ryan):
 *   - Only use confirmed Playtomic URLs already set on the listing (no blind search)
 *   - Flag chain websites where the phone may belong to HQ not the specific venue
 *   - Show source URL and the surrounding context for each phone candidate
 */

const path = require('path');
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

const targets = [
  { id: 17681, name: 'This is Padel Dronfield', country: 'GB', city: 'Dronfield' },
  { id: 17945, name: 'Let\'s Go Padel Omagh', country: 'GB', city: 'Omagh', chain: true },
  { id: 18332, name: 'Spa Padel', country: 'GB', city: 'Spa' },
  { id: 18405, name: 'Let\'s Go Padel Lurgan', country: 'GB', city: 'Lurgan', chain: true },
  { id: 19662, name: 'Padel Garten by Glassbox', country: 'US', city: '' },
];

// Phone patterns
const phonePatterns = [
  /\+44\s?\d{2,5}[\s\d]{6,12}/g,     // UK international
  /\+1\s?\(?\d{3}\)?[\s\d-]{7,12}/g, // US international
  /\b0\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g, // UK national
  /\(\d{3}\)\s?\d{3}[\s-]?\d{4}/g,   // US (XXX) XXX-XXXX
  /tel:[+0-9\s\-()]+/gi,
];

async function fetchPage(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PadeliPhoneFinder/1.0)' },
      redirect: 'follow',
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const html = await res.text();
    return { ok: true, html, finalUrl: res.url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function extractPhones(html, sourceUrl) {
  const candidates = new Map();
  for (const pattern of phonePatterns) {
    const matches = html.matchAll(pattern);
    for (const m of matches) {
      const raw = m[0].replace(/^tel:/i, '').trim();
      const cleaned = raw.replace(/\s+/g, ' ');
      if (cleaned.length < 8 || cleaned.length > 25) continue;
      // grab ±60 chars of context
      const idx = m.index;
      const start = Math.max(0, idx - 60);
      const end = Math.min(html.length, idx + raw.length + 60);
      const ctx = html.slice(start, end).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!candidates.has(cleaned)) {
        candidates.set(cleaned, { count: 0, contexts: [] });
      }
      const c = candidates.get(cleaned);
      c.count++;
      if (c.contexts.length < 2) c.contexts.push(ctx);
    }
  }
  return [...candidates.entries()].map(([phone, info]) => ({ phone, ...info }));
}

(async () => {
  console.log('[find-phones] Investigating 5 listings — reporting candidates only, no writes\n');

  for (const t of targets) {
    const wp = await wpGet(`/wp-json/wp/v2/listing/${t.id}?context=edit`);
    const website = wp.meta?._website || '';
    const playtomicUrl = wp.meta?._playtomic_url || '';
    const address = wp.meta?._address || '';
    console.log(`#${t.id} ${t.name}${t.chain ? ' [CHAIN — may have HQ phone]' : ''}`);
    console.log(`  Address: ${address}`);
    console.log(`  Website: ${website || '(none)'}`);
    console.log(`  Playtomic: ${playtomicUrl}`);

    const sourcesToScrape = [];
    if (website && !/playtomic\.io/i.test(website)) {
      sourcesToScrape.push({ label: 'website (root)', url: website });
      // Also try venue-specific path for chains
      if (t.chain && t.city) {
        const citySlug = t.city.toLowerCase();
        const root = website.replace(/\/$/, '');
        sourcesToScrape.push({ label: `chain venue page (${t.city})`, url: `${root}/${citySlug}` });
        sourcesToScrape.push({ label: `chain venue page alt`, url: `${root}/locations/${citySlug}` });
      }
      // Try a /contact page too
      const contactUrl = website.replace(/\/$/, '') + '/contact';
      sourcesToScrape.push({ label: 'website (contact)', url: contactUrl });
    } else {
      console.log(`  ⚠️  No usable website to scrape (only Playtomic which is JS-rendered)`);
    }

    const allCandidates = new Map();
    for (const s of sourcesToScrape) {
      const r = await fetchPage(s.url);
      if (!r.ok) {
        console.log(`    ${s.label}: ${r.error}`);
        continue;
      }
      const phones = extractPhones(r.html, s.url);
      console.log(`    ${s.label} (${s.url}) → ${phones.length} candidate phone${phones.length === 1 ? '' : 's'}`);
      for (const p of phones) {
        if (!allCandidates.has(p.phone)) {
          allCandidates.set(p.phone, { totalCount: 0, sources: [], contexts: [] });
        }
        const agg = allCandidates.get(p.phone);
        agg.totalCount += p.count;
        agg.sources.push(s.label);
        agg.contexts.push(...p.contexts.slice(0, 1));
      }
    }

    if (allCandidates.size === 0) {
      console.log(`  ❌ No phone candidates found\n`);
      continue;
    }

    console.log(`  → Candidates (count, sources):`);
    const sorted = [...allCandidates.entries()].sort((a, b) => b[1].totalCount - a[1].totalCount);
    for (const [phone, agg] of sorted.slice(0, 5)) {
      console.log(`     "${phone}" — found ${agg.totalCount}× in [${agg.sources.join(', ')}]`);
      if (agg.contexts[0]) console.log(`       ctx: "${agg.contexts[0].slice(0, 100)}..."`);
    }
    console.log('');
  }
  console.log('[find-phones] Done — review candidates before applying any write');
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
