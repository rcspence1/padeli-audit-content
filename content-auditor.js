/**
 * Padeli Content Auditor
 *
 * Post-publish scanner that audits live listings and blog posts on padeli.com.
 * 6-layer architecture:
 *   1. WP REST pull  — fetch content via API with ?context=edit
 *   2. QC reuse      — run existing 67-point listing / 54-point blog validators
 *   3. Live fetch    — rendered page checks (schema, meta, OG tags, canonical)
 *   4. GSC/GA        — search performance data
 *   5. Ahrefs        — backlink & keyword data (stubbed — needs subscription)
 *   6. Link validation — HTTP HEAD checks on all external URLs in content
 *
 * Node.js v24+ — zero external dependencies — CommonJS
 */

const { wpGet, wpPut } = require('./wp-client');
const { validatePayload } = require('./qc-validator');
const { validateBlogPost, checkVoiceAndStyle, checkStructure } = require('./blog-qc-validator');
const { stripHtml, countWords } = require('./utils');
const { afterAuditPipeline } = require('./notion-sync');
const { resolveOpeningHours } = require('./opening-hours-resolver');
const { parseOpeningHours } = require('./wp-payload');

const SITE_URL = 'https://padeli.com';

// ─────────────────────────────────────────────────────────────────────────────
// Layer 1: WP REST Pull
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a single listing by ID with full meta.
 * @param {number} id
 * @returns {Promise<object>}
 */
async function fetchListing(id) {
  return wpGet(`/wp-json/wp/v2/listing/${id}?context=edit`);
}

/**
 * Fetch a single blog post by ID or slug with full meta.
 * @param {string|number} idOrSlug
 * @returns {Promise<object>}
 */
async function fetchPost(idOrSlug) {
  if (!isNaN(idOrSlug)) {
    return wpGet(`/wp-json/wp/v2/posts/${idOrSlug}?context=edit`);
  }
  const results = await wpGet(`/wp-json/wp/v2/posts?slug=${encodeURIComponent(idOrSlug)}&context=edit`);
  if (Array.isArray(results) && results.length > 0) return results[0];
  throw new Error(`Blog post not found: ${idOrSlug}`);
}

/**
 * Fetch all listings (paginated). Returns lightweight objects unless fullMeta is true.
 * @param {object} [opts]
 * @param {string} [opts.status] - 'publish', 'draft', or 'any' (default: 'any')
 * @param {number} [opts.limit]  - max items (0 = all)
 * @param {boolean} [opts.fullMeta] - fetch with context=edit (slower, needed for QC)
 * @returns {Promise<Array>}
 */
async function fetchAllListings(opts = {}) {
  const status = opts.status || 'any';
  const limit = opts.limit || 0;
  const fullMeta = opts.fullMeta !== false;
  const all = [];
  let page = 1;

  while (true) {
    const fields = fullMeta ? '' : '&_fields=id,slug,title,status,link,meta,region,listing_feature,listing_category,clubs_category,featured_media';
    const ctx = fullMeta ? '&context=edit' : '';
    const endpoint = `/wp-json/wp/v2/listing?per_page=100&page=${page}&status=${status}${ctx}${fields}`;

    try {
      const batch = await wpGet(endpoint);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (limit > 0 && all.length >= limit) { all.length = limit; break; }
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (page > 1 && err.message && err.message.includes('400')) break;
      throw err;
    }
  }

  return all;
}

/**
 * Fetch all blog posts (paginated).
 * @param {object} [opts]
 * @param {string} [opts.status] - 'publish', 'draft', or 'any' (default: 'publish')
 * @param {number} [opts.limit]  - max items (0 = all)
 * @returns {Promise<Array>}
 */
async function fetchAllPosts(opts = {}) {
  const status = opts.status || 'publish';
  const limit = opts.limit || 0;
  const all = [];
  let page = 1;

  while (true) {
    const endpoint = `/wp-json/wp/v2/posts?per_page=100&page=${page}&status=${status}&context=edit`;

    try {
      const batch = await wpGet(endpoint);
      if (!Array.isArray(batch) || batch.length === 0) break;
      all.push(...batch);
      if (limit > 0 && all.length >= limit) { all.length = limit; break; }
      if (batch.length < 100) break;
      page++;
    } catch (err) {
      if (page > 1 && err.message && err.message.includes('400')) break;
      throw err;
    }
  }

  return all;
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 2: QC Reuse
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extract venue name from a WP listing response.
 * @param {object} wp - WP REST listing object
 * @returns {string}
 */
function extractVenueName(wp) {
  const raw = wp.title?.raw || wp.title?.rendered || '';
  return raw.replace(/&#8217;/g, "'").replace(/&#038;/g, '&').replace(/&amp;/g, '&');
}

/**
 * Extract city from a listing's region terms.
 * WP REST returns region as array of term IDs — we fall back to meta._address.
 * @param {object} wp
 * @returns {string}
 */
function extractCity(wp) {
  const addr = wp.meta?._address || '';
  const parts = addr.split(',').map(s => s.trim());
  return parts.length >= 2 ? parts[parts.length - 2] : '';
}

/**
 * Audit a single listing using the existing 67-point validator.
 * @param {object} wp - Full WP REST listing object (context=edit)
 * @returns {object} { id, slug, name, type: 'listing', pass, errors, warnings, score }
 */
function auditListing(wp) {
  const venueName = extractVenueName(wp);
  const city = extractCity(wp);

  // validatePayload expects the raw WP object shape
  const result = validatePayload(wp, venueName, { city });

  const totalChecks = result.errors.length + result.warnings.length;
  const score = totalChecks > 0
    ? Math.round(((totalChecks - result.errors.length) / Math.max(totalChecks, 1)) * 100)
    : 100;

  return {
    id: wp.id,
    slug: wp.slug,
    name: venueName,
    link: wp.link || `${SITE_URL}/listing/${wp.slug}/`,
    type: 'listing',
    status: wp.status,
    pass: result.pass,
    errors: result.errors,
    warnings: result.warnings,
    score,
  };
}

/**
 * Map a WP REST blog post object to the postData shape validateBlogPost expects.
 * @param {object} wp - Full WP REST post object (context=edit)
 * @returns {object} postData
 */
function mapWpPostToPostData(wp) {
  const content = typeof wp.content === 'string'
    ? wp.content
    : (wp.content?.raw || wp.content?.rendered || '');

  const meta = wp.meta || {};
  const yoastJson = wp.yoast_head_json || {};

  // Extract FAQs from content (FAQPage schema in body)
  const faqs = extractFaqsFromHtml(content);

  return {
    body_html: content,
    slug: wp.slug || '',
    title: wp.title?.raw || wp.title?.rendered || '',
    tier: '', // not stored in WP — inferred later
    focus_keyword: meta._yoast_wpseo_focuskw || yoastJson.focuskw || '',
    yoast_title: meta._yoast_wpseo_title || yoastJson.title || '',
    yoast_meta: meta._yoast_wpseo_metadesc || yoastJson.description || '',
    da_paragraph: '', // not stored as separate meta in WP
    canonical: yoastJson.canonical || wp.link || '',
    robots: yoastJson.robots || {},
    faqs,
    related_reading: [],
    internal_links: [],
    external_links: [],
    is_ymyl: false,
    featured_media: wp.featured_media || 0,
    featured_media_source_url: wp._embedded?.['wp:featuredmedia']?.[0]?.source_url || '',
  };
}

/**
 * Extract FAQ Q&A pairs from FAQPage JSON-LD embedded in HTML.
 * @param {string} html
 * @returns {Array<{question: string, answer: string}>}
 */
function extractFaqsFromHtml(html) {
  const faqs = [];
  const schemaRegex = /<script\s+type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = schemaRegex.exec(html)) !== null) {
    try {
      const obj = JSON.parse(match[1]);
      if (obj['@type'] === 'FAQPage' && Array.isArray(obj.mainEntity)) {
        for (const item of obj.mainEntity) {
          faqs.push({
            question: item.name || '',
            answer: item.acceptedAnswer?.text || '',
          });
        }
      }
    } catch { /* skip malformed JSON-LD */ }
  }
  return faqs;
}

/**
 * Infer post type from slug patterns and content structure.
 * @param {object} wp - WP REST post object
 * @param {string} html - post body
 * @returns {string} post type guess
 */
function inferPostType(wp, html) {
  const slug = wp.slug || '';
  const lowerHtml = html.toLowerCase();

  if (/best-padel-(courts?|clubs?).*\d{4}/.test(slug)) return 'city_listicle';
  if (/best-padel-(rackets?|racquets?|shoes?|bags?)/.test(slug)) return 'product_listicle';
  if (/^padel-in-/.test(slug)) return 'pillar';
  // Check content hints
  if (lowerHtml.includes('item-list-element') || lowerHtml.includes('itemlist')) return 'city_listicle';
  return 'city_listicle'; // safe default — most common type
}

/**
 * Audit a single blog post using the existing 54-point validator.
 * @param {object} wp - Full WP REST post object (context=edit)
 * @returns {object} { id, slug, name, type: 'post', pass, score, errors, warnings, checks }
 */
function auditPost(wp) {
  const postData = mapWpPostToPostData(wp);
  const postType = inferPostType(wp, postData.body_html);

  const result = validateBlogPost(postData, postType);

  return {
    id: wp.id,
    slug: wp.slug,
    name: wp.title?.raw || wp.title?.rendered || '',
    link: wp.link || `${SITE_URL}/${wp.slug}/`,
    type: 'post',
    status: wp.status,
    postType,
    pass: result.pass,
    score: result.score,
    errors: result.errors,
    warnings: result.warnings,
    checks: result.checks,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3: Live Fetch (rendered page checks)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch the rendered HTML of a live page and run front-end checks.
 * @param {string} url - full URL of the page
 * @returns {Promise<object>} { url, checks: [{id, pass, message}], fetchOk }
 */
async function auditRenderedPage(url) {
  const checks = [];
  let html = '';
  let fetchOk = false;

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (PadeliAuditor)' },
      redirect: 'follow',
    });
    fetchOk = res.ok;
    if (!res.ok) {
      checks.push({ id: 'L01', pass: false, severity: 'error', message: `HTTP ${res.status} — page not accessible` });
      return { url, checks, fetchOk };
    }
    html = await res.text();
  } catch (err) {
    checks.push({ id: 'L01', pass: false, severity: 'error', message: `Fetch failed: ${err.message}` });
    return { url, checks, fetchOk };
  }

  // L02: Title tag exists and is non-empty
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const titleText = titleMatch ? titleMatch[1].trim() : '';
  checks.push({
    id: 'L02', pass: !!titleText, severity: 'error',
    message: titleText ? `Title: "${titleText.substring(0, 70)}"` : 'Missing or empty <title> tag',
  });

  // L03: Meta description
  const metaDescMatch = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
    || html.match(/<meta\s+content="([^"]*)"\s+name="description"/i);
  const metaDesc = metaDescMatch ? metaDescMatch[1] : '';
  checks.push({
    id: 'L03', pass: !!metaDesc, severity: 'warning',
    message: metaDesc ? `Meta desc: ${metaDesc.length} chars` : 'Missing meta description',
  });

  // L04: Canonical URL
  const canonicalMatch = html.match(/<link\s+rel="canonical"\s+href="([^"]*)"/i);
  checks.push({
    id: 'L04', pass: !!canonicalMatch, severity: 'warning',
    message: canonicalMatch ? `Canonical: ${canonicalMatch[1]}` : 'Missing canonical URL',
  });

  // L05: OG tags (title, description, image)
  const ogTitle = /<meta\s+property="og:title"/i.test(html);
  const ogDesc = /<meta\s+property="og:description"/i.test(html);
  const ogImage = /<meta\s+property="og:image"/i.test(html);
  const ogCount = [ogTitle, ogDesc, ogImage].filter(Boolean).length;
  checks.push({
    id: 'L05', pass: ogCount === 3, severity: 'warning',
    message: ogCount === 3 ? 'All OG tags present' : `Missing OG tags: ${[!ogTitle && 'og:title', !ogDesc && 'og:description', !ogImage && 'og:image'].filter(Boolean).join(', ')}`,
  });

  // L06: JSON-LD schema present
  const schemaBlocks = html.match(/<script\s+type="application\/ld\+json">/gi) || [];
  checks.push({
    id: 'L06', pass: schemaBlocks.length > 0, severity: 'warning',
    message: schemaBlocks.length > 0 ? `${schemaBlocks.length} JSON-LD block(s) found` : 'No JSON-LD schema found on page',
  });

  // L07: FAQPage schema (for listings and listicle posts)
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(html);
  checks.push({
    id: 'L07', pass: hasFaqSchema, severity: 'warning',
    message: hasFaqSchema ? 'FAQPage schema present' : 'No FAQPage schema on rendered page',
  });

  // L08: robots meta — check for noindex
  const robotsMeta = html.match(/<meta\s+name="robots"\s+content="([^"]*)"/i);
  const isNoindex = robotsMeta && robotsMeta[1].toLowerCase().includes('noindex');
  checks.push({
    id: 'L08', pass: !isNoindex, severity: 'error',
    message: isNoindex ? `Page is noindex: "${robotsMeta[1]}"` : 'No noindex directive',
  });

  // L09: Hreflang (informational)
  const hreflangs = html.match(/<link\s+rel="alternate"\s+hreflang/gi) || [];
  checks.push({
    id: 'L09', pass: true, severity: 'info',
    message: `${hreflangs.length} hreflang tag(s)`,
  });

  // L10: Page load — check for common error indicators
  const has500 = html.includes('Internal Server Error') || html.includes('Error 500');
  const has404Content = html.includes('Page not found') || html.includes('Error 404');
  if (has500) checks.push({ id: 'L10', pass: false, severity: 'error', message: 'Page contains 500/Internal Server Error text' });
  if (has404Content) checks.push({ id: 'L10', pass: false, severity: 'error', message: 'Page contains 404/Not Found text' });
  if (!has500 && !has404Content) checks.push({ id: 'L10', pass: true, severity: 'info', message: 'No error indicators on page' });

  return { url, checks, fetchOk };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3b: Yoast SEO Analysis
// Pulls computed Yoast data from yoast_head_json and _yoast_wpseo_* meta
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Analyse Yoast SEO data from a WP REST object.
 * Works for both listings and posts — any object with yoast_head_json + meta.
 * @param {object} wp - WP REST object (context=edit)
 * @returns {object} { checks: [{id, pass, severity, message, domain}], score }
 */
function analyseYoastSeo(wp) {
  const checks = [];
  const yhj = wp.yoast_head_json || {};
  const meta = wp.meta || {};
  const focusKw = meta._yoast_wpseo_focuskw || '';
  const yoastTitle = meta._yoast_wpseo_title || yhj.title || '';
  const yoastMeta = meta._yoast_wpseo_metadesc || yhj.description || '';
  const robots = yhj.robots || {};
  const schema = yhj.schema || {};
  const graph = schema['@graph'] || [];
  const canonical = yhj.canonical || meta._yoast_wpseo_canonical || '';

  // Y01: Focus keyword set
  checks.push({
    id: 'Y01', domain: 'yoast', pass: !!focusKw, severity: 'error',
    message: focusKw ? `Focus keyword: "${focusKw}"` : 'No focus keyword set in Yoast',
  });

  // Y02: Yoast title present and within 50-65 chars
  const titleLen = yoastTitle.length;
  checks.push({
    id: 'Y02', domain: 'yoast', severity: 'warning',
    pass: titleLen >= 50 && titleLen <= 65,
    message: titleLen === 0 ? 'Yoast title missing' : `Yoast title: ${titleLen} chars (target 50-65)`,
  });

  // Y03: Meta description present and 120-156 chars
  const metaLen = yoastMeta.length;
  checks.push({
    id: 'Y03', domain: 'yoast', severity: 'warning',
    pass: metaLen >= 120 && metaLen <= 156,
    message: metaLen === 0 ? 'Meta description missing' : `Meta desc: ${metaLen} chars (target 120-156)`,
  });

  // Y04: Focus keyword in Yoast title
  if (focusKw && yoastTitle) {
    const inTitle = yoastTitle.toLowerCase().includes(focusKw.toLowerCase());
    checks.push({
      id: 'Y04', domain: 'yoast', pass: inTitle, severity: 'warning',
      message: inTitle ? 'Focus keyword found in title' : `Focus keyword "${focusKw}" not in Yoast title`,
    });
  }

  // Y05: Focus keyword in meta description
  if (focusKw && yoastMeta) {
    const inMeta = yoastMeta.toLowerCase().includes(focusKw.toLowerCase());
    checks.push({
      id: 'Y05', domain: 'yoast', pass: inMeta, severity: 'warning',
      message: inMeta ? 'Focus keyword found in meta desc' : `Focus keyword "${focusKw}" not in meta description`,
    });
  }

  // Y06: Robots — not noindex
  const isNoindex = robots.index === 'noindex' || String(robots.index || '').includes('noindex');
  checks.push({
    id: 'Y06', domain: 'yoast', pass: !isNoindex, severity: 'error',
    message: isNoindex ? 'Page is set to noindex in Yoast' : 'Index directive OK',
  });

  // Y07: Canonical URL set
  checks.push({
    id: 'Y07', domain: 'yoast', pass: !!canonical, severity: 'warning',
    message: canonical ? `Canonical: ${canonical}` : 'No canonical URL set',
  });

  // Y08: OG title set
  checks.push({
    id: 'Y08', domain: 'yoast', pass: !!yhj.og_title, severity: 'warning',
    message: yhj.og_title ? 'OG title present' : 'OG title missing from Yoast output',
  });

  // Y09: OG description set
  checks.push({
    id: 'Y09', domain: 'yoast', pass: !!yhj.og_description, severity: 'warning',
    message: yhj.og_description ? 'OG description present' : 'OG description missing',
  });

  // Y10: OG image set
  const hasOgImage = Array.isArray(yhj.og_image) && yhj.og_image.length > 0 && !!yhj.og_image[0].url;
  checks.push({
    id: 'Y10', domain: 'yoast', pass: hasOgImage, severity: 'warning',
    message: hasOgImage ? 'OG image present' : 'OG image missing — social shares will have no thumbnail',
  });

  // Y11: Schema graph completeness
  const graphTypes = graph.map(g => g['@type']).filter(Boolean);
  const hasWebPage = graphTypes.some(t => t === 'WebPage' || (Array.isArray(t) && t.includes('WebPage')));
  const hasOrg = graphTypes.some(t => t === 'Organization');
  const hasBreadcrumb = graphTypes.some(t => t === 'BreadcrumbList');
  const schemaScore = [hasWebPage, hasOrg, hasBreadcrumb].filter(Boolean).length;
  checks.push({
    id: 'Y11', domain: 'yoast', pass: schemaScore >= 2, severity: 'warning',
    message: `Schema graph: ${graphTypes.join(', ') || 'empty'} (${schemaScore}/3 core types)`,
  });

  // Y12: Twitter card type set
  checks.push({
    id: 'Y12', domain: 'yoast', pass: !!yhj.twitter_card, severity: 'info',
    message: yhj.twitter_card ? `Twitter card: ${yhj.twitter_card}` : 'No Twitter card type set',
  });

  const passed = checks.filter(c => c.pass).length;
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0;

  return { checks, score };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 3c: Expert SEO Checks
// Informed by Ahrefs (on-page SEO), Nathan Gotch (ranking factors),
// and padeli content strategy (AEO, content depth, freshness)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run expert-informed SEO analysis on content.
 * These checks go beyond Yoast — they apply ranking factor knowledge
 * from SEO practitioners to score content competitiveness.
 *
 * @param {object} wp - WP REST object (context=edit)
 * @param {string} contentType - 'listing' or 'post'
 * @returns {object} { checks: [{id, pass, severity, message, domain}], score }
 */
function analyseExpertSeo(wp, contentType) {
  const checks = [];
  const meta = wp.meta || {};
  const focusKw = (meta._yoast_wpseo_focuskw || '').toLowerCase();
  const rawContent = typeof wp.content === 'string'
    ? wp.content
    : (wp.content?.raw || wp.content?.rendered || '');
  const plainText = stripHtml(rawContent);
  const wordCount = countWords(plainText);
  const lowerContent = rawContent.toLowerCase();
  const lowerPlain = plainText.toLowerCase();

  // ── On-Page Keyword Placement (Ahrefs + Gotch) ──

  // E01: Keyword in H1 (critical ranking signal)
  // For listings, WP title IS the H1 (Listeo theme renders it). For posts, check body.
  const h1Match = rawContent.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const h1Text = h1Match
    ? stripHtml(h1Match[1]).toLowerCase()
    : (contentType === 'listing' ? (wp.title?.raw || wp.title?.rendered || '').toLowerCase() : '');
  if (focusKw) {
    const h1Source = h1Match ? 'body H1' : (contentType === 'listing' ? 'WP title (theme H1)' : '');
    checks.push({
      id: 'E01', domain: 'expert_seo', severity: contentType === 'listing' && !h1Match ? 'info' : 'error',
      pass: h1Text.includes(focusKw),
      message: h1Text.includes(focusKw)
        ? `Focus keyword in ${h1Source || 'H1'}`
        : h1Text ? `Focus keyword "${focusKw}" not in ${h1Source || 'H1'}: "${h1Text.substring(0, 60)}"` : 'No H1 tag found in content',
    });
  }

  // E02: Keyword in first 100 words (Gotch: "keyword proximity to top")
  if (focusKw) {
    const first100 = lowerPlain.split(/\s+/).slice(0, 100).join(' ');
    checks.push({
      id: 'E02', domain: 'expert_seo', severity: 'warning',
      pass: first100.includes(focusKw),
      message: first100.includes(focusKw)
        ? 'Focus keyword in first 100 words'
        : 'Focus keyword not found in first 100 words — add it to the intro',
    });
  }

  // E03: Keyword density (Ahrefs: 0.5-2.5% is natural, >3% is stuffing)
  if (focusKw && wordCount > 0) {
    const kwRegex = new RegExp(focusKw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    const kwMatches = lowerPlain.match(kwRegex) || [];
    const density = (kwMatches.length / wordCount) * 100;
    const pass = density >= 0.3 && density <= 3.0;
    checks.push({
      id: 'E03', domain: 'expert_seo', severity: pass ? 'info' : 'warning',
      pass,
      message: `Keyword density: ${density.toFixed(2)}% (${kwMatches.length} occurrences in ${wordCount} words — target 0.5-2.5%)`,
    });
  }

  // E04: Keyword in slug
  if (focusKw && wp.slug) {
    const kwSlug = focusKw.replace(/\s+/g, '-');
    checks.push({
      id: 'E04', domain: 'expert_seo', severity: 'warning',
      pass: wp.slug.includes(kwSlug),
      message: wp.slug.includes(kwSlug)
        ? 'Focus keyword in slug'
        : `Slug "${wp.slug}" doesn't contain keyword "${kwSlug}"`,
    });
  }

  // ── Content Depth & Quality (Ahrefs: "topical coverage") ──

  // E05: Word count vs target for content type
  let minWords, maxWords;
  if (contentType === 'listing') {
    minWords = 600; maxWords = 900;
  } else {
    // Blog posts: infer from slug pattern
    if (/best-padel/.test(wp.slug || '')) { minWords = 2500; maxWords = 4500; }
    else if (/^padel-in-/.test(wp.slug || '')) { minWords = 2500; maxWords = 4500; }
    else { minWords = 1200; maxWords = 4500; }
  }
  checks.push({
    id: 'E05', domain: 'expert_seo', severity: wordCount < minWords ? 'error' : 'info',
    pass: wordCount >= minWords && wordCount <= maxWords,
    message: `Word count: ${wordCount} (target ${minWords}-${maxWords})`,
  });

  // E06: Heading structure — H2 count (Gotch: "use H2s to cover subtopics")
  // Listings use <h3> as section headings (theme renders H2 for sections)
  const h2Count = (rawContent.match(/<h2[\s>]/gi) || []).length;
  const h3Count = (rawContent.match(/<h3[\s>]/gi) || []).length;
  const headingCount = contentType === 'listing' ? h2Count + h3Count : h2Count;
  const expectedH2 = contentType === 'listing' ? 4 : Math.max(4, Math.floor(wordCount / 400));
  checks.push({
    id: 'E06', domain: 'expert_seo', severity: headingCount < 3 ? 'warning' : 'info',
    pass: headingCount >= 3,
    message: contentType === 'listing'
      ? `Section headings (H2+H3): ${headingCount} (${expectedH2}+ recommended)`
      : `H2 headings: ${h2Count} (${expectedH2}+ recommended for ${wordCount} words)`,
  });

  // E07: Keyword in at least one heading (Ahrefs: subheading relevance)
  if (focusKw) {
    const h2Matches = rawContent.match(/<h2[^>]*>([\s\S]*?)<\/h2>/gi) || [];
    const h3Matches = rawContent.match(/<h3[^>]*>([\s\S]*?)<\/h3>/gi) || [];
    const allHeadings = contentType === 'listing' ? [...h2Matches, ...h3Matches] : h2Matches;
    const kwInHeading = allHeadings.some(h => stripHtml(h).toLowerCase().includes(focusKw));
    checks.push({
      id: 'E07', domain: 'expert_seo', severity: 'warning',
      pass: kwInHeading,
      message: kwInHeading
        ? 'Focus keyword found in at least one section heading'
        : 'Focus keyword not found in any section heading — add a subtopic heading with the keyword',
    });
  }

  // ── Internal & External Links (Ahrefs: "link equity distribution") ──

  // E08: Internal links count
  const internalLinks = (rawContent.match(/href="https?:\/\/(www\.)?padeli\.com/gi) || []).length
    + (rawContent.match(/href="\//g) || []).length;
  const internalTarget = contentType === 'listing' ? 2 : 5;
  checks.push({
    id: 'E08', domain: 'expert_seo', severity: internalLinks < internalTarget ? 'warning' : 'info',
    pass: internalLinks >= internalTarget,
    message: `Internal links: ${internalLinks} (target ${internalTarget}+)`,
  });

  // E09: External authority links (Gotch: "outbound links to authoritative sources signal trust")
  const allHrefs = rawContent.match(/href="(https?:\/\/[^"]+)"/gi) || [];
  const externalLinks = allHrefs.filter(h => !h.includes('padeli.com')).length;
  checks.push({
    id: 'E09', domain: 'expert_seo', severity: externalLinks < 1 ? 'warning' : 'info',
    pass: externalLinks >= 1,
    message: `External links: ${externalLinks} (1+ recommended for authority signals)`,
  });

  // ── Images & Alt Text (Ahrefs: "image SEO") ──

  // E10: Images present
  const imgTags = rawContent.match(/<img\s/gi) || [];
  const imgTarget = contentType === 'listing' ? 1 : 3;
  checks.push({
    id: 'E10', domain: 'expert_seo', severity: imgTags.length < imgTarget ? 'warning' : 'info',
    pass: imgTags.length >= imgTarget,
    message: `Images in content: ${imgTags.length} (target ${imgTarget}+)`,
  });

  // E11: Alt text on images — keyword in at least one alt
  if (focusKw && imgTags.length > 0) {
    const altTexts = rawContent.match(/alt="([^"]*)"/gi) || [];
    const emptyAlts = altTexts.filter(a => a === 'alt=""').length;
    const kwInAlt = altTexts.some(a => a.toLowerCase().includes(focusKw));
    checks.push({
      id: 'E11', domain: 'expert_seo', severity: 'warning',
      pass: kwInAlt && emptyAlts === 0,
      message: kwInAlt
        ? `Keyword in image alt text. ${emptyAlts > 0 ? emptyAlts + ' image(s) have empty alt text.' : 'All alts populated.'}`
        : `Focus keyword not in any image alt text (${emptyAlts} empty alts)`,
    });
  }

  // ── Freshness & Technical (Ahrefs: "content freshness as ranking factor") ──

  // E12: Content freshness — date modified
  const modified = wp.modified || wp.modified_gmt || '';
  if (modified) {
    const modDate = new Date(modified);
    const daysSince = Math.floor((Date.now() - modDate.getTime()) / (1000 * 60 * 60 * 24));
    checks.push({
      id: 'E12', domain: 'expert_seo', severity: daysSince > 180 ? 'warning' : 'info',
      pass: daysSince <= 180,
      message: `Last modified: ${daysSince} days ago (${modDate.toISOString().split('T')[0]})${daysSince > 180 ? ' — consider refreshing' : ''}`,
    });
  }

  // E13: Featured image set (critical for OG/social + SERP rich results)
  checks.push({
    id: 'E13', domain: 'expert_seo', severity: 'warning',
    pass: !!wp.featured_media && wp.featured_media !== 0,
    message: wp.featured_media ? `Featured image set (media ID: ${wp.featured_media})` : 'No featured image — social shares and SERP will lack visual',
  });

  // E14: AEO — Direct Answer / TLDR present (Gotch: "AI bait" — extractable summary for LLM citations)
  const hasDA = lowerContent.includes('padeli-direct-answer') || lowerContent.includes('quick answer')
    || lowerContent.includes('tldr') || lowerContent.includes('tl;dr')
    || lowerContent.includes('key takeaway') || lowerContent.includes('in a nutshell');
  if (contentType === 'post') {
    checks.push({
      id: 'E14', domain: 'expert_seo', severity: 'info',
      pass: hasDA,
      message: hasDA
        ? 'Direct answer / TLDR block detected — good for AEO'
        : 'No direct answer block — consider adding a TLDR or key takeaway for AI citation',
    });
  }

  // E15: FAQ schema present (Ahrefs: "FAQ rich snippets still win clicks in 2025+")
  const hasFaqSchema = /"@type"\s*:\s*"FAQPage"/i.test(rawContent);
  checks.push({
    id: 'E15', domain: 'expert_seo', severity: 'warning',
    pass: hasFaqSchema,
    message: hasFaqSchema ? 'FAQPage schema present in content' : 'No FAQPage schema — missing FAQ rich snippet opportunity',
  });

  // E16: Table present (Gotch: "tables are AI bait — LLMs extract them preferentially")
  if (contentType === 'post') {
    const hasTable = /<table[\s>]/i.test(rawContent) || /wp:table/i.test(rawContent);
    checks.push({
      id: 'E16', domain: 'expert_seo', severity: 'info',
      pass: hasTable,
      message: hasTable
        ? 'Comparison table found — good for AEO extraction'
        : 'No table in content — tables improve scannability and LLM citation rates',
    });
  }

  // E17: List elements present (Ahrefs: "listicle formatting for featured snippets")
  const listCount = (rawContent.match(/<[ou]l[\s>]/gi) || []).length;
  if (contentType === 'post') {
    checks.push({
      id: 'E17', domain: 'expert_seo', severity: 'info',
      pass: listCount >= 1,
      message: `List elements: ${listCount} (bullet/numbered lists improve snippet eligibility)`,
    });
  }

  // ── Readability & Content Quality (Gotch: "write for skimmers") ──

  // E18: Sentence length — target >75% under 20 words (Gotch)
  const sentences = plainText.split(/[.!?]+/).filter(s => s.trim().length > 5);
  if (sentences.length > 5) {
    const shortSentences = sentences.filter(s => countWords(s.trim()) <= 20).length;
    const shortPct = Math.round((shortSentences / sentences.length) * 100);
    checks.push({
      id: 'E18', domain: 'expert_seo', severity: shortPct < 50 ? 'warning' : 'info',
      pass: shortPct >= 60,
      message: `Sentence brevity: ${shortPct}% under 20 words (${shortSentences}/${sentences.length} — target 75%+)`,
    });
  }

  // E19: Multiple H1 tags (Ahrefs: "prefer one H1 per page")
  const h1Tags = (rawContent.match(/<h1[\s>]/gi) || []).length;
  if (h1Tags > 1) {
    checks.push({
      id: 'E19', domain: 'expert_seo', severity: 'warning',
      pass: false,
      message: `Multiple H1 tags found: ${h1Tags} (should be exactly 1)`,
    });
  }

  // E20: Year in slug for evergreen content (Ahrefs: freshness signal in URL)
  if (contentType === 'post' && wp.slug) {
    const hasYear = /20\d{2}/.test(wp.slug);
    const currentYear = new Date().getFullYear();
    const yearMatch = wp.slug.match(/(20\d{2})/);
    if (hasYear && yearMatch) {
      const slugYear = parseInt(yearMatch[1], 10);
      checks.push({
        id: 'E20', domain: 'expert_seo', severity: slugYear < currentYear ? 'warning' : 'info',
        pass: slugYear >= currentYear,
        message: slugYear < currentYear
          ? `Slug contains outdated year "${slugYear}" — update slug and content for ${currentYear}`
          : `Slug year "${slugYear}" is current`,
      });
    }
  }

  // E21: Broken outbound links — check for common dead patterns
  const outboundHrefs = rawContent.match(/href="(https?:\/\/(?!(?:www\.)?padeli\.com)[^"]+)"/gi) || [];
  const suspectLinks = outboundHrefs.filter(h => {
    const url = h.match(/href="([^"]+)"/)?.[1] || '';
    return url.includes('bit.ly') || url.includes('tinyurl') || url.includes('#') && url.split('#')[0].length < 10;
  });
  if (suspectLinks.length > 0) {
    checks.push({
      id: 'E21', domain: 'expert_seo', severity: 'warning',
      pass: false,
      message: `${suspectLinks.length} suspicious outbound link(s) (shorteners or fragment-only) — verify they resolve`,
    });
  }

  // E22: Content depth — unique information signal (Ahrefs: "information gain")
  // Check for specific data points: numbers, prices, percentages, stats
  const dataPoints = plainText.match(/\d+(\.\d+)?(%|\s*(court|metre|meter|hour|minute|km|mile|club|venue|player|member|session))/gi) || [];
  if (contentType === 'post') {
    checks.push({
      id: 'E22', domain: 'expert_seo', severity: 'info',
      pass: dataPoints.length >= 5,
      message: `Specific data points: ${dataPoints.length} (numbers with units — more = higher information gain)`,
    });
  }

  // ── AEO: Agentic AI Readiness (Yoast: "discoverability in the agentic web") ──

  // E23: Definition pattern near top — "What is X?" or "X is..." in first 200 words
  // AI agents extract definition sentences preferentially for knowledge panels and summaries
  if (contentType === 'post') {
    const first200 = lowerPlain.split(/\s+/).slice(0, 200).join(' ');
    const hasDefinition = /\bwhat is\b/.test(first200)
      || /\bwhat are\b/.test(first200)
      || /\bis a\b.*\bthat\b/.test(first200)
      || /\bis an\b.*\bthat\b/.test(first200)
      || /\brefers to\b/.test(first200)
      || /\bdefined as\b/.test(first200);
    checks.push({
      id: 'E23', domain: 'expert_seo', severity: 'info',
      pass: hasDefinition,
      message: hasDefinition
        ? 'Definition pattern found in first 200 words — good for AI extraction'
        : 'No definition sentence in first 200 words — consider opening with "What is X" or "X is a..." for AI discoverability',
    });
  }

  // E24: Direct answer block position — DA/TLDR should be in first 200 words
  // Yoast: content must be "understandable, reliable, and usable by machines" — top-of-page placement matters
  if (contentType === 'post' && hasDA) {
    const first200Raw = rawContent.substring(0, rawContent.indexOf(' ', 1500) || 1500).toLowerCase();
    const daEarly = first200Raw.includes('padeli-direct-answer') || first200Raw.includes('quick answer')
      || first200Raw.includes('tldr') || first200Raw.includes('tl;dr')
      || first200Raw.includes('key takeaway');
    checks.push({
      id: 'E24', domain: 'expert_seo', severity: 'info',
      pass: daEarly,
      message: daEarly
        ? 'Direct answer block is near top of content — optimal for AI extraction'
        : 'Direct answer block exists but is buried deep in content — move it to the first 200 words for better AI citation',
    });
  }

  // E25: Entity naming consistency — title, meta desc, H1, and schema should use the same core entity name
  // Yoast: "machine-readable semantic clarity" — inconsistent naming confuses AI entity resolution
  if (contentType === 'listing') {
    const venueName = (wp.title?.raw || wp.title?.rendered || '').replace(/<[^>]+>/g, '').trim();
    if (venueName) {
      const vnLower = venueName.toLowerCase();
      const metaDesc = (meta._yoast_wpseo_metadesc || '').toLowerCase();
      const yoastTitle = (meta._yoast_wpseo_title || '').toLowerCase();
      const inBody = lowerContent.includes(vnLower);
      const inMeta = metaDesc.includes(vnLower);
      const inTitle = yoastTitle.includes(vnLower);
      const inSchema = rawContent.toLowerCase().includes(`"name"`) && rawContent.toLowerCase().includes(vnLower);
      const matches = [inBody, inMeta, inTitle].filter(Boolean).length;
      checks.push({
        id: 'E25', domain: 'expert_seo', severity: matches < 2 ? 'warning' : 'info',
        pass: matches >= 2,
        message: matches >= 3
          ? `Entity name "${venueName}" consistent across body, meta desc, and Yoast title`
          : `Entity name "${venueName}" — found in ${[inBody && 'body', inMeta && 'meta desc', inTitle && 'Yoast title'].filter(Boolean).join(', ') || 'none'} — inconsistent naming hurts AI entity resolution`,
      });
    }
  }

  // E26: Published/updated date visibility — AI agents use date signals for freshness and citation trust
  // Yoast: dates must be "visible to crawlers, not just in schema"
  {
    const hasDateModified = /"dateModified"/.test(rawContent) || /"datePublished"/.test(rawContent);
    const hasVisibleDate = /\b(published|updated|last updated|modified)\b/i.test(lowerContent)
      || /<time[\s>]/i.test(rawContent);
    checks.push({
      id: 'E26', domain: 'expert_seo', severity: 'info',
      pass: hasDateModified && hasVisibleDate,
      message: hasDateModified && hasVisibleDate
        ? 'Date signals present in schema and visible content'
        : `Date signals: ${hasDateModified ? 'schema yes' : 'schema no'}, ${hasVisibleDate ? 'visible yes' : 'visible no'} — AI agents use both for freshness trust`,
    });
  }

  // E27: Structured step-by-step content — ordered lists with instructional patterns
  // Yoast: "content designed for extraction — step-by-step explanations"
  if (contentType === 'post') {
    const hasOrderedList = /<ol[\s>]/i.test(rawContent);
    const hasHowTo = /\bstep\s*\d/i.test(lowerContent) || /\bhow to\b/i.test(lowerContent);
    const hasHowToSchema = /"@type"\s*:\s*"HowTo"/i.test(rawContent);
    const stepReady = hasOrderedList || hasHowToSchema;
    checks.push({
      id: 'E27', domain: 'expert_seo', severity: 'info',
      pass: stepReady || !hasHowTo,
      message: hasHowTo
        ? (stepReady
          ? 'How-to content uses ordered lists or HowTo schema — good for AI workflow extraction'
          : 'Content has how-to language but no ordered list or HowTo schema — AI agents prefer structured steps')
        : 'No how-to patterns detected (not applicable)',
    });
  }

  // E28: Unique data points for citation authority — original stats, specific numbers, proprietary info
  // Yoast: "citation signals" — AI cites content with original, specific data over generic advice
  if (contentType === 'post') {
    const pricePoints = (plainText.match(/[£$€]\s*\d+/g) || []).length;
    const percentages = (plainText.match(/\d+(\.\d+)?%/g) || []).length;
    const specificMetrics = (plainText.match(/\d+\s*(court|club|venue|player|member|rating|review|star)/gi) || []).length;
    const totalUnique = pricePoints + percentages + specificMetrics;
    checks.push({
      id: 'E28', domain: 'expert_seo', severity: totalUnique < 3 ? 'warning' : 'info',
      pass: totalUnique >= 5,
      message: `Citation-worthy data points: ${totalUnique} (${pricePoints} prices, ${percentages} percentages, ${specificMetrics} specific metrics) — more original data = more AI citations`,
    });
  }

  const passed = checks.filter(c => c.pass).length;
  const score = checks.length > 0 ? Math.round((passed / checks.length) * 100) : 0;

  return { checks, score };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 4: GSC/GA Performance
// ─────────────────────────────────────────────────────────────────────────────

const https = require('https');
const fs = require('fs');
const path = require('path');

const GSC_TOKEN_PATH = path.join(process.env.HOME || '', '.config/gcloud/padeli-oauth-token.json');
const GSC_SITE_URL = 'https://padeli.com/';
const GA4_PROPERTY_ID = 'properties/530686060'; // Padeli.com GA4

/**
 * Load OAuth token and get a fresh access token.
 * @returns {Promise<string|null>} access token or null if not configured
 */
async function getAccessToken() {
  if (!fs.existsSync(GSC_TOKEN_PATH)) return null;
  const token = JSON.parse(fs.readFileSync(GSC_TOKEN_PATH, 'utf8'));
  if (!token.client_id || !token.client_secret || !token.refresh_token) return null;

  return new Promise((resolve, reject) => {
    const postData = new URLSearchParams({
      client_id: token.client_id,
      client_secret: token.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    }).toString();
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData) },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.access_token) resolve(parsed.access_token);
          else reject(new Error(parsed.error || 'No access token'));
        } catch { reject(new Error('Bad token response')); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Make an HTTPS request with JSON body and auth header.
 * @param {string} url
 * @param {string} accessToken
 * @param {object} [body] - POST body (if provided, sends POST; otherwise GET)
 * @returns {Promise<object>}
 */
function apiRequest(url, accessToken, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    };
    if (body) {
      const jsonBody = JSON.stringify(body);
      opts.headers['Content-Type'] = 'application/json';
      opts.headers['Content-Length'] = Buffer.byteLength(jsonBody);
    }
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Bad response: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Fetch GSC search analytics for a specific page URL.
 * Returns clicks, impressions, CTR, position, top queries, and trend data.
 * @param {string} pageUrl - full URL (e.g. https://padeli.com/best-padel-courts-london-2026/)
 * @returns {Promise<object>}
 */
async function fetchGSCData(pageUrl) {
  if (!pageUrl) return { available: false, message: 'No URL provided', data: null };

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { available: false, message: 'GSC OAuth token refresh failed — re-run gsc-oauth-setup.js', data: null };
  }
  if (!accessToken) {
    return { available: false, message: 'GSC not configured — run gsc-oauth-setup.js first', data: null };
  }

  const siteEncoded = encodeURIComponent(GSC_SITE_URL);
  const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${siteEncoded}/searchAnalytics/query`;

  // Date ranges: last 28 days vs previous 28 days
  const now = new Date();
  const endDate = new Date(now);
  endDate.setDate(endDate.getDate() - 2); // GSC data has ~2 day lag
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - 27);
  const prevEnd = new Date(startDate);
  prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd);
  prevStart.setDate(prevStart.getDate() - 27);

  const fmt = d => d.toISOString().split('T')[0];

  try {
    // Current period: page-level totals
    const currentTotals = await apiRequest(endpoint, accessToken, {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['page'],
      dimensionFilterGroups: [{
        filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }],
      }],
      rowLimit: 1,
    });

    // Current period: top queries for this page
    const currentQueries = await apiRequest(endpoint, accessToken, {
      startDate: fmt(startDate),
      endDate: fmt(endDate),
      dimensions: ['query'],
      dimensionFilterGroups: [{
        filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }],
      }],
      rowLimit: 10,
    });

    // Previous period: page-level totals (for trend)
    const prevTotals = await apiRequest(endpoint, accessToken, {
      startDate: fmt(prevStart),
      endDate: fmt(prevEnd),
      dimensions: ['page'],
      dimensionFilterGroups: [{
        filters: [{ dimension: 'page', operator: 'equals', expression: pageUrl }],
      }],
      rowLimit: 1,
    });

    const current = currentTotals.rows?.[0] || null;
    const prev = prevTotals.rows?.[0] || null;
    const queries = (currentQueries.rows || []).map(r => ({
      query: r.keys[0],
      clicks: r.clicks,
      impressions: r.impressions,
      ctr: r.ctr,
      position: r.position,
    }));

    // Performance signals
    const signals = [];
    if (current) {
      if (current.position > 20) signals.push({ id: 'G01', severity: 'warning', message: `Avg position ${current.position.toFixed(1)} — not on page 1-2` });
      else if (current.position > 10) signals.push({ id: 'G01', severity: 'info', message: `Avg position ${current.position.toFixed(1)} — page 2, close to page 1` });

      if (current.impressions > 50 && current.clicks === 0) signals.push({ id: 'G02', severity: 'error', message: `${current.impressions} impressions but 0 clicks — title/meta needs work` });
      else if (current.impressions > 0 && current.ctr < 0.02) signals.push({ id: 'G02', severity: 'warning', message: `CTR ${(current.ctr * 100).toFixed(1)}% is below 2% — review title and meta description` });

      if (current.impressions < 10) signals.push({ id: 'G03', severity: 'info', message: `Only ${current.impressions} impressions — page may need more authority or backlinks` });

      // Expected CTR by position (rough benchmarks)
      if (current.position <= 3 && current.ctr < 0.05) signals.push({ id: 'G04', severity: 'warning', message: `Position ${current.position.toFixed(1)} but CTR only ${(current.ctr * 100).toFixed(1)}% — expected 5%+ for top 3` });
      else if (current.position <= 10 && current.ctr < 0.01) signals.push({ id: 'G04', severity: 'warning', message: `Page 1 position but CTR under 1% — title may not be compelling` });
    }

    // Trend signals
    if (current && prev) {
      const clickDelta = current.clicks - prev.clicks;
      const impDelta = current.impressions - prev.impressions;
      const posDelta = current.position - prev.position; // positive = worse

      if (posDelta > 3) signals.push({ id: 'G05', severity: 'warning', message: `Position dropped ${posDelta.toFixed(1)} places vs previous period` });
      else if (posDelta < -3) signals.push({ id: 'G05', severity: 'info', message: `Position improved ${Math.abs(posDelta).toFixed(1)} places vs previous period` });

      if (impDelta < 0 && Math.abs(impDelta) > prev.impressions * 0.3) signals.push({ id: 'G06', severity: 'warning', message: `Impressions dropped ${Math.abs(impDelta)} (${Math.round(Math.abs(impDelta) / Math.max(prev.impressions, 1) * 100)}%) vs previous period` });
    }

    if (!current) signals.push({ id: 'G07', severity: 'info', message: 'No GSC data for this URL in the last 28 days — page may be new or not indexed' });

    return {
      available: true,
      data: {
        period: { start: fmt(startDate), end: fmt(endDate) },
        clicks: current?.clicks || 0,
        impressions: current?.impressions || 0,
        ctr: current?.ctr || 0,
        position: current?.position || null,
        queries,
        trend: prev ? {
          prevClicks: prev.clicks,
          prevImpressions: prev.impressions,
          prevPosition: prev.position,
          clickDelta: (current?.clicks || 0) - prev.clicks,
          impressionDelta: (current?.impressions || 0) - prev.impressions,
          positionDelta: (current?.position || 0) - prev.position,
        } : null,
      },
      signals,
    };
  } catch (err) {
    return { available: false, message: `GSC API error: ${err.message}`, data: null };
  }
}

/**
 * Fetch GA4 data for a specific page. Requires GA4_PROPERTY_ID to be set.
 * @param {string} pageUrl
 * @returns {Promise<object>}
 */
async function fetchGAData(pageUrl) {
  if (!GA4_PROPERTY_ID) {
    return { available: false, message: 'GA4 property ID not configured — set GA4_PROPERTY_ID in content-auditor.js', data: null };
  }
  if (!pageUrl) return { available: false, message: 'No URL provided', data: null };

  let accessToken;
  try {
    accessToken = await getAccessToken();
  } catch {
    return { available: false, message: 'OAuth token refresh failed', data: null };
  }
  if (!accessToken) return { available: false, message: 'OAuth not configured', data: null };

  const pagePath = pageUrl.replace('https://padeli.com', '').replace('http://padeli.com', '');

  try {
    const result = await apiRequest(
      `https://analyticsdata.googleapis.com/v1beta/${GA4_PROPERTY_ID}:runReport`,
      accessToken,
      {
        dateRanges: [{ startDate: '28daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [
          { name: 'screenPageViews' },
          { name: 'totalUsers' },
          { name: 'averageSessionDuration' },
          { name: 'bounceRate' },
          { name: 'engagementRate' },
        ],
        dimensionFilter: {
          filter: { fieldName: 'pagePath', stringFilter: { matchType: 'EXACT', value: pagePath } },
        },
        limit: 1,
      }
    );

    if (result.error) {
      return { available: false, message: `GA4 error: ${result.error.message}`, data: null };
    }

    const row = result.rows?.[0];
    if (!row) return { available: true, data: { pageviews: 0, users: 0, avgDuration: 0, bounceRate: 0, engagementRate: 0 }, signals: [{ id: 'GA1', severity: 'info', message: 'No GA4 data for this page in the last 28 days' }] };

    const metrics = row.metricValues;
    const data = {
      pageviews: parseInt(metrics[0]?.value || 0),
      users: parseInt(metrics[1]?.value || 0),
      avgDuration: parseFloat(metrics[2]?.value || 0),
      bounceRate: parseFloat(metrics[3]?.value || 0),
      engagementRate: parseFloat(metrics[4]?.value || 0),
    };

    const signals = [];
    if (data.bounceRate > 0.8) signals.push({ id: 'GA2', severity: 'warning', message: `Bounce rate ${(data.bounceRate * 100).toFixed(0)}% — content may not match search intent` });
    if (data.avgDuration < 30 && data.pageviews > 10) signals.push({ id: 'GA3', severity: 'warning', message: `Avg session ${data.avgDuration.toFixed(0)}s — users leaving quickly` });
    if (data.engagementRate < 0.4) signals.push({ id: 'GA4', severity: 'info', message: `Engagement rate ${(data.engagementRate * 100).toFixed(0)}% — below 40% threshold` });

    return { available: true, data, signals };
  } catch (err) {
    return { available: false, message: `GA4 API error: ${err.message}`, data: null };
  }
}

// Layer 5: Ahrefs (stub — ready for Ahrefs Lite API)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stub for Ahrefs API data. Ready to implement when Ahrefs Lite subscription is active.
 * Will provide: keyword difficulty, backlink count, referring domains, traffic estimate,
 * content gap analysis, competitor comparison.
 * @param {string} pageUrl
 * @returns {Promise<object>}
 */
async function fetchAhrefsData(pageUrl) {
  return {
    available: false,
    message: 'Ahrefs API not configured — waiting for Ahrefs Lite subscription',
    data: null,
    signals: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer 6: Link Validation
// Checks all external URLs in content body and meta fields for broken links.
// Uses HTTP HEAD requests with redirect following, 5s timeout, no npm deps.
// ─────────────────────────────────────────────────────────────────────────────

const http = require('http');

/**
 * Make an HTTP HEAD request to check if a URL is reachable.
 * Follows redirects (up to maxRedirects), 5s timeout, returns status info.
 * @param {string} url
 * @param {number} [redirectsLeft=5]
 * @returns {Promise<{url: string, status: number|null, ok: boolean, category: string, message: string}>}
 */
function checkUrl(url, redirectsLeft = 5) {
  return new Promise((resolve) => {
    if (redirectsLeft <= 0) {
      resolve({ url, status: null, ok: false, category: 'FAIL', message: 'Too many redirects (>5)' });
      return;
    }

    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ url, status: null, ok: false, category: 'FAIL', message: `Invalid URL: ${url}` });
      return;
    }

    const transport = parsed.protocol === 'https:' ? https : http;
    const opts = {
      method: 'HEAD',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { 'User-Agent': 'Mozilla/5.0 (PadeliLinkChecker)' },
      timeout: 5000,
    };

    const req = transport.request(opts, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        let redirectUrl = res.headers.location;
        if (redirectUrl.startsWith('/')) {
          redirectUrl = `${parsed.protocol}//${parsed.host}${redirectUrl}`;
        }
        resolve(checkUrl(redirectUrl, redirectsLeft - 1));
        return;
      }

      const status = res.statusCode;
      if (status >= 200 && status < 400) {
        resolve({ url, status, ok: true, category: 'PASS', message: `HTTP ${status}` });
      } else if (status === 404 || status === 410) {
        resolve({ url, status, ok: false, category: 'FAIL', message: `HTTP ${status} — link is dead` });
      } else if (status >= 500) {
        resolve({ url, status, ok: false, category: 'WARN', message: `HTTP ${status} — server error (may be temporary)` });
      } else if (status === 403) {
        // Many sites block HEAD requests — treat as WARN not FAIL
        resolve({ url, status, ok: false, category: 'WARN', message: `HTTP ${status} — access denied (may block bots)` });
      } else {
        resolve({ url, status, ok: false, category: 'WARN', message: `HTTP ${status}` });
      }
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ url, status: null, ok: false, category: 'WARN', message: 'Timeout (5s) — host may be slow or unreachable' });
    });

    req.on('error', (err) => {
      const msg = err.message || '';
      if (msg.includes('CERT') || msg.includes('SSL') || msg.includes('TLS')) {
        resolve({ url, status: null, ok: false, category: 'WARN', message: `SSL error: ${msg}` });
      } else {
        resolve({ url, status: null, ok: false, category: 'FAIL', message: `Connection error: ${msg}` });
      }
    });

    req.end();
  });
}

/**
 * Extract all external URLs from HTML body (href attributes from <a> tags).
 * @param {string} html
 * @returns {string[]} unique external URLs
 */
function extractBodyUrls(html) {
  const urls = new Set();
  const hrefRegex = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>/gi;
  let match;
  while ((match = hrefRegex.exec(html)) !== null) {
    const url = match[1];
    // Skip internal links
    if (!url.includes('padeli.com')) {
      urls.add(url);
    }
  }
  return [...urls];
}

/**
 * Extract meta URLs from listing/post meta fields.
 * @param {object} meta - WP meta object
 * @returns {string[]} unique meta URLs
 */
function extractMetaUrls(meta) {
  const urls = new Set();
  const fields = ['_booking_link', '_playtomic_url', '_direct_booking_url', '_website'];
  for (const field of fields) {
    const val = meta[field];
    if (val && typeof val === 'string' && /^https?:\/\//.test(val)) {
      urls.add(val);
    }
  }
  return [...urls];
}

/**
 * Validate all external links in a WP listing or post.
 * Extracts URLs from body HTML and meta fields, then checks each with HEAD requests.
 *
 * @param {object} wp - WP REST object (context=edit)
 * @param {string} contentType - 'listing' or 'post'
 * @returns {Promise<{checks: Array<{id: string, pass: boolean, severity: string, message: string, domain: string, url: string}>, score: number, summary: {total: number, passed: number, failed: number, warned: number}}>}
 */
async function validateLinks(wp, contentType) {
  const checks = [];
  const rawContent = typeof wp.content === 'string'
    ? wp.content
    : (wp.content?.raw || wp.content?.rendered || '');
  const meta = wp.meta || {};

  // Collect all URLs
  const bodyUrls = extractBodyUrls(rawContent);
  const metaUrls = extractMetaUrls(meta);
  const allUrls = [...new Set([...bodyUrls, ...metaUrls])];

  if (allUrls.length === 0) {
    checks.push({
      id: 'LK01', domain: 'links', pass: true, severity: 'info', url: '',
      message: 'No external links found to validate',
    });
    return { checks, score: 100, summary: { total: 0, passed: 0, failed: 0, warned: 0 } };
  }

  // Check each URL with rate limiting (200ms between requests)
  let passed = 0;
  let failed = 0;
  let warned = 0;
  let checkNum = 1;

  for (const url of allUrls) {
    const result = await checkUrl(url);
    const source = metaUrls.includes(url) ? ' [meta]' : '';
    const id = `LK${String(checkNum).padStart(2, '0')}`;
    checkNum++;

    if (result.category === 'PASS') {
      passed++;
      checks.push({
        id, domain: 'links', pass: true, severity: 'info', url,
        message: `${result.message} — ${url}${source}`,
      });
    } else if (result.category === 'FAIL') {
      failed++;
      checks.push({
        id, domain: 'links', pass: false, severity: 'error', url,
        message: `${result.message} — ${url}${source}`,
      });
    } else {
      warned++;
      checks.push({
        id, domain: 'links', pass: false, severity: 'warning', url,
        message: `${result.message} — ${url}${source}`,
      });
    }

    // Rate limit between requests
    if (allUrls.indexOf(url) < allUrls.length - 1) {
      await sleep(200);
    }
  }

  const total = allUrls.length;
  const score = total > 0 ? Math.round((passed / total) * 100) : 100;

  return {
    checks,
    score,
    summary: { total, passed, failed, warned },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator: Full Audit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run a full audit on a single listing (all 4 layers).
 * @param {number} id - WP listing ID
 * @param {object} [opts]
 * @param {boolean} [opts.skipLive] - skip layer 3 rendered page checks
 * @returns {Promise<object>}
 */
async function auditSingleListing(id, opts = {}) {
  console.log(`[auditor] Fetching listing ${id}...`);
  const wp = await fetchListing(id);
  const qcResult = auditListing(wp);
  const yoast = analyseYoastSeo(wp);
  const expert = analyseExpertSeo(wp, 'listing');

  let liveResult = null;
  if (!opts.skipLive && wp.status === 'publish' && wp.link) {
    console.log(`[auditor] Checking rendered page: ${wp.link}`);
    liveResult = await auditRenderedPage(wp.link);
  }

  const pageUrl = wp.link || '';
  const [gsc, ga, ahrefs] = await Promise.all([
    fetchGSCData(pageUrl),
    fetchGAData(pageUrl),
    fetchAhrefsData(pageUrl),
  ]);

  // Layer 6: Link validation
  let links = null;
  if (!opts.skipLinks) {
    console.log(`[auditor] Validating external links...`);
    links = await validateLinks(wp, 'listing');
  }

  // Composite score: QC 40%, Yoast 30%, Expert 30%
  const compositeScore = Math.round(
    (qcResult.score * 0.4) + (yoast.score * 0.3) + (expert.score * 0.3)
  );

  return {
    ...qcResult,
    score: compositeScore,
    yoast,
    expert,
    live: liveResult,
    gsc,
    ga,
    ahrefs,
    links,
    auditedAt: new Date().toISOString(),
  };
}

/**
 * Run a full audit on a single blog post (all 5 layers).
 * @param {string|number} idOrSlug - WP post ID or slug
 * @param {object} [opts]
 * @param {boolean} [opts.skipLive] - skip layer 3 rendered page checks
 * @returns {Promise<object>}
 */
async function auditSinglePost(idOrSlug, opts = {}) {
  console.log(`[auditor] Fetching post ${idOrSlug}...`);
  const wp = await fetchPost(idOrSlug);
  const qcResult = auditPost(wp);
  const yoast = analyseYoastSeo(wp);
  const expert = analyseExpertSeo(wp, 'post');

  let liveResult = null;
  if (!opts.skipLive && wp.status === 'publish' && wp.link) {
    console.log(`[auditor] Checking rendered page: ${wp.link}`);
    liveResult = await auditRenderedPage(wp.link);
  }

  const pageUrl = wp.link || '';
  const [gsc, ga, ahrefs] = await Promise.all([
    fetchGSCData(pageUrl),
    fetchGAData(pageUrl),
    fetchAhrefsData(pageUrl),
  ]);

  // Layer 6: Link validation
  let links = null;
  if (!opts.skipLinks) {
    console.log(`[auditor] Validating external links...`);
    links = await validateLinks(wp, 'post');
  }

  // Composite score: QC 35%, Yoast 25%, Expert 25%, Live 15%
  const liveScore = liveResult
    ? Math.round((liveResult.checks.filter(c => c.pass).length / Math.max(liveResult.checks.length, 1)) * 100)
    : 0;
  const compositeScore = Math.round(
    (qcResult.score * 0.35) + (yoast.score * 0.25) + (expert.score * 0.25) + (liveScore * 0.15)
  );

  return {
    ...qcResult,
    score: compositeScore,
    yoast,
    expert,
    live: liveResult,
    gsc,
    ga,
    ahrefs,
    links,
    auditedAt: new Date().toISOString(),
  };
}

/**
 * Batch audit: run QC on multiple listings.
 * @param {object} [opts]
 * @param {string} [opts.status] - 'publish', 'draft', 'any'
 * @param {number} [opts.limit] - max to audit (0 = all)
 * @param {boolean} [opts.skipLive] - skip rendered page checks
 * @returns {Promise<object>} { results, summary }
 */
async function auditAllListings(opts = {}) {
  console.log('[auditor] Fetching all listings...');
  const listings = await fetchAllListings({ status: opts.status || 'any', limit: opts.limit });
  console.log(`[auditor] Auditing ${listings.length} listings...`);

  const results = [];
  for (const wp of listings) {
    try {
      const qcResult = auditListing(wp);
      const yoast = analyseYoastSeo(wp);
      const expert = analyseExpertSeo(wp, 'listing');
      let liveResult = null;
      if (!opts.skipLive && wp.status === 'publish' && wp.link) {
        liveResult = await auditRenderedPage(wp.link);
      }
      const compositeScore = Math.round(
        (qcResult.score * 0.4) + (yoast.score * 0.3) + (expert.score * 0.3)
      );
      results.push({ ...qcResult, score: compositeScore, yoast, expert, live: liveResult });
    } catch (err) {
      results.push({
        id: wp.id,
        slug: wp.slug,
        name: extractVenueName(wp),
        type: 'listing',
        error: err.message,
      });
    }
    // Rate limit: 200ms between live fetches
    if (!opts.skipLive) await sleep(200);
  }

  return { results, summary: buildSummary(results, 'listing') };
}

/**
 * Batch audit: run QC on multiple blog posts.
 * @param {object} [opts]
 * @param {string} [opts.status] - 'publish', 'draft'
 * @param {number} [opts.limit] - max to audit (0 = all)
 * @param {boolean} [opts.skipLive] - skip rendered page checks
 * @returns {Promise<object>} { results, summary }
 */
async function auditAllPosts(opts = {}) {
  console.log('[auditor] Fetching all blog posts...');
  const posts = await fetchAllPosts({ status: opts.status || 'publish', limit: opts.limit });
  console.log(`[auditor] Auditing ${posts.length} posts...`);

  const results = [];
  for (const wp of posts) {
    try {
      const qcResult = auditPost(wp);
      const yoast = analyseYoastSeo(wp);
      const expert = analyseExpertSeo(wp, 'post');
      let liveResult = null;
      if (!opts.skipLive && wp.status === 'publish' && wp.link) {
        liveResult = await auditRenderedPage(wp.link);
      }
      const liveScore = liveResult
        ? Math.round((liveResult.checks.filter(c => c.pass).length / Math.max(liveResult.checks.length, 1)) * 100)
        : 0;
      const compositeScore = Math.round(
        (qcResult.score * 0.35) + (yoast.score * 0.25) + (expert.score * 0.25) + (liveScore * 0.15)
      );
      results.push({ ...qcResult, score: compositeScore, yoast, expert, live: liveResult });
    } catch (err) {
      results.push({
        id: wp.id,
        slug: wp.slug,
        name: wp.title?.raw || wp.title?.rendered || '',
        type: 'post',
        error: err.message,
      });
    }
    if (!opts.skipLive) await sleep(200);
  }

  return { results, summary: buildSummary(results, 'post') };
}

/**
 * Full site audit: listings + posts.
 * @param {object} [opts]
 * @param {boolean} [opts.skipLive]
 * @param {number} [opts.listingLimit]
 * @param {number} [opts.postLimit]
 * @returns {Promise<object>}
 */
async function auditFullSite(opts = {}) {
  const [listings, posts] = await Promise.all([
    auditAllListings({ skipLive: opts.skipLive, limit: opts.listingLimit }),
    auditAllPosts({ skipLive: opts.skipLive, limit: opts.postLimit }),
  ]);

  return {
    listings,
    posts,
    totals: {
      listings: listings.summary,
      posts: posts.summary,
      combined: {
        total: listings.summary.total + posts.summary.total,
        passed: listings.summary.passed + posts.summary.passed,
        failed: listings.summary.failed + posts.summary.failed,
        fetchErrors: listings.summary.fetchErrors + posts.summary.fetchErrors,
        avgScore: Math.round(
          (listings.summary.avgScore * listings.summary.total +
           posts.summary.avgScore * posts.summary.total) /
          Math.max(listings.summary.total + posts.summary.total, 1)
        ),
      },
    },
    auditedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Report Generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a summary from audit results.
 * @param {Array} results
 * @param {string} contentType - 'listing' or 'post'
 * @returns {object}
 */
function buildSummary(results, contentType) {
  const valid = results.filter(r => !r.error);
  const passed = valid.filter(r => r.pass);
  const failed = valid.filter(r => !r.pass);
  const fetchErrors = results.filter(r => r.error);

  const scores = valid.map(r => r.score || 0);
  const avgScore = scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : 0;

  // Most common errors
  const errorCounts = {};
  for (const r of valid) {
    for (const e of (r.errors || [])) {
      const code = e.match(/^\[([^\]]+)\]/)?.[1] || 'unknown';
      errorCounts[code] = (errorCounts[code] || 0) + 1;
    }
  }
  const topErrors = Object.entries(errorCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([code, count]) => ({ code, count, pct: Math.round((count / valid.length) * 100) }));

  // Worst performers
  const worstPerformers = valid
    .filter(r => !r.pass)
    .sort((a, b) => (b.errors?.length || 0) - (a.errors?.length || 0))
    .slice(0, 10)
    .map(r => ({ id: r.id, name: r.name, slug: r.slug, errors: r.errors?.length || 0, warnings: r.warnings?.length || 0 }));

  return {
    contentType,
    total: results.length,
    passed: passed.length,
    failed: failed.length,
    fetchErrors: fetchErrors.length,
    passRate: results.length > 0 ? Math.round((passed.length / valid.length) * 100) : 0,
    avgScore,
    topErrors,
    worstPerformers,
  };
}

/**
 * Format an audit result as a human-readable report string.
 * @param {object} result - single audit result
 * @returns {string}
 */
function formatSingleReport(result) {
  const lines = [];
  const icon = result.pass ? 'PASS' : 'FAIL';
  lines.push(`${icon} — ${result.name} (ID: ${result.id})`);
  lines.push(`  Type: ${result.type}${result.postType ? ` (${result.postType})` : ''}`);
  lines.push(`  Status: ${result.status}`);
  lines.push(`  Score: ${result.score || 0}%`);
  lines.push(`  Link: ${result.link || 'n/a'}`);

  if (result.errors?.length > 0) {
    lines.push(`  Errors (${result.errors.length}):`);
    for (const e of result.errors) lines.push(`    - ${e}`);
  }
  if (result.warnings?.length > 0) {
    lines.push(`  Warnings (${result.warnings.length}):`);
    for (const w of result.warnings) lines.push(`    - ${w}`);
  }

  if (result.yoast) {
    const yoastFails = result.yoast.checks.filter(c => !c.pass);
    if (yoastFails.length > 0) {
      lines.push(`  Yoast SEO Issues (${yoastFails.length}, score: ${result.yoast.score}%):`);
      for (const c of yoastFails) lines.push(`    - [${c.id}] ${c.message}`);
    } else {
      lines.push(`  Yoast SEO: all checks passed (${result.yoast.score}%)`);
    }
  }

  if (result.expert) {
    const expertFails = result.expert.checks.filter(c => !c.pass && c.severity !== 'info');
    const expertInfo = result.expert.checks.filter(c => !c.pass && c.severity === 'info');
    if (expertFails.length > 0) {
      lines.push(`  Expert SEO Issues (${expertFails.length}, score: ${result.expert.score}%):`);
      for (const c of expertFails) lines.push(`    - [${c.id}] ${c.message}`);
    } else {
      lines.push(`  Expert SEO: all critical checks passed (${result.expert.score}%)`);
    }
    if (expertInfo.length > 0) {
      lines.push(`  SEO Opportunities (${expertInfo.length}):`);
      for (const c of expertInfo) lines.push(`    - [${c.id}] ${c.message}`);
    }
  }

  if (result.live) {
    const liveFails = result.live.checks.filter(c => !c.pass);
    if (liveFails.length > 0) {
      lines.push(`  Live Page Issues (${liveFails.length}):`);
      for (const c of liveFails) lines.push(`    - [${c.id}] ${c.message}`);
    } else {
      lines.push('  Live Page: all checks passed');
    }
  }

  if (result.gsc) {
    if (result.gsc.available && result.gsc.data) {
      const g = result.gsc.data;
      lines.push(`  GSC Performance (${g.period.start} to ${g.period.end}):`);
      lines.push(`    Clicks: ${g.clicks} | Impressions: ${g.impressions} | CTR: ${(g.ctr * 100).toFixed(1)}% | Avg Position: ${g.position ? g.position.toFixed(1) : 'n/a'}`);
      if (g.trend) {
        const arrow = v => v > 0 ? `+${v}` : `${v}`;
        lines.push(`    Trend vs prev 28d: clicks ${arrow(g.trend.clickDelta)}, impressions ${arrow(g.trend.impressionDelta)}, position ${g.trend.positionDelta > 0 ? `+${g.trend.positionDelta.toFixed(1)} (worse)` : `${g.trend.positionDelta.toFixed(1)} (better)`}`);
      }
      if (g.queries.length > 0) {
        lines.push(`    Top Queries:`);
        for (const q of g.queries.slice(0, 5)) {
          lines.push(`      "${q.query}" — ${q.clicks} clicks, ${q.impressions} imp, pos ${q.position.toFixed(1)}`);
        }
      }
      if (result.gsc.signals?.length > 0) {
        lines.push(`    Signals:`);
        for (const s of result.gsc.signals) lines.push(`      - [${s.id}] ${s.message}`);
      }
    } else {
      lines.push(`  GSC: ${result.gsc.message}`);
    }
  }

  if (result.ga) {
    if (result.ga.available && result.ga.data) {
      const a = result.ga.data;
      lines.push(`  GA4 Performance (last 28 days):`);
      lines.push(`    Pageviews: ${a.pageviews} | Users: ${a.users} | Avg Duration: ${a.avgDuration.toFixed(0)}s | Bounce: ${(a.bounceRate * 100).toFixed(0)}% | Engagement: ${(a.engagementRate * 100).toFixed(0)}%`);
      if (result.ga.signals?.length > 0) {
        for (const s of result.ga.signals) lines.push(`    - [${s.id}] ${s.message}`);
      }
    } else {
      lines.push(`  GA4: ${result.ga.message}`);
    }
  }

  if (result.ahrefs) {
    if (!result.ahrefs.available) {
      lines.push(`  Ahrefs: ${result.ahrefs.message}`);
    }
  }

  if (result.links) {
    const s = result.links.summary;
    const linkFails = result.links.checks.filter(c => c.severity === 'error');
    const linkWarns = result.links.checks.filter(c => c.severity === 'warning');
    lines.push(`  Link Validation (${s.total} links — ${s.passed} ok, ${s.failed} broken, ${s.warned} warnings):`);
    if (linkFails.length > 0) {
      for (const c of linkFails) lines.push(`    BROKEN: ${c.message}`);
    }
    if (linkWarns.length > 0) {
      for (const c of linkWarns) lines.push(`    WARN: ${c.message}`);
    }
    if (linkFails.length === 0 && linkWarns.length === 0) {
      lines.push('    All external links are healthy');
    }
  }

  return lines.join('\n');
}

/**
 * Format a batch summary as a human-readable report string.
 * @param {object} summary
 * @returns {string}
 */
function formatBatchSummary(summary) {
  const lines = [];
  lines.push(`=== ${summary.contentType.toUpperCase()} AUDIT SUMMARY ===`);
  lines.push(`Total: ${summary.total} | Passed: ${summary.passed} | Failed: ${summary.failed} | Errors: ${summary.fetchErrors}`);
  lines.push(`Pass Rate: ${summary.passRate}% | Avg Score: ${summary.avgScore}%`);

  if (summary.topErrors.length > 0) {
    lines.push('\nTop Issues:');
    for (const e of summary.topErrors) {
      lines.push(`  [${e.code}] — ${e.count} occurrences (${e.pct}%)`);
    }
  }

  if (summary.worstPerformers.length > 0) {
    lines.push('\nWorst Performers:');
    for (const p of summary.worstPerformers) {
      lines.push(`  #${p.id} ${p.name} — ${p.errors} errors, ${p.warnings} warnings`);
    }
  }

  return lines.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix Mode: Opening Hours
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Check whether a listing's _opening_hours meta is missing or incomplete.
 * Mirrors the QC [M35] check — empty/missing or fewer than 7 days covered.
 */
function needsHoursFix(meta) {
  const s = typeof meta?._opening_hours === 'string' ? meta._opening_hours.trim() : '';
  if (!s) return { needs: true, reason: 'empty_or_missing' };
  const ALL = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const covered = new Set();
  for (const entry of s.split(',').map(x => x.trim())) {
    const m = entry.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\b/);
    if (!m) continue;
    const a = ALL.indexOf(m[1]);
    const b = m[2] ? ALL.indexOf(m[2]) : a;
    for (let i = a; i <= b && i >= 0; i++) covered.add(ALL[i]);
  }
  const missing = ALL.filter(d => !covered.has(d));
  if (missing.length > 0) return { needs: true, reason: 'missing_days', missing };
  return { needs: false };
}

/**
 * Fix opening hours for a single WP listing.
 *
 * Re-resolves hours via the deterministic waterfall (Playtomic raw -> Google
 * Places). If hours are recoverable, patches `_opening_hours` AND the 14
 * Listeo per-day fields in one PUT.
 *
 * @param {number} id — WP listing ID
 * @param {object} [opts]
 * @param {boolean} [opts.force=false] — re-fix even if hours look complete
 * @param {boolean} [opts.dryRun=false] — return the patch without writing
 * @param {object}  [opts.playtomicRaw] — provide raw Playtomic hours object
 * @returns {Promise<object>} — result with action: 'fixed' | 'unfixable' | 'skipped'
 */
async function fixOpeningHoursForListing(id, opts = {}) {
  const wp = await fetchListing(id);
  const meta = wp.meta || {};
  const title = (wp.title?.rendered || wp.title?.raw || '').replace(/&#038;/g, '&');

  const check = needsHoursFix(meta);
  if (!check.needs && !opts.force) {
    return { id, title, action: 'skipped', reason: 'hours_already_complete' };
  }

  const venue = {
    place_id: meta._place_id || null,
    opening_hours_raw: opts.playtomicRaw || null,
  };

  const resolved = await resolveOpeningHours(venue);

  if (!resolved.hours) {
    return {
      id,
      title,
      action: 'unfixable',
      reason: check.reason,
      sourcesTried: resolved.sourcesTried,
      currentHours: meta._opening_hours || '',
    };
  }

  const perDay = parseOpeningHours(resolved.hours);
  const metaPatch = {
    _opening_hours: resolved.hours,
    _opening_hours_status: 'on',
    ...perDay,
  };

  if (opts.dryRun) {
    return {
      id,
      title,
      action: 'would_patch',
      source: resolved.source,
      hours: resolved.hours,
      previousHours: meta._opening_hours || '',
      metaPatch,
    };
  }

  await wpPut(`/wp-json/wp/v2/listing/${id}`, { meta: metaPatch });

  return {
    id,
    title,
    action: 'fixed',
    source: resolved.source,
    hours: resolved.hours,
    previousHours: meta._opening_hours || '',
  };
}

/**
 * Fix opening hours for every draft listing in WP that needs it.
 * @param {object} [opts] — see fixOpeningHoursForListing; plus:
 * @param {string} [opts.country] — filter by friendly_address country substring
 * @param {number} [opts.limit] — cap number of fixes attempted
 * @returns {Promise<{ fixed: object[], unfixable: object[], skipped: object[], errors: object[] }>}
 */
async function fixOpeningHoursForAllDrafts(opts = {}) {
  const drafts = await fetchAllListings({ status: 'draft', fullMeta: true, limit: 0 });
  let candidates = drafts.filter(d => needsHoursFix(d.meta || {}).needs);

  if (opts.country) {
    const needle = String(opts.country).toLowerCase();
    candidates = candidates.filter(d => {
      const addr = (d.meta?._friendly_address || '').toLowerCase();
      const country = (d.meta?._geolocation_country || '').toLowerCase();
      return addr.includes(needle) || country === needle;
    });
  }

  if (opts.limit && opts.limit > 0) candidates = candidates.slice(0, opts.limit);

  const out = { fixed: [], unfixable: [], skipped: [], errors: [] };
  for (const d of candidates) {
    try {
      const r = await fixOpeningHoursForListing(d.id, opts);
      if (r.action === 'fixed' || r.action === 'would_patch') out.fixed.push(r);
      else if (r.action === 'unfixable') out.unfixable.push(r);
      else out.skipped.push(r);
    } catch (e) {
      out.errors.push({ id: d.id, title: d.title?.rendered, error: e.message });
    }
    await sleep(250);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

async function cli() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === 'help') {
    console.log(`
Padeli Content Auditor

Usage:
  node content-auditor.js listing <id>          Audit a single listing
  node content-auditor.js post <id|slug>        Audit a single blog post
  node content-auditor.js listings [--limit N]  Batch audit all listings
  node content-auditor.js posts [--limit N]     Batch audit all blog posts
  node content-auditor.js site [--limit N]      Full site audit
  node content-auditor.js page <url>            Rendered page check only
  node content-auditor.js check-links <wpId>    Check external links on a single item
  node content-auditor.js check-links --all     Check links on all published listings
  node content-auditor.js check-links --all-posts  Check links on all published posts

  node content-auditor.js fix-hours <id>          Fix missing/incomplete _opening_hours on one draft
  node content-auditor.js fix-hours --all-drafts  Scan all drafts; fix what's recoverable

Options:
  --skip-live     Skip rendered page checks (faster)
  --skip-links    Skip link validation (faster)
  --status S      Filter by status (publish, draft, any)
  --limit N       Max items to audit
  --country CC    Filter fix-hours --all-drafts by country (e.g. AU, Australia)
  --dry-run       For fix-hours: show what would be patched without writing
  --force         For fix-hours: re-resolve even if hours look complete
  --json          Output raw JSON instead of formatted report
    `);
    return;
  }

  const skipLive = args.includes('--skip-live');
  const skipLinks = args.includes('--skip-links');
  const jsonOut = args.includes('--json');
  const limitIdx = args.indexOf('--limit');
  const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : 0;
  const statusIdx = args.indexOf('--status');
  const status = statusIdx >= 0 ? args[statusIdx + 1] : undefined;

  try {
    const skipNotion = args.includes('--skip-notion');

    if (cmd === 'listing') {
      const id = parseInt(args[1], 10);
      if (!id) { console.error('Usage: content-auditor.js listing <id>'); process.exit(1); }
      const result = await auditSingleListing(id, { skipLive, skipLinks });
      console.log(jsonOut ? JSON.stringify(result, null, 2) : formatSingleReport(result));
      if (!skipNotion) {
        try { await afterAuditPipeline('listing', result); } catch (e) { console.log(`  [notion-sync] ${e.message}`); }
      }

    } else if (cmd === 'post') {
      const idOrSlug = args[1];
      if (!idOrSlug) { console.error('Usage: content-auditor.js post <id|slug>'); process.exit(1); }
      const result = await auditSinglePost(idOrSlug, { skipLive, skipLinks });
      console.log(jsonOut ? JSON.stringify(result, null, 2) : formatSingleReport(result));
      if (!skipNotion) {
        try { await afterAuditPipeline('post', result); } catch (e) { console.log(`  [notion-sync] ${e.message}`); }
      }

    } else if (cmd === 'listings') {
      const result = await auditAllListings({ skipLive, limit, status });
      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatBatchSummary(result.summary));
      }
      if (!skipNotion && result.results?.length) {
        try { await afterAuditPipeline('listing', result.results, { batch: true }); } catch (e) { console.log(`  [notion-sync] ${e.message}`); }
      }

    } else if (cmd === 'posts') {
      const result = await auditAllPosts({ skipLive, limit, status });
      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatBatchSummary(result.summary));
      }
      if (!skipNotion && result.results?.length) {
        try { await afterAuditPipeline('post', result.results, { batch: true }); } catch (e) { console.log(`  [notion-sync] ${e.message}`); }
      }

    } else if (cmd === 'site') {
      const result = await auditFullSite({ skipLive, listingLimit: limit, postLimit: limit });
      if (jsonOut) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatBatchSummary(result.listings.summary));
        console.log('');
        console.log(formatBatchSummary(result.posts.summary));
      }
      if (!skipNotion) {
        try {
          if (result.listings.results?.length) await afterAuditPipeline('listing', result.listings.results, { batch: true });
          if (result.posts.results?.length) await afterAuditPipeline('post', result.posts.results, { batch: true });
        } catch (e) { console.log(`  [notion-sync] ${e.message}`); }
      }

    } else if (cmd === 'check-links') {
      const target = args[1];
      if (!target) { console.error('Usage: content-auditor.js check-links <wpId> | --all | --all-posts'); process.exit(1); }

      if (target === '--all') {
        // Check links on all published listings
        console.log('[auditor] Fetching all published listings...');
        const listings = await fetchAllListings({ status: 'publish' });
        console.log(`[auditor] Checking links on ${listings.length} listings...\n`);
        let totalBroken = 0;
        let totalWarned = 0;
        for (const wp of listings) {
          const name = extractVenueName(wp);
          const result = await validateLinks(wp, 'listing');
          const broken = result.checks.filter(c => c.severity === 'error');
          const warns = result.checks.filter(c => c.severity === 'warning');
          totalBroken += broken.length;
          totalWarned += warns.length;
          if (broken.length > 0 || warns.length > 0) {
            console.log(`${name} (ID: ${wp.id}):`);
            for (const c of broken) console.log(`  BROKEN: ${c.message}`);
            for (const c of warns) console.log(`  WARN: ${c.message}`);
          }
        }
        console.log(`\n=== LINK CHECK SUMMARY ===`);
        console.log(`Listings checked: ${listings.length} | Broken: ${totalBroken} | Warnings: ${totalWarned}`);

      } else if (target === '--all-posts') {
        // Check links on all published posts
        console.log('[auditor] Fetching all published posts...');
        const posts = await fetchAllPosts({ status: 'publish' });
        console.log(`[auditor] Checking links on ${posts.length} posts...\n`);
        let totalBroken = 0;
        let totalWarned = 0;
        for (const wp of posts) {
          const name = wp.title?.raw || wp.title?.rendered || wp.slug;
          const result = await validateLinks(wp, 'post');
          const broken = result.checks.filter(c => c.severity === 'error');
          const warns = result.checks.filter(c => c.severity === 'warning');
          totalBroken += broken.length;
          totalWarned += warns.length;
          if (broken.length > 0 || warns.length > 0) {
            console.log(`${name} (ID: ${wp.id}):`);
            for (const c of broken) console.log(`  BROKEN: ${c.message}`);
            for (const c of warns) console.log(`  WARN: ${c.message}`);
          }
        }
        console.log(`\n=== LINK CHECK SUMMARY ===`);
        console.log(`Posts checked: ${posts.length} | Broken: ${totalBroken} | Warnings: ${totalWarned}`);

      } else {
        // Single item by WP ID — try listing first, then post
        const id = parseInt(target, 10);
        if (!id) { console.error('Usage: content-auditor.js check-links <wpId>'); process.exit(1); }
        let wp;
        let contentType;
        try {
          wp = await fetchListing(id);
          contentType = 'listing';
        } catch {
          try {
            wp = await fetchPost(id);
            contentType = 'post';
          } catch {
            console.error(`Could not find listing or post with ID ${id}`);
            process.exit(1);
          }
        }
        const name = contentType === 'listing' ? extractVenueName(wp) : (wp.title?.raw || wp.title?.rendered || wp.slug);
        console.log(`[auditor] Checking links on ${contentType}: ${name} (ID: ${id})...\n`);
        const result = await validateLinks(wp, contentType);
        if (jsonOut) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          const s = result.summary;
          console.log(`${name} — ${s.total} links checked: ${s.passed} ok, ${s.failed} broken, ${s.warned} warnings\n`);
          for (const c of result.checks) {
            const icon = c.severity === 'error' ? 'BROKEN' : c.severity === 'warning' ? 'WARN' : 'OK';
            console.log(`  [${icon}] ${c.message}`);
          }
        }
      }

    } else if (cmd === 'page') {
      const url = args[1];
      if (!url) { console.error('Usage: content-auditor.js page <url>'); process.exit(1); }
      const result = await auditRenderedPage(url);
      console.log(jsonOut ? JSON.stringify(result, null, 2) : result.checks.map(c => `[${c.id}] ${c.pass ? 'PASS' : 'FAIL'} — ${c.message}`).join('\n'));

    } else if (cmd === 'fix-hours') {
      const target = args[1];
      const dryRun = args.includes('--dry-run');
      const force = args.includes('--force');
      const countryIdx = args.indexOf('--country');
      const country = countryIdx >= 0 ? args[countryIdx + 1] : undefined;

      if (!target) {
        console.error('Usage: content-auditor.js fix-hours <id> | --all-drafts [--dry-run] [--country AU|AE|...] [--limit N]');
        process.exit(1);
      }

      if (target === '--all-drafts') {
        console.log(`[fix-hours] Scanning drafts for missing/incomplete opening hours${country ? ` (country: ${country})` : ''}${dryRun ? ' — DRY RUN' : ''}...`);
        const out = await fixOpeningHoursForAllDrafts({ dryRun, force, country, limit });
        if (jsonOut) { console.log(JSON.stringify(out, null, 2)); }
        else {
          console.log(`\n=== FIX-HOURS REPORT ===`);
          console.log(`${dryRun ? 'Would fix' : 'Fixed'}: ${out.fixed.length}`);
          console.log(`Unfixable: ${out.unfixable.length}`);
          console.log(`Skipped: ${out.skipped.length}`);
          console.log(`Errors: ${out.errors.length}`);
          if (out.fixed.length > 0) {
            console.log(`\n${dryRun ? 'WOULD FIX' : 'FIXED'}:`);
            for (const r of out.fixed) console.log(`  #${r.id} ${r.title} — ${r.source} — ${r.hours}`);
          }
          if (out.unfixable.length > 0) {
            console.log(`\nUNFIXABLE (manual review needed):`);
            for (const r of out.unfixable) console.log(`  #${r.id} ${r.title} — ${r.sourcesTried.join(' | ')}`);
          }
          if (out.errors.length > 0) {
            console.log(`\nERRORS:`);
            for (const r of out.errors) console.log(`  #${r.id} ${r.title} — ${r.error}`);
          }
        }
      } else {
        const id = parseInt(target, 10);
        if (!id) { console.error(`Invalid id: ${target}`); process.exit(1); }
        const r = await fixOpeningHoursForListing(id, { dryRun, force });
        if (jsonOut) { console.log(JSON.stringify(r, null, 2)); }
        else {
          console.log(`#${r.id} ${r.title}`);
          console.log(`  Action: ${r.action}${r.source ? ` (${r.source})` : ''}`);
          if (r.hours) console.log(`  Hours: ${r.hours}`);
          if (r.previousHours !== undefined) console.log(`  Previous: "${r.previousHours}"`);
          if (r.sourcesTried) console.log(`  Sources tried: ${r.sourcesTried.join(' | ')}`);
        }
      }

    } else {
      console.error(`Unknown command: ${cmd}. Run with 'help' for usage.`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`[auditor] Error: ${err.message}`);
    process.exit(1);
  }
}

// Run CLI if invoked directly
if (require.main === module) {
  cli();
}

// ─────────────────────────────────────────────────────────────────────────────
// Exports
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  // Layer 1: Fetch
  fetchListing,
  fetchPost,
  fetchAllListings,
  fetchAllPosts,

  // Layer 2: QC
  auditListing,
  auditPost,
  mapWpPostToPostData,
  extractVenueName,

  // Layer 3: Live
  auditRenderedPage,

  // Layer 3b: Yoast
  analyseYoastSeo,

  // Layer 3c: Expert SEO
  analyseExpertSeo,

  // Layer 4: GSC/GA
  fetchGSCData,
  fetchGAData,
  getAccessToken,

  // Layer 5: Ahrefs (stub)
  fetchAhrefsData,

  // Layer 6: Link Validation
  validateLinks,
  checkUrl,

  // Orchestrators
  auditSingleListing,
  auditSinglePost,
  auditAllListings,
  auditAllPosts,
  auditFullSite,

  // Reports
  buildSummary,
  formatSingleReport,
  formatBatchSummary,

  // Fix Mode
  fixOpeningHoursForListing,
  fixOpeningHoursForAllDrafts,
  needsHoursFix,
};
