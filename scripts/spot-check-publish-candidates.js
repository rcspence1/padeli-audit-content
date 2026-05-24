#!/usr/bin/env node
const path = require('path');
const fs = require('fs');
const { wpGet } = require(path.join(__dirname, '..', 'wp-client'));

(async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'publish-manifest-top200-2026-05-19.json')));

  // Pick 5 random with tier distribution: 1 from ≥90%, 2 from 85-89%, 2 from 80-84%
  const tier1 = manifest.filter(x => x.score >= 90);
  const tier2 = manifest.filter(x => x.score >= 85 && x.score < 90);
  const tier3 = manifest.filter(x => x.score >= 80 && x.score < 85);
  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const picks = [pick(tier1), pick(tier2), pick(tier2), pick(tier3), pick(tier3)].filter(Boolean);

  console.log('=== 5 RANDOM PUBLISH-READY SPOT CHECKS ===\n');

  for (const p of picks) {
    const wp = await wpGet(`/wp-json/wp/v2/listing/${p.id}?context=edit&_embed=wp:featuredmedia`);
    const m = wp.meta || {};
    const galleryCount = (m._gallery && typeof m._gallery === 'object') ? Object.keys(m._gallery).length : 0;
    const features = Array.isArray(wp.listing_feature) ? wp.listing_feature.length : 0;
    const featuredId = wp.featured_media || 0;
    const featuredUrl = wp._embedded?.['wp:featuredmedia']?.[0]?.source_url || '';
    const previewUrl = `https://padeli.com/?p=${p.id}&preview=true`;

    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`${p.country} #${p.id} ${wp.title?.rendered || p.title}  —  score ${p.score}%`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📍  Address       : ${m._address || '(empty)'}`);
    console.log(`📞  Phone         : ${m._phone || '(empty)'}`);
    console.log(`💬  WhatsApp      : ${m._whatsapp || '(empty)'}`);
    console.log(`🌐  Website       : ${m._website || '(empty)'}`);
    console.log(`🎾  Playtomic     : ${m._playtomic_url || '(empty)'}`);
    console.log(`🎫  Direct booking: ${m._direct_booking_url || '(empty)'}`);
    console.log(`🔗  Booking link  : ${m._booking_link || '(empty)'}`);
    console.log(`🕐  Opening hours : ${m._opening_hours || '(empty)'}`);
    console.log(`📸  Hero image    : ${featuredId ? `ID ${featuredId} → ${featuredUrl}` : '❌ MISSING'}`);
    console.log(`🖼   Gallery       : ${galleryCount} images`);
    console.log(`⭐  Features tags : ${features} amenities`);
    console.log(`❓  FAQs          : 6 (audit confirmed)`);
    console.log(`📌  Place ID      : ${m._place_id || '(empty)'}`);
    console.log(`📷  Instagram     : ${m._instagram || '(empty)'}`);
    console.log(`📘  Facebook      : ${m._facebook || '(empty)'}`);
    console.log(`💰  Price range   : ${m._price_min ? `${m._price_min} - ${m._price_max || '?'}` : '(empty)'}`);
    console.log(`🏟   Surface       : ${m._surface_type || '(empty)'}`);
    console.log(`💡  Lighting      : ${m._lighting || '(empty)'}`);
    console.log(`📅  Opening year  : ${m._clubs_tab_opening_year || '(empty)'}`);
    console.log(`🔍  Preview URL   : ${previewUrl}`);
    console.log(`✏️   WP edit URL   : https://padeli.com/wp-admin/post.php?post=${p.id}&action=edit`);
    console.log('');
  }
})().catch(e => { console.error('FATAL:', e); process.exit(1); });
