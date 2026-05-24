/**
 * Padeli Listing QC Validator
 * Validates listing payloads against ALL BPA quality rules before WordPress push.
 * 58 checks across structural, content, hero hook, meta, FAQ, Yoast, schema, image, and feature domains.
 * Node.js v24+ — zero external dependencies.
 */

// ---------------------------------------------------------------------------
// CONSTANTS
// ---------------------------------------------------------------------------

const BANNED_PHRASES = [
  'located in the heart of',
  'state-of-the-art',
  'state of the art',
  'boasts',
  'boasting',
  'nestled',
  'vibrant community',
  'world-class facilities',
  'perfect for players of all levels',
  'look no further',
  'prestigious',
  'stunning facilities',
  'for all your padel needs',
  'second to none',
  'passion for padel',
  "whether you're a beginner or a seasoned pro",
  'renowned',
  'unparalleled',
  'haven for padel enthusiasts',
  'destination of choice',
];

const HERO_HOOK_EXTRA_BANNED = [
  'state-of-the-art',
  'nestled',
  'world-class',
  'haven',
  'vibrant community',
  'perfect for players of all levels',
];

const REQUIRED_H2_HEADINGS = [
  'the courts',
  'booking and access',
  'programme and social',
  'best for',
];

// Keep legacy alias for backward compatibility
const REQUIRED_H3_HEADINGS = REQUIRED_H2_HEADINGS;

const VALID_FEATURE_IDS = new Set([
  242, 243, 244, 245, 246, 247,
  352, 353, 355, 356, 357, 358, 359, 360, 361, 362,
  363, 364, 366, 367, 368, 369, 370, 371, 372, 373, 374, 375,
]);

const PERSONAL_VISIT_PHRASES = [
  'we have played',
  'we visited',
  'we tested',
  'we tried',
];

const MECHANICAL_TRANSITION_OPENERS = [
  'moreover',
  'furthermore',
  'additionally',
  'in addition',
  'consequently',
  'nevertheless',
];

// Emoji regex covering common unicode emoji ranges
const EMOJI_REGEX = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{200D}\u{23CF}\u{23E9}-\u{23F3}\u{23F8}-\u{23FA}\u{25AA}-\u{25AB}\u{25B6}\u{25C0}\u{25FB}-\u{25FE}\u{2934}-\u{2935}\u{2B05}-\u{2B07}\u{2B1B}-\u{2B1C}\u{2B50}\u{2B55}\u{3030}\u{303D}\u{3297}\u{3299}]/u;

// ---------------------------------------------------------------------------
// HELPER UTILITIES
// ---------------------------------------------------------------------------

function countWords(text) {
  const cleaned = text.replace(/<[^>]*>/g, '').trim();
  if (!cleaned) return 0;
  return cleaned.split(/\s+/).length;
}

function stripHtml(html) {
  return html.replace(/<[^>]*>/g, '');
}

/**
 * Remove wp:html blocks from body (used for word count, paragraph checks, etc.)
 */
function stripWpHtmlBlocks(html) {
  return html.replace(/<!-- wp:html -->[\s\S]*?<!-- \/wp:html -->/g, '');
}

/**
 * Extract all <p> blocks from HTML (excluding wp:html blocks).
 * Returns array of { content, wordCount, index }.
 */
function extractParagraphs(html) {
  const cleaned = stripWpHtmlBlocks(html);
  const pRegex = /<p[^>]*>([\s\S]*?)<\/p>/gi;
  const paragraphs = [];
  let match;
  let idx = 0;
  while ((match = pRegex.exec(cleaned)) !== null) {
    const content = match[1];
    const words = countWords(content);
    if (words > 0) {
      paragraphs.push({ content, wordCount: words, index: idx });
      idx++;
    }
  }
  return paragraphs;
}

// ---------------------------------------------------------------------------
// INDIVIDUAL CHECKER FUNCTIONS
// ---------------------------------------------------------------------------

/**
 * Check for banned phrases in text. Returns array of found phrases.
 */
function checkBannedPhrases(text) {
  const lower = text.toLowerCase();
  const found = [];
  for (const phrase of BANNED_PHRASES) {
    if (lower.includes(phrase.toLowerCase())) {
      found.push(phrase);
    }
  }
  return found;
}

/**
 * Check for em dashes (U+2014) or en dashes (U+2013). Returns array of positions.
 */
function checkDashes(text) {
  const issues = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\u2014') {
      issues.push({ char: 'em dash', position: i });
    } else if (text[i] === '\u2013') {
      issues.push({ char: 'en dash', position: i });
    }
  }
  return issues;
}

/**
 * Check paragraph lengths in HTML. Returns object with failures (>60) and warnings (outside 30-50).
 * wp:html schema blocks are exempt.
 */
function checkParagraphLength(html) {
  const paragraphs = extractParagraphs(html);
  const failures = [];
  const rangeWarnings = [];

  for (const p of paragraphs) {
    if (p.wordCount > 60) {
      failures.push({ text: p.content.substring(0, 80) + '...', wordCount: p.wordCount, index: p.index });
    } else if (p.wordCount < 30 || p.wordCount > 50) {
      rangeWarnings.push({ text: p.content.substring(0, 80) + (p.content.length > 80 ? '...' : ''), wordCount: p.wordCount, index: p.index });
    }
  }
  return { failures, rangeWarnings };
}

/**
 * Validate hero hook. Returns { valid: boolean, errors: [], warnings: [] }
 */
function checkHeroHook(hook) {
  const errors = [];
  const warnings = [];

  if (!hook || !hook.trim()) {
    errors.push('Hero hook is missing or empty');
    return { valid: false, errors, warnings };
  }

  const trimmed = hook.trim();
  const words = countWords(trimmed);

  // Check 24: MAX 30 words (Ryan's override)
  if (words > 30) {
    errors.push(`Hero hook is ${words} words (max 30)`);
  }

  // Check 25: Max 2 sentences (matches live gold standard — BPA uses 2 sentences in 30 words)
  const sentences = trimmed.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(s => s.trim().length > 0);
  if (sentences.length > 2) {
    errors.push(`Hero hook has ${sentences.length} sentences (max 2)`);
  }

  // Check 26: Banned phrases in hero hook
  const banned = checkBannedPhrases(trimmed);
  if (banned.length > 0) {
    errors.push(`Hero hook contains banned phrases: ${banned.join(', ')}`);
  }

  // Check 27: Extra hero-specific banned terms
  const lower = trimmed.toLowerCase();
  for (const term of HERO_HOOK_EXTRA_BANNED) {
    if (lower.includes(term.toLowerCase()) && !banned.includes(term)) {
      errors.push(`Hero hook contains banned term: "${term}"`);
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Check body structure for required section headings in order.
 * Listeo theme renders venue name as H1 — content sections use H3 (confirmed from live BPA listing).
 * Accepts H3 as the correct heading level. H2 sections trigger a warning (wrong hierarchy).
 * Also checks for "About {venue}" and "Coaching at {venue}" sections (conditional).
 * Returns { valid: boolean, errors: [], warnings: [] }
 */
function checkBodyStructure(html, venueName, options = {}) {
  const errors = [];
  const warnings = [];

  // Extract all H3 headings (correct level for Listeo content sections)
  const h3Regex = /<h3[^>]*>([\s\S]*?)<\/h3>/gi;
  const foundH3s = [];
  let match;
  while ((match = h3Regex.exec(html)) !== null) {
    foundH3s.push(stripHtml(match[1]).trim().toLowerCase());
  }

  // Extract H2 headings — these should NOT be used (theme uses H1 for title, H3 for sections)
  const h2Regex = /<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  const foundH2s = [];
  while ((match = h2Regex.exec(html)) !== null) {
    foundH2s.push(stripHtml(match[1]).trim().toLowerCase());
  }

  // Warn if sections use H2 instead of H3 (wrong hierarchy for Listeo theme)
  for (const required of REQUIRED_H2_HEADINGS) {
    if (!foundH3s.includes(required) && foundH2s.includes(required)) {
      warnings.push(`Section "${required}" uses H2 but should be H3 (Listeo renders venue name as H1)`);
    }
  }

  // Check required section headings in order (look in H3s first, fall back to H2s)
  // Fuzzy match: heading must CONTAIN the required text (allows SEO-enhanced headings
  // like "The padel courts" matching "the courts", or "Booking padel at X" matching "booking and access")
  const allSections = foundH3s.length > 0 ? foundH3s : foundH2s;
  let lastIndex = -1;
  for (const required of REQUIRED_H2_HEADINGS) {
    // Extract core words from required heading for flexible matching
    const coreWords = required.split(/\s+/).filter(w => w.length > 2);
    const idx = allSections.findIndex((h, i) => {
      if (i <= lastIndex) return false; // must be after previous match
      // Exact match
      if (h === required) return true;
      // Contains all core words (allows "the padel courts" to match "the courts")
      return coreWords.every(word => h.includes(word));
    });
    if (idx === -1) {
      errors.push(`Missing required section heading: "${required}"`);
    } else {
      lastIndex = idx;
    }
  }

  // Check for duplicate headings (same heading text appears more than once)
  const headingCounts = new Map();
  for (const h of allSections) {
    headingCounts.set(h, (headingCounts.get(h) || 0) + 1);
  }
  for (const [heading, count] of headingCounts) {
    if (count > 1) {
      errors.push(`Duplicate section heading "${heading}" appears ${count} times`);
    }
  }

  // NOTE: No "About {venue}" heading check — Listeo theme auto-renders it above the content area.
  // Adding an About H3 creates a duplicate. The first body section has NO heading by design.

  // NOTE: No "Coaching at {venue}" section check — coaching content goes in coaching_about
  // and coaching_price ACF fields, which Listeo renders as a dedicated coaching tab.
  // A brief mention in "Programme and social" is sufficient.

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Clean text: strip banned phrases, replace em/en dashes with space-hyphen-space.
 */
function cleanText(text) {
  let result = text;

  // Replace em/en dashes with " - "
  result = result.replace(/[\u2014\u2013]/g, ' - ');

  // Strip banned phrases (case-insensitive replacement)
  for (const phrase of BANNED_PHRASES) {
    const regex = new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    result = result.replace(regex, '');
  }

  // Clean up double spaces left behind
  result = result.replace(/ {2,}/g, ' ').trim();

  return result;
}

// ---------------------------------------------------------------------------
// MAIN VALIDATOR — validateListing (research JSON payload)
// ---------------------------------------------------------------------------

/**
 * Validate a research JSON listing payload against all BPA quality rules.
 *
 * @param {object} listing - The research JSON payload (inner object, not keyed by ID)
 * @param {string} venueName - Name of the venue
 * @param {object} [options] - Optional: { city, countryCode, listingId }
 * @returns {{ pass: boolean, errors: string[], warnings: string[], cleaned: object }}
 */
function validateListing(listing, venueName, options = {}) {
  const errors = [];
  const warnings = [];
  const cleaned = JSON.parse(JSON.stringify(listing));

  const body = listing.body_html || listing.body || listing.content || '';
  const heroHook = listing.hero_hook || listing.heroHook || '';
  const faqs = listing.faqs || [];
  const features = listing.features_to_add || listing.features || [];
  const meta = listing.meta_updates || listing.meta || {};
  const yoast = listing.yoast || {};
  const coachingState = listing.coaching_state || meta.coaching_state || '';
  const city = options.city || '';
  const venueNameLower = (venueName || '').toLowerCase();

  // Combined text for full-body scans
  const allText = `${heroHook} ${body}`;
  const bodyNoSchema = stripWpHtmlBlocks(body);

  // =========================================================================
  // STRUCTURAL CHECKS (1-5) — only run if field present in research JSON
  // =========================================================================

  // Check 1: status=draft (if present)
  if (listing.status !== undefined && listing.status !== 'draft') {
    errors.push(`[S1] status must be "draft" (got "${listing.status}")`);
  }

  // Check 2: _verified=0 (if present)
  if (listing._verified !== undefined && String(listing._verified) !== '0') {
    errors.push(`[S2] _verified must be "0" (got "${listing._verified}")`);
  }

  // Check 3: listing_category contains 189 AND clubs_category contains 135 (if present)
  if (listing.listing_category !== undefined) {
    if (!Array.isArray(listing.listing_category) || !listing.listing_category.includes(189)) {
      errors.push('[S3] listing_category must include 189 (Padel Club)');
    }
  }
  if (listing.clubs_category !== undefined) {
    if (!Array.isArray(listing.clubs_category) || !listing.clubs_category.includes(135)) {
      errors.push('[S3] clubs_category must include 135 (Padel Club)');
    }
  }

  // Check 4: region array has 3 entries, none zero/null (if present)
  if (listing.region !== undefined) {
    if (!Array.isArray(listing.region) || listing.region.length !== 3) {
      errors.push(`[S4] region must have exactly 3 entries [country, county, city] (got ${Array.isArray(listing.region) ? listing.region.length : 'non-array'})`);
    } else {
      for (let i = 0; i < listing.region.length; i++) {
        if (!listing.region[i]) {
          const labels = ['country', 'county', 'city'];
          errors.push(`[S4] region ${labels[i]} (index ${i}) is zero or null`);
        }
      }
    }
  }

  // Check 5: listing_feature populated, warn if <8 (if present)
  if (listing.listing_feature !== undefined) {
    if (!Array.isArray(listing.listing_feature) || listing.listing_feature.length === 0) {
      errors.push('[S5] listing_feature must be populated');
    } else if (listing.listing_feature.length < 8) {
      warnings.push(`[S5] listing_feature has ${listing.listing_feature.length} features (recommend 8+)`);
    }
  }

  // =========================================================================
  // CONTENT CHECKS (6-22)
  // =========================================================================

  // Check 6: Body opens with bold venue name
  if (body) {
    const firstPMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (firstPMatch) {
      const firstPContent = firstPMatch[1];
      if (venueName) {
        const strongRegex = new RegExp(`<strong>${venueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/strong>`, 'i');
        if (!strongRegex.test(firstPContent)) {
          errors.push(`[C6] Body must open with bold venue name: first <p> should contain <strong>${venueName}</strong>`);
        }
      }
    } else {
      errors.push('[C6] Body has no <p> tag to check for bold venue name');
    }
  }

  // Check 7: Required H2 sections in order + About/Coaching/Facilities
  if (body) {
    const hasCoaching = coachingState === 'in_house' || coachingState === 'freelance';
    const structureResult = checkBodyStructure(body, venueName, { hasCoaching });
    if (!structureResult.valid) {
      for (const err of structureResult.errors) {
        errors.push(`[C7] ${err}`);
      }
    }
    if (structureResult.warnings) {
      for (const w of structureResult.warnings) {
        warnings.push(`[C7] ${w}`);
      }
    }
  }

  // Check 7b: Per-court pricing alongside per-person pricing
  if (body) {
    const bodyLowerForPrice = body.toLowerCase();
    const hasPerPerson = bodyLowerForPrice.includes('per person');
    const hasPerCourt = bodyLowerForPrice.includes('per court');
    if (hasPerPerson && !hasPerCourt) {
      warnings.push('[C7b] Body shows per-person pricing but no per-court pricing - include both where venue charges per court');
    }
  }

  // Check 8: Total body word count 600-900 (HARD FAIL)
  if (body) {
    const bodyWordCount = countWords(bodyNoSchema);
    if (bodyWordCount < 600) {
      errors.push(`[C8] Body word count is ${bodyWordCount} - MINIMUM 600 required (target 600-900). Research agent must produce more content.`);
    } else if (bodyWordCount > 900) {
      warnings.push(`[C8] Body word count is ${bodyWordCount} (target 600-900, over maximum 900)`);
    }
  }

  // Check 9: No DA "Quick answer:" block or "padeli-direct-answer" class
  if (body) {
    if (body.includes('Quick answer:') || body.includes('padeli-direct-answer')) {
      errors.push('[C9] Body contains a Direct Answer block (Quick answer: or padeli-direct-answer) - must be removed');
    }
  }

  // Check 10: No banned phrases (full list)
  if (body) {
    const bannedFound = checkBannedPhrases(body);
    if (bannedFound.length > 0) {
      errors.push(`[C10] Banned phrases found in body: ${bannedFound.join(', ')}`);
    }
  }

  // Check 11: No em dashes or en dashes anywhere
  {
    const dashIssues = checkDashes(allText);
    if (dashIssues.length > 0) {
      errors.push(`[C11] Found ${dashIssues.length} em/en dash(es) - must use " - " (space hyphen space)`);
    }
  }

  // Check 12: All paragraphs under 60 words (wp:html blocks exempt)
  if (body) {
    const paraCheck = checkParagraphLength(body);
    if (paraCheck.failures.length > 0) {
      for (const p of paraCheck.failures) {
        errors.push(`[C12] Paragraph ${p.index + 1} exceeds 60 words (${p.wordCount} words): "${p.text}"`);
      }
    }
  }

  // Check 13: All URLs in body wrapped in <a href> - no raw https:// strings
  if (body) {
    // Find https:// URLs not inside an href="..." attribute
    const bodyStripped = bodyNoSchema;
    // Remove all <a ...>...</a> tags and href="..." attributes to find naked URLs
    const withoutAnchorContent = bodyStripped
      .replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/href="[^"]*"/gi, '')
      .replace(/src="[^"]*"/gi, '');
    const rawUrlMatch = withoutAnchorContent.match(/https?:\/\/[^\s<>"]+/gi);
    if (rawUrlMatch && rawUrlMatch.length > 0) {
      errors.push(`[C13] Raw URL(s) not wrapped in <a href>: ${rawUrlMatch.slice(0, 3).join(', ')}${rawUrlMatch.length > 3 ? ' (and more)' : ''}`);
    }
  }

  // Check 14: Sister venues linked only if same brand prefix
  if (body) {
    const otherPadelMatch = body.match(/Other padel options/i);
    if (otherPadelMatch) {
      warnings.push('[C14] Body contains "Other padel options" pattern - verify sister venues are same brand prefix only');
    }
  }

  // Check 15: No literal "[VERIFY]" text anywhere in body or FAQs
  {
    let hasVerify = false;
    if (body && body.includes('[VERIFY]')) hasVerify = true;
    if (!hasVerify && faqs.length > 0) {
      for (const faq of faqs) {
        const q = faq.question || faq.q || '';
        const a = faq.answer || faq.a || '';
        if (q.includes('[VERIFY]') || a.includes('[VERIFY]')) {
          hasVerify = true;
          break;
        }
      }
    }
    if (hasVerify) {
      errors.push('[C15] Literal "[VERIFY]" found in body or FAQs - must be resolved before publishing');
    }
  }

  // Check 16: No emojis in body
  if (body) {
    const emojiMatch = body.match(EMOJI_REGEX);
    if (emojiMatch) {
      errors.push(`[C16] Emojis found in body: ${emojiMatch.slice(0, 5).join(' ')}`);
    }
  }

  // Check 17: No personal visit claims
  if (body) {
    const bodyLower = body.toLowerCase();
    for (const phrase of PERSONAL_VISIT_PHRASES) {
      if (bodyLower.includes(phrase)) {
        errors.push(`[C17] Personal visit claim found: "${phrase}" - remove unless verified`);
      }
    }
  }

  // Check 18: No mechanical transition word openers (WARNING)
  if (body) {
    const paragraphs = extractParagraphs(body);
    for (const p of paragraphs) {
      const text = stripHtml(p.content).trim();
      const firstWord = text.split(/[\s,]/)[0].toLowerCase();
      const firstTwoWords = text.split(/[\s,]/).slice(0, 2).join(' ').toLowerCase();
      for (const opener of MECHANICAL_TRANSITION_OPENERS) {
        if (opener.includes(' ')) {
          // Multi-word opener like "in addition"
          if (firstTwoWords === opener || firstTwoWords.startsWith(opener)) {
            warnings.push(`[C18] Paragraph ${p.index + 1} opens with mechanical transition "${opener}"`);
          }
        } else {
          if (firstWord === opener) {
            warnings.push(`[C18] Paragraph ${p.index + 1} opens with mechanical transition "${opener}"`);
          }
        }
      }
    }
  }

  // Check 19: Intro paragraph 24-46 words (WARNING)
  if (body) {
    const firstPMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (firstPMatch) {
      const introWords = countWords(firstPMatch[1]);
      if (introWords > 0 && (introWords < 24 || introWords > 46)) {
        warnings.push(`[C19] Intro paragraph is ${introWords} words (target 24-46)`);
      }
    }
  }

  // Check 20: Target paragraph length 30-50 words (warn outside range, fail only >60 handled in C12)
  if (body) {
    const paraCheck = checkParagraphLength(body);
    if (paraCheck.rangeWarnings.length > 0) {
      for (const p of paraCheck.rangeWarnings) {
        warnings.push(`[C20] Paragraph ${p.index + 1} is ${p.wordCount} words (target 30-50): "${p.text}"`);
      }
    }
  }

  // Check 21: No hyperlinks in FAQ question text (links go in answers only)
  if (faqs.length > 0) {
    for (let i = 0; i < faqs.length; i++) {
      const question = faqs[i].question || faqs[i].q || '';
      if (/<a\s/i.test(question)) {
        errors.push(`[C21] FAQ ${i + 1} question contains a hyperlink - links go in answers only`);
      }
    }
  }

  // Check 22: FAQ questions must name the venue (venue name or city)
  if (faqs.length > 0 && (venueName || city)) {
    for (let i = 0; i < faqs.length; i++) {
      const question = (faqs[i].question || faqs[i].q || '').toLowerCase();
      const mentionsVenue = venueName && question.includes(venueNameLower);
      const mentionsCity = city && question.includes(city.toLowerCase());
      if (!mentionsVenue && !mentionsCity) {
        errors.push(`[C22] FAQ ${i + 1} question is generic - must mention "${venueName || ''}"${city ? ` or "${city}"` : ''}`);
      }
    }
  }

  // =========================================================================
  // HERO HOOK CHECKS (23-27)
  // =========================================================================

  // Check 23: Hero hook exists and is non-empty
  // Check 24: Hero hook MAX 30 words
  // Check 25: Single sentence
  // Check 26: No banned phrases
  // Check 27: No extra hero-banned terms
  {
    const hookResult = checkHeroHook(heroHook);
    if (!hookResult.valid) {
      for (const err of hookResult.errors) {
        errors.push(`[H${err.includes('missing') ? '23' : err.includes('words') ? '24' : err.includes('one sentence') ? '25' : err.includes('banned phrase') ? '26' : '27'}] Hero hook: ${err}`);
      }
    }
  }

  // =========================================================================
  // META FIELD CHECKS (28-41)
  // =========================================================================

  // Check 28: _address populated (HARD FAIL)
  if (meta._address !== undefined) {
    if (!meta._address || !String(meta._address).trim()) {
      errors.push('[M28] _address is empty - must be populated');
    }
  }

  // Check 29: _place_id populated (HARD FAIL)
  if (meta._place_id !== undefined) {
    if (!meta._place_id || !String(meta._place_id).trim()) {
      errors.push('[M29] _place_id is empty - mandatory for Google Reviews widget');
    }
  }

  // Check G70 (2026-05-19): if _place_id is set, lat/lng must also be populated
  // — Listeo's map widget renders from these fields, not from _place_id. Without
  // them, the listing has no map.
  if (meta._place_id && String(meta._place_id).trim()) {
    const lat = meta._geolocation_lat;
    const lng = meta._geolocation_long;
    if (!lat || !String(lat).trim() || !lng || !String(lng).trim()) {
      errors.push('[G70] _place_id is set but _geolocation_lat/_geolocation_long are empty - Listeo map widget will not render');
    }
  }

  // Check G71 (2026-05-19): _booking_link must be populated — drives the
  // primary "Book a Court" CTA in Listeo. Empty = broken Book button.
  if (!meta._booking_link || !String(meta._booking_link).trim()) {
    errors.push('[G71] _booking_link is empty - "Book a Court" button will not work');
  }

  // Check 30: _phone populated with +CC format (WARNING)
  if (meta._phone !== undefined) {
    if (!meta._phone || !String(meta._phone).trim()) {
      warnings.push('[M30] _phone is empty');
    } else if (!/^\+\d/.test(String(meta._phone).trim())) {
      warnings.push(`[M30] _phone should start with + followed by country code (got "${meta._phone}")`);
    }
  }

  // Check 31: _website populated with https:// (WARNING)
  if (meta._website !== undefined) {
    if (!meta._website || !String(meta._website).trim()) {
      warnings.push('[M31] _website is empty');
    } else if (!String(meta._website).trim().startsWith('https://')) {
      warnings.push(`[M31] _website should start with https:// (got "${meta._website}")`);
    }
  }

  // Check 32: _whatsapp digits only (HARD FAIL)
  if (meta._whatsapp !== undefined && meta._whatsapp !== '' && meta._whatsapp !== null) {
    if (!/^\d+$/.test(String(meta._whatsapp))) {
      errors.push(`[M32] _whatsapp must be digits only - no +, spaces, or dashes (got "${meta._whatsapp}")`);
    }
  }

  // Check 33: _surface_type under 25 chars (WARNING)
  if (meta._surface_type && String(meta._surface_type).length > 25) {
    warnings.push(`[M33] _surface_type exceeds 25 chars (${String(meta._surface_type).length}): "${meta._surface_type}"`);
  }

  // Check 34: _lighting under 25 chars (WARNING)
  if (meta._lighting && String(meta._lighting).length > 25) {
    warnings.push(`[M34] _lighting exceeds 25 chars (${String(meta._lighting).length}): "${meta._lighting}"`);
  }

  // Check 35: _opening_hours present, complete (all 7 days covered), and well-formed (WARNING)
  // Expands day ranges ("Mon-Fri") into individual days. Empty/missing previously
  // passed silently — now always reports.
  {
    const hoursStr = typeof meta._opening_hours === 'string' ? meta._opening_hours.trim() : '';
    if (!hoursStr) {
      warnings.push('[M35] _opening_hours is missing or empty — opening times table will not render');
    } else {
      const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const covered = new Set();
      for (const entry of hoursStr.split(',').map(s => s.trim())) {
        const m = entry.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\b/);
        if (!m) continue;
        const start = ALL_DAYS.indexOf(m[1]);
        const end = m[2] ? ALL_DAYS.indexOf(m[2]) : start;
        if (start < 0 || end < start) { covered.add(m[1]); continue; }
        for (let i = start; i <= end; i++) covered.add(ALL_DAYS[i]);
      }
      const missingDays = ALL_DAYS.filter(d => !covered.has(d));
      if (missingDays.length > 0) {
        warnings.push(`[M35] _opening_hours missing day(s): ${missingDays.join(', ')} — got "${hoursStr}"`);
      } else {
        const hoursPattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(-(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s+\d{2}:\d{2}-\d{2}:\d{2}/;
        if (!hoursPattern.test(hoursStr)) {
          warnings.push(`[M35] _opening_hours may not follow "Mon-Fri HH:MM-HH:MM" pattern (got "${hoursStr}")`);
        }
      }
    }
  }

  // Check 36: _price_min and _price_max numeric only (WARNING)
  if (meta._price_min !== undefined && meta._price_min !== '' && meta._price_min !== null) {
    if (!/^\d+(\.\d+)?$/.test(String(meta._price_min))) {
      warnings.push(`[M36] _price_min must be numeric only (got "${meta._price_min}")`);
    }
  }
  if (meta._price_max !== undefined && meta._price_max !== '' && meta._price_max !== null) {
    if (!/^\d+(\.\d+)?$/.test(String(meta._price_max))) {
      warnings.push(`[M36] _price_max must be numeric only (got "${meta._price_max}")`);
    }
  }

  // Check 37: _clubs_tab_opening_year is exactly 4 digits (WARNING)
  if (meta._clubs_tab_opening_year !== undefined && meta._clubs_tab_opening_year !== '' && meta._clubs_tab_opening_year !== null) {
    if (!/^\d{4}$/.test(String(meta._clubs_tab_opening_year))) {
      warnings.push(`[M37] _clubs_tab_opening_year must be exactly 4 digits (got "${meta._clubs_tab_opening_year}")`);
    }
  }

  // Check 38: _instagram format (WARNING)
  if (meta._instagram && String(meta._instagram).trim()) {
    if (!/^https:\/\/www\.instagram\.com\//.test(String(meta._instagram).trim())) {
      warnings.push(`[M38] _instagram should be https://www.instagram.com/... format (got "${meta._instagram}")`);
    }
  }

  // Check 39: _facebook format starts with https:// (WARNING)
  if (meta._facebook && String(meta._facebook).trim()) {
    if (!String(meta._facebook).trim().startsWith('https://')) {
      warnings.push(`[M39] _facebook should start with https:// (got "${meta._facebook}")`);
    }
  }

  // Check 40: _faq_status = 'on' (WARNING)
  if (meta._faq_status !== undefined) {
    if (meta._faq_status !== 'on') {
      warnings.push(`[M40] _faq_status should be "on" (got "${meta._faq_status}")`);
    }
  }

  // Check 41 (2026-05-19 calibrated): flag accidental duplicates between
  // semantically-distinct fields, NOT the expected overlaps. Listeo's "Book"
  // modal reads `_booking_link` as the action URL; `_playtomic_url` and
  // `_direct_booking_url` are source markers that should mirror it when that
  // is the booking channel. So:
  //   - `_booking_link === _playtomic_url`  : EXPECTED when Playtomic is the booking method
  //   - `_booking_link === _direct_booking_url` : EXPECTED when direct site is the booking method
  //   - `_booking_link === _website` : SUSPICIOUS — website is informational, booking is action
  //   - `_playtomic_url === _direct_booking_url` : CONTRADICTION — venue is either Playtomic OR direct
  //   - `_website === _playtomic_url` or `_website === _direct_booking_url` : SUSPICIOUS
  {
    const get = f => meta[f] && String(meta[f]).trim();
    const link = get('_booking_link');
    const playtomic = get('_playtomic_url');
    const direct = get('_direct_booking_url');
    const website = get('_website');
    const dupes = [];
    if (link && website && link === website) dupes.push('_booking_link === _website');
    if (playtomic && direct && playtomic === direct) dupes.push('_playtomic_url === _direct_booking_url');
    if (website && playtomic && website === playtomic) dupes.push('_website === _playtomic_url');
    if (website && direct && website === direct) dupes.push('_website === _direct_booking_url');
    if (dupes.length > 0) {
      warnings.push(`[M41] Booking URL fields collide on semantically-distinct fields: ${dupes.join('; ')} — should be distinct CTAs`);
    }
  }

  // =========================================================================
  // FAQ CHECKS (42-46)
  // =========================================================================

  // Check 42: Exactly 6 FAQs
  if (faqs.length !== 6) {
    errors.push(`[F42] Must have exactly 6 FAQs (found ${faqs.length})`);
  }

  // Check 43: Each FAQ question names the venue (venue name or city)
  // (Already handled by C22 above, but this is the FAQ-section hard fail version)
  if (faqs.length > 0 && venueName) {
    for (let i = 0; i < faqs.length; i++) {
      const question = (faqs[i].question || faqs[i].q || '').toLowerCase();
      const mentionsVenue = question.includes(venueNameLower);
      const mentionsCity = city && question.includes(city.toLowerCase());
      if (!mentionsVenue && !mentionsCity) {
        // Only add if not already flagged by C22 (avoid duplicate)
        const alreadyFlagged = errors.some(e => e.startsWith(`[C22] FAQ ${i + 1}`));
        if (!alreadyFlagged) {
          errors.push(`[F43] FAQ ${i + 1} question does not name the venue "${venueName}"`);
        }
      }
    }
  }

  // Check 44: No empty answers
  if (faqs.length > 0) {
    for (let i = 0; i < faqs.length; i++) {
      const answer = (faqs[i].answer || faqs[i].a || '').trim();
      if (!answer) {
        errors.push(`[F44] FAQ ${i + 1} answer is empty`);
      }
    }
  }

  // Check 45: No [VERIFY] in FAQ answers (already partially covered by C15, explicit per-FAQ here)
  if (faqs.length > 0) {
    for (let i = 0; i < faqs.length; i++) {
      const answer = faqs[i].answer || faqs[i].a || '';
      if (answer.includes('[VERIFY]')) {
        const alreadyFlagged = errors.some(e => e.startsWith('[C15]'));
        if (!alreadyFlagged) {
          errors.push(`[F45] FAQ ${i + 1} answer contains "[VERIFY]"`);
        }
      }
    }
  }

  // Check 46: No <a> tags in FAQ question text
  if (faqs.length > 0) {
    for (let i = 0; i < faqs.length; i++) {
      const question = faqs[i].question || faqs[i].q || '';
      if (/<a\s/i.test(question)) {
        const alreadyFlagged = errors.some(e => e.startsWith(`[C21] FAQ ${i + 1}`));
        if (!alreadyFlagged) {
          errors.push(`[F46] FAQ ${i + 1} question contains <a> tag - links go in answers only`);
        }
      }
    }
  }

  // =========================================================================
  // YOAST CHECKS (47-51) — WARNING
  // =========================================================================

  // Check 47: _yoast_wpseo_title contains "Padel" and venue name
  if (yoast.title && venueName) {
    const titleLower = yoast.title.toLowerCase();
    if (!titleLower.includes('padel')) {
      warnings.push(`[Y47] Yoast title should contain "Padel" for keyphrase alignment (got: "${yoast.title}")`);
    }
    const venueWords = venueName.toLowerCase().split(/\s+/);
    const hasVenueName = venueWords.some(w => w.length > 3 && titleLower.includes(w));
    if (!hasVenueName) {
      warnings.push(`[Y47] Yoast title should contain the venue name (got: "${yoast.title}")`);
    }
  }

  // Check 48: _yoast_wpseo_title is 40-65 chars
  if (yoast.title) {
    const titleLen = yoast.title.length;
    if (titleLen < 40 || titleLen > 65) {
      warnings.push(`[Y48] Yoast title is ${titleLen} chars (target 40-65)`);
    }
  }

  // Check 49: _yoast_wpseo_metadesc is 120-156 chars (Yoast truncates at 156)
  if (yoast.metadesc) {
    const descLen = yoast.metadesc.length;
    if (descLen < 120 || descLen > 156) {
      warnings.push(`[Y49] Yoast metadesc is ${descLen} chars (target 120-156, hard max 156)`);
    }
  }

  // Check 50: _yoast_wpseo_metadesc contains focus keyphrase
  if (yoast.metadesc && yoast.focuskw) {
    if (!yoast.metadesc.toLowerCase().includes(yoast.focuskw.toLowerCase())) {
      warnings.push(`[Y50] Yoast metadesc doesn't contain focus keyphrase "${yoast.focuskw}"`);
    }
  }

  // Check 51: _yoast_wpseo_focuskw is venue-specific and lowercase
  if (yoast.focuskw) {
    const focusLower = yoast.focuskw.toLowerCase();
    if (!focusLower.includes('padel') || yoast.focuskw !== focusLower) {
      warnings.push(`[Y51] focuskw should include "padel" and be lowercase (got "${yoast.focuskw}")`);
    }
  }

  // =========================================================================
  // SCHEMA CHECKS (52-55) — HARD FAIL
  // =========================================================================

  // Check 52 & 53: SKIPPED in pre-build validation.
  // buildPayload() injects FAQ and Course JSON-LD AFTER this validator runs.
  // These checks are enforced in validatePayload() which runs post-build.

  // Check 54: No duplicate LocalBusiness schema in body (Listeo theme handles this)
  if (body) {
    const localBizMatches = body.match(/"@type"\s*:\s*"LocalBusiness"/gi);
    if (localBizMatches && localBizMatches.length > 0) {
      errors.push('[SC54] LocalBusiness schema found in body - Listeo theme handles this, remove to avoid duplicates');
    }
  }

  // Check 55: All JSON-LD is inside <script> tags, not bare JSON in wp:html blocks
  if (body) {
    // Find wp:html blocks and check for bare JSON-LD (has @context or @type but not inside <script>)
    const wpHtmlRegex = /<!-- wp:html -->([\s\S]*?)<!-- \/wp:html -->/gi;
    let wpMatch;
    while ((wpMatch = wpHtmlRegex.exec(body)) !== null) {
      const blockContent = wpMatch[1].trim();
      // Check if it has JSON-LD indicators but is NOT wrapped in <script>
      if (/"@context"\s*:/i.test(blockContent) || /"@type"\s*:/i.test(blockContent)) {
        if (!/<script\s+type="application\/ld\+json">/i.test(blockContent)) {
          errors.push('[SC55] Bare JSON-LD found in wp:html block without <script type="application/ld+json"> wrapper');
          break;
        }
      }
    }
  }

  // =========================================================================
  // IMAGE CHECKS (56) — WARNING
  // =========================================================================

  // Check 56: featured_media is set (if present in payload)
  if (listing.featured_media !== undefined) {
    if (!listing.featured_media || listing.featured_media === 0) {
      warnings.push('[I56] featured_media is not set - listing card will show map placeholder');
    }
  }

  // =========================================================================
  // FEATURE CHECKS (57-58)
  // =========================================================================

  // Check 57: Feature IDs validated against canonical set
  if (features.length > 0) {
    const invalidFeatures = features.filter(id => !VALID_FEATURE_IDS.has(Number(id)));
    if (invalidFeatures.length > 0) {
      warnings.push(`[FT57] Invalid feature IDs: ${invalidFeatures.join(', ')}`);
    }
  }

  // Check 58: Warn if features array has fewer than 8 items
  if (features.length > 0 && features.length < 8) {
    warnings.push(`[FT58] Features array has ${features.length} items (recommend 8+)`);
  }

  // Check 59: Indoor (355) or Outdoor (356) must be present
  if (features.length > 0) {
    const hasIndoor = features.includes(355) || features.includes('355');
    const hasOutdoor = features.includes(356) || features.includes('356');
    if (!hasIndoor && !hasOutdoor) {
      errors.push('[FT59] Features must include Indoor Courts (355) or Outdoor Courts (356) or both');
    }
  }

  // Check 60: Gallery minimum — warn if fewer than 6 images
  if (listing.meta?._gallery) {
    const galleryObj = listing.meta._gallery;
    const galleryCount = typeof galleryObj === 'object' ? Object.keys(galleryObj).length : 0;
    if (galleryCount > 0 && galleryCount < 6) {
      warnings.push(`[I60] Gallery has ${galleryCount} images (recommend 6+ for premium look)`);
    }
  }

  // =========================================================================
  // SEO CHECKS (61-67) — Yoast alignment
  // =========================================================================

  // Derive focus keyphrase for SEO checks
  const focuskw = (yoast.focuskw || '').toLowerCase();

  // Check 61: Outbound links — body must contain at least 1 <a href> pointing outside padeli.com
  if (body) {
    const anchorMatches = body.match(/<a\s+[^>]*href="(https?:\/\/[^"]+)"[^>]*>/gi) || [];
    const outboundLinks = anchorMatches.filter(a => {
      const hrefMatch = a.match(/href="(https?:\/\/[^"]+)"/i);
      return hrefMatch && !hrefMatch[1].includes('padeli.com');
    });
    if (outboundLinks.length === 0) {
      errors.push('[SEO61] No outbound links in body. Add links to venue website, booking platform, or social profiles (target 2-4).');
    } else if (outboundLinks.length < 2) {
      warnings.push(`[SEO61] Only ${outboundLinks.length} outbound link(s) in body (target 2-4). Add links to venue website and booking platform.`);
    }
  }

  // Check 62: Meta description max 156 chars (Yoast truncation point)
  if (yoast.metadesc) {
    const descLen = yoast.metadesc.length;
    if (descLen > 156) {
      errors.push(`[SEO62] Yoast metadesc is ${descLen} chars — Yoast truncates at 156. Shorten to fit.`);
    }
  }

  // Check 63: Focus keyphrase must appear in Yoast SEO title
  if (yoast.title && focuskw) {
    if (!yoast.title.toLowerCase().includes(focuskw)) {
      errors.push(`[SEO63] Focus keyphrase "${focuskw}" not found in Yoast SEO title "${yoast.title}". Include it for best results.`);
    }
  }

  // Check 64: Focus keyphrase must appear in meta description
  if (yoast.metadesc && focuskw) {
    if (!yoast.metadesc.toLowerCase().includes(focuskw)) {
      errors.push(`[SEO64] Focus keyphrase "${focuskw}" not found in meta description. Include it.`);
    }
  }

  // Check 65: Focus keyphrase or "padel" in at least 1 H3 subheading
  if (body && focuskw) {
    const h3Matches = body.match(/<h3[^>]*>([\s\S]*?)<\/h3>/gi) || [];
    const h3Texts = h3Matches.map(h => stripHtml(h).toLowerCase());
    const keyphraseInH3 = h3Texts.filter(t => t.includes('padel'));
    if (keyphraseInH3.length === 0) {
      errors.push('[SEO65] No H3 subheadings contain "padel" or the focus keyphrase. Add it to at least 1-2 subheadings.');
    }
  }

  // Check 66: Keyphrase distribution — keyphrase or synonym should appear in at least 3 of 5 body sections
  if (body && focuskw) {
    // Split body by H3 headings to get sections
    const sections = body.split(/<h3[^>]*>/i);
    const kpWord = focuskw.replace(/\s+padel$/i, '').trim(); // venue name part
    let sectionsWithKP = 0;
    for (const section of sections) {
      const sectionLower = stripHtml(section).toLowerCase();
      if (sectionLower.includes('padel') || (kpWord && sectionLower.includes(kpWord))) {
        sectionsWithKP++;
      }
    }
    if (sections.length >= 3 && sectionsWithKP < 3) {
      warnings.push(`[SEO66] Keyphrase/synonym found in only ${sectionsWithKP}/${sections.length} sections. Distribute more evenly (target 3+).`);
    }
  }

  // Check 67: Focus keyphrase should be venue-specific, not just "padel {city}"
  if (focuskw && venueName) {
    const venueWords = venueName.toLowerCase().split(/\s+/);
    const kwContainsVenueName = venueWords.some(w => w.length > 3 && focuskw.includes(w));
    if (!kwContainsVenueName) {
      warnings.push(`[SEO67] Focus keyphrase "${focuskw}" doesn't include the venue name — risk of keyphrase collision with other ${city || 'city'} listings. Use "${venueName.toLowerCase()} padel" instead.`);
    }
  }

  // =========================================================================
  // BUILD CLEANED PAYLOAD
  // =========================================================================

  if (cleaned.hero_hook) cleaned.hero_hook = cleanText(cleaned.hero_hook);
  if (cleaned.heroHook) cleaned.heroHook = cleanText(cleaned.heroHook);
  if (cleaned.body_html) cleaned.body_html = cleanText(cleaned.body_html);
  if (cleaned.body) cleaned.body = cleanText(cleaned.body);
  if (cleaned.content) cleaned.content = cleanText(cleaned.content);

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    cleaned,
  };
}

// ---------------------------------------------------------------------------
// PAYLOAD VALIDATOR — validatePayload (WP-ready payload)
// ---------------------------------------------------------------------------

/**
 * Validate a WP-ready payload (has status, listing_feature, listing_category, meta, etc.)
 * against structural and WP-specific rules.
 *
 * @param {object} wpPayload - The WP-ready payload object
 * @param {string} venueName - Name of the venue
 * @param {object} [options] - Optional: { city, countryCode, listingId }
 * @returns {{ pass: boolean, errors: string[], warnings: string[], cleaned: object }}
 */
function validatePayload(wpPayload, venueName, options = {}) {
  const errors = [];
  const warnings = [];
  const cleaned = JSON.parse(JSON.stringify(wpPayload));
  const meta = wpPayload.meta || {};
  const city = options.city || '';
  const venueNameLower = (venueName || '').toLowerCase();

  // =========================================================================
  // STRUCTURAL CHECKS (hard fail)
  // =========================================================================

  // Check 1: status=draft
  if (wpPayload.status !== undefined && wpPayload.status !== 'draft') {
    errors.push(`[S1] status must be "draft" (got "${wpPayload.status}")`);
  }

  // Check 2: _verified=0
  if (meta._verified !== undefined && String(meta._verified) !== '0') {
    errors.push(`[S2] _verified must be "0" (got "${meta._verified}")`);
  }

  // Check 3: listing_category contains 189 AND clubs_category contains 135
  if (wpPayload.listing_category !== undefined) {
    if (!Array.isArray(wpPayload.listing_category) || !wpPayload.listing_category.includes(189)) {
      errors.push('[S3] listing_category must include 189 (Padel Club)');
    }
  }
  if (wpPayload.clubs_category !== undefined) {
    if (!Array.isArray(wpPayload.clubs_category) || !wpPayload.clubs_category.includes(135)) {
      errors.push('[S3] clubs_category must include 135 (Padel Club)');
    }
  }

  // Check 4: region array has 3 entries, none zero/null
  if (wpPayload.region !== undefined) {
    if (!Array.isArray(wpPayload.region) || wpPayload.region.length !== 3) {
      errors.push(`[S4] region must have exactly 3 entries [country, county, city] (got ${Array.isArray(wpPayload.region) ? wpPayload.region.length : 'non-array'})`);
    } else {
      for (let i = 0; i < wpPayload.region.length; i++) {
        if (!wpPayload.region[i]) {
          const labels = ['country', 'county', 'city'];
          errors.push(`[S4] region ${labels[i]} (index ${i}) is zero or null`);
        }
      }
    }
  }

  // Check 5: listing_feature populated, warn if <8
  if (wpPayload.listing_feature !== undefined) {
    if (!Array.isArray(wpPayload.listing_feature) || wpPayload.listing_feature.length === 0) {
      errors.push('[S5] listing_feature must be populated');
    } else if (wpPayload.listing_feature.length < 8) {
      warnings.push(`[S5] listing_feature has ${wpPayload.listing_feature.length} features (recommend 8+)`);
    }
  }

  // =========================================================================
  // META FIELD CHECKS (28-41) — on WP meta object
  // =========================================================================

  // Check 28: _address populated (HARD FAIL)
  if (meta._address !== undefined) {
    if (!meta._address || !String(meta._address).trim()) {
      errors.push('[M28] _address is empty - must be populated');
    }
  }

  // Check 29: _place_id populated (HARD FAIL)
  if (meta._place_id !== undefined) {
    if (!meta._place_id || !String(meta._place_id).trim()) {
      errors.push('[M29] _place_id is empty - mandatory for Google Reviews widget');
    }
  }

  // Check 30: _phone with +CC format (WARNING)
  if (meta._phone !== undefined) {
    if (!meta._phone || !String(meta._phone).trim()) {
      warnings.push('[M30] _phone is empty');
    } else if (!/^\+\d/.test(String(meta._phone).trim())) {
      warnings.push(`[M30] _phone should start with + followed by country code (got "${meta._phone}")`);
    }
  }

  // Check 31: _website with https:// (WARNING)
  if (meta._website !== undefined) {
    if (!meta._website || !String(meta._website).trim()) {
      warnings.push('[M31] _website is empty');
    } else if (!String(meta._website).trim().startsWith('https://')) {
      warnings.push(`[M31] _website should start with https:// (got "${meta._website}")`);
    }
  }

  // Check 32: _whatsapp digits only (HARD FAIL)
  if (meta._whatsapp !== undefined && meta._whatsapp !== '' && meta._whatsapp !== null) {
    if (!/^\d+$/.test(String(meta._whatsapp))) {
      errors.push(`[M32] _whatsapp must be digits only - no +, spaces, or dashes (got "${meta._whatsapp}")`);
    }
  }

  // Check 33: _surface_type under 25 chars (WARNING)
  if (meta._surface_type && String(meta._surface_type).length > 25) {
    warnings.push(`[M33] _surface_type exceeds 25 chars (${String(meta._surface_type).length}): "${meta._surface_type}"`);
  }

  // Check 34: _lighting under 25 chars (WARNING)
  if (meta._lighting && String(meta._lighting).length > 25) {
    warnings.push(`[M34] _lighting exceeds 25 chars (${String(meta._lighting).length}): "${meta._lighting}"`);
  }

  // Check 35: _opening_hours present, complete (all 7 days covered), and well-formed (WARNING)
  // Expands day ranges ("Mon-Fri") into individual days. Empty/missing previously
  // passed silently — now always reports.
  {
    const hoursStr = typeof meta._opening_hours === 'string' ? meta._opening_hours.trim() : '';
    if (!hoursStr) {
      warnings.push('[M35] _opening_hours is missing or empty — opening times table will not render');
    } else {
      const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
      const covered = new Set();
      for (const entry of hoursStr.split(',').map(s => s.trim())) {
        const m = entry.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(?:-(Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\b/);
        if (!m) continue;
        const start = ALL_DAYS.indexOf(m[1]);
        const end = m[2] ? ALL_DAYS.indexOf(m[2]) : start;
        if (start < 0 || end < start) { covered.add(m[1]); continue; }
        for (let i = start; i <= end; i++) covered.add(ALL_DAYS[i]);
      }
      const missingDays = ALL_DAYS.filter(d => !covered.has(d));
      if (missingDays.length > 0) {
        warnings.push(`[M35] _opening_hours missing day(s): ${missingDays.join(', ')} — got "${hoursStr}"`);
      } else {
        const hoursPattern = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)(-(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun))?\s+\d{2}:\d{2}-\d{2}:\d{2}/;
        if (!hoursPattern.test(hoursStr)) {
          warnings.push(`[M35] _opening_hours may not follow "Mon-Fri HH:MM-HH:MM" pattern (got "${hoursStr}")`);
        }
      }
    }
  }

  // Check 36: _price_min and _price_max numeric only (WARNING)
  if (meta._price_min !== undefined && meta._price_min !== '' && meta._price_min !== null) {
    if (!/^\d+(\.\d+)?$/.test(String(meta._price_min))) {
      warnings.push(`[M36] _price_min must be numeric only (got "${meta._price_min}")`);
    }
  }
  if (meta._price_max !== undefined && meta._price_max !== '' && meta._price_max !== null) {
    if (!/^\d+(\.\d+)?$/.test(String(meta._price_max))) {
      warnings.push(`[M36] _price_max must be numeric only (got "${meta._price_max}")`);
    }
  }

  // Check 37: _clubs_tab_opening_year is exactly 4 digits (WARNING)
  if (meta._clubs_tab_opening_year !== undefined && meta._clubs_tab_opening_year !== '' && meta._clubs_tab_opening_year !== null) {
    if (!/^\d{4}$/.test(String(meta._clubs_tab_opening_year))) {
      warnings.push(`[M37] _clubs_tab_opening_year must be exactly 4 digits (got "${meta._clubs_tab_opening_year}")`);
    }
  }

  // Check 38: _instagram format (WARNING)
  if (meta._instagram && String(meta._instagram).trim()) {
    if (!/^https:\/\/www\.instagram\.com\//.test(String(meta._instagram).trim())) {
      warnings.push(`[M38] _instagram should be https://www.instagram.com/... format (got "${meta._instagram}")`);
    }
  }

  // Check 39: _facebook format starts with https:// (WARNING)
  if (meta._facebook && String(meta._facebook).trim()) {
    if (!String(meta._facebook).trim().startsWith('https://')) {
      warnings.push(`[M39] _facebook should start with https:// (got "${meta._facebook}")`);
    }
  }

  // Check 40: _faq_status = 'on' (WARNING)
  if (meta._faq_status !== undefined) {
    if (meta._faq_status !== 'on') {
      warnings.push(`[M40] _faq_status should be "on" (got "${meta._faq_status}")`);
    }
  }

  // Check 41 (2026-05-19 calibrated): flag accidental duplicates between
  // semantically-distinct fields, NOT the expected overlaps. Listeo's "Book"
  // modal reads `_booking_link` as the action URL; `_playtomic_url` and
  // `_direct_booking_url` are source markers that should mirror it when that
  // is the booking channel. So:
  //   - `_booking_link === _playtomic_url`  : EXPECTED when Playtomic is the booking method
  //   - `_booking_link === _direct_booking_url` : EXPECTED when direct site is the booking method
  //   - `_booking_link === _website` : SUSPICIOUS — website is informational, booking is action
  //   - `_playtomic_url === _direct_booking_url` : CONTRADICTION — venue is either Playtomic OR direct
  //   - `_website === _playtomic_url` or `_website === _direct_booking_url` : SUSPICIOUS
  {
    const get = f => meta[f] && String(meta[f]).trim();
    const link = get('_booking_link');
    const playtomic = get('_playtomic_url');
    const direct = get('_direct_booking_url');
    const website = get('_website');
    const dupes = [];
    if (link && website && link === website) dupes.push('_booking_link === _website');
    if (playtomic && direct && playtomic === direct) dupes.push('_playtomic_url === _direct_booking_url');
    if (website && playtomic && website === playtomic) dupes.push('_website === _playtomic_url');
    if (website && direct && website === direct) dupes.push('_website === _direct_booking_url');
    if (dupes.length > 0) {
      warnings.push(`[M41] Booking URL fields collide on semantically-distinct fields: ${dupes.join('; ')} — should be distinct CTAs`);
    }
  }

  // =========================================================================
  // CONTENT CHECKS on wpPayload.content (body)
  // =========================================================================

  const body = typeof wpPayload.content === 'string'
    ? wpPayload.content
    : (wpPayload.content && wpPayload.content.raw ? wpPayload.content.raw : '');

  if (body) {
    const bodyNoSchema = stripWpHtmlBlocks(body);
    const heroHook = meta._coaches_tab_short_description || '';

    // Check 6: Body opens with bold venue name
    if (venueName) {
      const firstPMatch = body.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      if (firstPMatch) {
        const strongRegex = new RegExp(`<strong>${venueName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}<\\/strong>`, 'i');
        if (!strongRegex.test(firstPMatch[1])) {
          errors.push(`[C6] Body must open with bold venue name: first <p> should contain <strong>${venueName}</strong>`);
        }
      }
    }

    // Check 7: Required H2 sections in order + About/Coaching/Facilities
    const payloadCoachingStateForC7 = meta.coaching_state || (wpPayload.acf && wpPayload.acf.coaching_state) || '';
    const hasCoachingForC7 = payloadCoachingStateForC7 === 'in_house' || payloadCoachingStateForC7 === 'freelance';
    const structureResult = checkBodyStructure(body, venueName, { hasCoaching: hasCoachingForC7 });
    if (!structureResult.valid) {
      for (const err of structureResult.errors) {
        errors.push(`[C7] ${err}`);
      }
    }
    if (structureResult.warnings) {
      for (const w of structureResult.warnings) {
        warnings.push(`[C7] ${w}`);
      }
    }

    // Check 7b: Per-court pricing alongside per-person pricing
    {
      const bodyLowerForPrice = body.toLowerCase();
      const hasPerPerson = bodyLowerForPrice.includes('per person');
      const hasPerCourt = bodyLowerForPrice.includes('per court');
      if (hasPerPerson && !hasPerCourt) {
        warnings.push('[C7b] Body shows per-person pricing but no per-court pricing - include both where venue charges per court');
      }
    }

    // Check 8: Word count 600-900 (HARD FAIL under 600)
    const bodyWordCount = countWords(bodyNoSchema);
    if (bodyWordCount < 600) {
      errors.push(`[C8] Body word count is ${bodyWordCount} - MINIMUM 600 required (target 600-900). Research agent must produce more content.`);
    } else if (bodyWordCount > 900) {
      warnings.push(`[C8] Body word count is ${bodyWordCount} (target 600-900, over maximum 900)`);
    }

    // Check 9: No DA block
    if (body.includes('Quick answer:') || body.includes('padeli-direct-answer')) {
      errors.push('[C9] Body contains a Direct Answer block - must be removed');
    }

    // Check 10: No banned phrases
    const bannedFound = checkBannedPhrases(body);
    if (bannedFound.length > 0) {
      errors.push(`[C10] Banned phrases found in body: ${bannedFound.join(', ')}`);
    }

    // Check 11: No em/en dashes
    const allTextPayload = `${heroHook} ${body}`;
    const dashIssues = checkDashes(allTextPayload);
    if (dashIssues.length > 0) {
      errors.push(`[C11] Found ${dashIssues.length} em/en dash(es) - must use " - " (space hyphen space)`);
    }

    // Check 12: Paragraphs under 60 words
    const paraCheck = checkParagraphLength(body);
    if (paraCheck.failures.length > 0) {
      for (const p of paraCheck.failures) {
        errors.push(`[C12] Paragraph ${p.index + 1} exceeds 60 words (${p.wordCount} words)`);
      }
    }

    // Check 13: No raw URLs
    const withoutAnchorContent = bodyNoSchema
      .replace(/<a\s[^>]*>[\s\S]*?<\/a>/gi, '')
      .replace(/href="[^"]*"/gi, '')
      .replace(/src="[^"]*"/gi, '');
    const rawUrlMatch = withoutAnchorContent.match(/https?:\/\/[^\s<>"]+/gi);
    if (rawUrlMatch && rawUrlMatch.length > 0) {
      errors.push(`[C13] Raw URL(s) not wrapped in <a href>: ${rawUrlMatch.slice(0, 3).join(', ')}`);
    }

    // Check 15: No [VERIFY]
    if (body.includes('[VERIFY]')) {
      errors.push('[C15] Literal "[VERIFY]" found in body');
    }

    // Check 16: No emojis
    const emojiMatch = body.match(EMOJI_REGEX);
    if (emojiMatch) {
      errors.push(`[C16] Emojis found in body: ${emojiMatch.slice(0, 5).join(' ')}`);
    }

    // Check 17: No personal visit claims
    const bodyLower = body.toLowerCase();
    for (const phrase of PERSONAL_VISIT_PHRASES) {
      if (bodyLower.includes(phrase)) {
        errors.push(`[C17] Personal visit claim found: "${phrase}"`);
      }
    }

    // Check 52: FAQPage JSON-LD
    const hasFaqSchema = /<!-- wp:html -->\s*<script\s+type="application\/ld\+json">[^<]*"@type"\s*:\s*"FAQPage"[^<]*<\/script>\s*<!-- \/wp:html -->/i.test(body);
    if (!hasFaqSchema) {
      errors.push('[SC52] FAQPage JSON-LD not found in body');
    }

    // Check 53: Course JSON-LD if coaching_state="in_house"
    const payloadCoachingState = meta.coaching_state || (wpPayload.acf && wpPayload.acf.coaching_state) || '';
    if (payloadCoachingState === 'in_house') {
      const hasCourseSchema = /<!-- wp:html -->\s*<script\s+type="application\/ld\+json">[^<]*"@type"\s*:\s*"Course"[^<]*<\/script>\s*<!-- \/wp:html -->/i.test(body);
      if (!hasCourseSchema) {
        errors.push('[SC53] Course JSON-LD not found in body but coaching_state is "in_house"');
      }
    }

    // Check 54: No LocalBusiness schema
    const localBizMatches = body.match(/"@type"\s*:\s*"LocalBusiness"/gi);
    if (localBizMatches && localBizMatches.length > 0) {
      errors.push('[SC54] LocalBusiness schema found in body - Listeo theme handles this');
    }

    // Check 55: All JSON-LD inside <script> tags
    const wpHtmlRegex = /<!-- wp:html -->([\s\S]*?)<!-- \/wp:html -->/gi;
    let wpMatch;
    while ((wpMatch = wpHtmlRegex.exec(body)) !== null) {
      const blockContent = wpMatch[1].trim();
      if (/"@context"\s*:/i.test(blockContent) || /"@type"\s*:/i.test(blockContent)) {
        if (!/<script\s+type="application\/ld\+json">/i.test(blockContent)) {
          errors.push('[SC55] Bare JSON-LD found in wp:html block without <script> wrapper');
          break;
        }
      }
    }

    // Hero hook checks on meta._coaches_tab_short_description
    if (heroHook) {
      const hookResult = checkHeroHook(heroHook);
      if (!hookResult.valid) {
        for (const err of hookResult.errors) {
          errors.push(`[H] Hero hook: ${err}`);
        }
      }
    }
  }

  // =========================================================================
  // YOAST CHECKS on meta fields (WARNING)
  // =========================================================================

  // Check 47: Yoast title contains "Padel" and venue name
  if (meta._yoast_wpseo_title && venueName) {
    const titleLower = meta._yoast_wpseo_title.toLowerCase();
    if (!titleLower.includes('padel')) {
      warnings.push(`[Y47] Yoast title should contain "Padel" for keyphrase alignment`);
    }
    const venueWords = venueName.toLowerCase().split(/\s+/);
    const hasVenueName = venueWords.some(w => w.length > 3 && titleLower.includes(w));
    if (!hasVenueName) {
      warnings.push(`[Y47] Yoast title should contain the venue name`);
    }
  }

  // Check 48: Title length 40-65 chars
  if (meta._yoast_wpseo_title) {
    const titleLen = meta._yoast_wpseo_title.length;
    if (titleLen < 40 || titleLen > 65) {
      warnings.push(`[Y48] Yoast title is ${titleLen} chars (target 40-65)`);
    }
  }

  // Check 49: Meta desc 120-156 chars (Yoast hard truncation at 156)
  if (meta._yoast_wpseo_metadesc) {
    const descLen = meta._yoast_wpseo_metadesc.length;
    if (descLen < 120 || descLen > 156) {
      warnings.push(`[Y49] Yoast metadesc is ${descLen} chars (target 120-156, hard max 156)`);
    }
  }

  // Check 50: Meta desc contains focus keyphrase
  if (meta._yoast_wpseo_metadesc && meta._yoast_wpseo_focuskw) {
    if (!meta._yoast_wpseo_metadesc.toLowerCase().includes(meta._yoast_wpseo_focuskw.toLowerCase())) {
      warnings.push(`[Y50] Yoast metadesc doesn't contain focus keyphrase "${meta._yoast_wpseo_focuskw}"`);
    }
  }

  // Check 51: focuskw is venue-specific and lowercase
  if (meta._yoast_wpseo_focuskw) {
    const focusLower = meta._yoast_wpseo_focuskw.toLowerCase();
    if (!focusLower.includes('padel') || meta._yoast_wpseo_focuskw !== focusLower) {
      warnings.push(`[Y51] focuskw should include "padel" and be lowercase (got "${meta._yoast_wpseo_focuskw}")`);
    }
  }

  // =========================================================================
  // IMAGE CHECK (56) — WARNING
  // =========================================================================

  if (wpPayload.featured_media !== undefined) {
    if (!wpPayload.featured_media || wpPayload.featured_media === 0) {
      warnings.push('[I56] featured_media is not set - listing card will show map placeholder');
    }
  }

  // =========================================================================
  // FEATURE CHECKS (57-58)
  // =========================================================================

  const features = wpPayload.listing_feature || [];
  if (features.length > 0) {
    const invalidFeatures = features.filter(id => !VALID_FEATURE_IDS.has(Number(id)));
    if (invalidFeatures.length > 0) {
      warnings.push(`[FT57] Invalid feature IDs: ${invalidFeatures.join(', ')}`);
    }
  }
  if (features.length > 0 && features.length < 8) {
    warnings.push(`[FT58] Features array has ${features.length} items (recommend 8+)`);
  }

  // =========================================================================
  // FAQ CHECKS on meta._faq_list
  // =========================================================================

  const faqs = meta._faq_list || [];
  if (Array.isArray(faqs)) {
    // Check 42: Exactly 6 FAQs
    if (faqs.length !== 6) {
      errors.push(`[F42] Must have exactly 6 FAQs (found ${faqs.length})`);
    }

    if (faqs.length > 0) {
      for (let i = 0; i < faqs.length; i++) {
        const question = (faqs[i].question || faqs[i].q || '').toLowerCase();
        const answer = (faqs[i].answer || faqs[i].a || '').trim();

        // Check 43: FAQ question names venue
        if (venueName) {
          const mentionsVenue = question.includes(venueNameLower);
          const mentionsCity = city && question.includes(city.toLowerCase());
          if (!mentionsVenue && !mentionsCity) {
            errors.push(`[F43] FAQ ${i + 1} question does not name the venue "${venueName}"`);
          }
        }

        // Check 44: No empty answers
        if (!answer) {
          errors.push(`[F44] FAQ ${i + 1} answer is empty`);
        }

        // Check 45: No [VERIFY] in answers
        if (answer.includes('[VERIFY]')) {
          errors.push(`[F45] FAQ ${i + 1} answer contains "[VERIFY]"`);
        }

        // Check 46: No <a> tags in question
        const rawQuestion = faqs[i].question || faqs[i].q || '';
        if (/<a\s/i.test(rawQuestion)) {
          errors.push(`[F46] FAQ ${i + 1} question contains <a> tag - links go in answers only`);
        }
      }
    }
  }

  return {
    pass: errors.length === 0,
    errors,
    warnings,
    cleaned,
  };
}

// ---------------------------------------------------------------------------
// URL VALIDATION — async, called separately by orchestrator before WP push
// ---------------------------------------------------------------------------

const http = require('http');
const https = require('https');

/**
 * HTTP HEAD request with redirect following. Returns final status code.
 * Uses only built-in Node.js modules (zero deps).
 *
 * @param {string} url - URL to check
 * @param {number} [maxRedirects=5] - Maximum redirect hops
 * @param {number} [timeoutMs=5000] - Timeout per request in ms
 * @returns {Promise<{ status: number, finalUrl: string, error: string|null }>}
 */
function headCheck(url, maxRedirects = 5, timeoutMs = 5000) {
  return new Promise((resolve) => {
    let redirectsLeft = maxRedirects;

    function doRequest(currentUrl) {
      let parsedUrl;
      try {
        parsedUrl = new URL(currentUrl);
      } catch {
        return resolve({ status: 0, finalUrl: currentUrl, error: `Invalid URL: ${currentUrl}` });
      }

      const client = parsedUrl.protocol === 'https:' ? https : http;
      const opts = {
        method: 'HEAD',
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        timeout: timeoutMs,
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; PadeliQC/1.0)',
          'Accept': '*/*',
        },
      };

      const req = client.request(opts, (res) => {
        // Follow redirects (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          if (redirectsLeft <= 0) {
            return resolve({ status: res.statusCode, finalUrl: currentUrl, error: 'Too many redirects' });
          }
          redirectsLeft--;
          // Handle relative redirects
          let nextUrl;
          try {
            nextUrl = new URL(res.headers.location, currentUrl).href;
          } catch {
            return resolve({ status: res.statusCode, finalUrl: currentUrl, error: `Bad redirect URL: ${res.headers.location}` });
          }
          return doRequest(nextUrl);
        }
        resolve({ status: res.statusCode, finalUrl: currentUrl, error: null });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, finalUrl: currentUrl, error: 'Timeout (5s)' });
      });

      req.on('error', (err) => {
        resolve({ status: 0, finalUrl: currentUrl, error: err.message });
      });

      req.end();
    }

    doRequest(url);
  });
}

/**
 * Validate external URLs in venue data before WordPress push.
 * Async — must be awaited by the orchestrator.
 *
 * Checks:
 * - _booking_link / _playtomic_url / _direct_booking_url: HEAD check, strip if 404
 * - _website: HEAD check, warn if 404 but don't strip
 *
 * @param {object} venueData - Object with meta fields (or meta_updates).
 *   Accepts either { meta: { _booking_link, ... } } or { meta_updates: { ... } } or flat { _booking_link, ... }
 * @returns {Promise<{ errors: string[], warnings: string[], strippedFields: string[] }>}
 */
async function validateUrls(venueData) {
  const errors = [];
  const warnings = [];
  const strippedFields = [];

  // Resolve the meta object from whichever shape the caller provides
  const meta = venueData.meta || venueData.meta_updates || venueData;

  // Fields to check: booking fields get stripped on 404, website only warned
  const bookingFields = ['_booking_link', '_playtomic_url', '_direct_booking_url'];
  const websiteFields = ['_website'];

  // Deduplicate URLs to avoid hitting the same endpoint multiple times
  const urlToFields = new Map(); // url -> { fields: string[], strip: boolean }

  for (const field of bookingFields) {
    const url = meta[field] && String(meta[field]).trim();
    if (url && /^https?:\/\//.test(url)) {
      if (!urlToFields.has(url)) {
        urlToFields.set(url, { fields: [], strip: true });
      }
      urlToFields.get(url).fields.push(field);
    }
  }

  for (const field of websiteFields) {
    const url = meta[field] && String(meta[field]).trim();
    if (url && /^https?:\/\//.test(url)) {
      if (!urlToFields.has(url)) {
        urlToFields.set(url, { fields: [], strip: false });
      } else {
        // URL already tracked by a booking field — keep strip=true for those, add this field
        // but this field itself should not be stripped
      }
      urlToFields.get(url).fields.push(field);
    }
  }

  // Run all HEAD checks in parallel
  const entries = [...urlToFields.entries()];
  const results = await Promise.all(
    entries.map(([url]) => headCheck(url))
  );

  for (let i = 0; i < entries.length; i++) {
    const [url, info] = entries[i];
    const result = results[i];

    if (result.error) {
      // Connection error or timeout
      for (const field of info.fields) {
        if (bookingFields.includes(field)) {
          warnings.push(`[URL] ${field}: could not reach ${url} (${result.error})`);
        } else {
          warnings.push(`[URL] ${field}: could not reach ${url} (${result.error})`);
        }
      }
      continue;
    }

    if (result.status === 404) {
      for (const field of info.fields) {
        if (bookingFields.includes(field)) {
          errors.push(`[URL] ${field}: 404 Not Found — stripping broken URL "${url}"`);
          meta[field] = '';
          strippedFields.push(field);
        } else {
          // _website — warn only, don't strip (venue may have temporary outage)
          warnings.push(`[URL] ${field}: 404 Not Found for "${url}" (not stripped — may be temporary)`);
        }
      }
    } else if (result.status >= 400) {
      for (const field of info.fields) {
        warnings.push(`[URL] ${field}: HTTP ${result.status} for "${url}"`);
      }
    }
    // 200-399 (excluding redirects, which are already followed) = fine, no output needed
  }

  return { errors, warnings, strippedFields };
}

// ---------------------------------------------------------------------------
// MODULE EXPORTS
// ---------------------------------------------------------------------------

module.exports = {
  validateListing,
  validatePayload,
  validateUrls,
  checkBannedPhrases,
  checkDashes,
  checkParagraphLength,
  checkHeroHook,
  checkBodyStructure,
  cleanText,
  countWords,
  stripHtml,
  extractParagraphs,
  BANNED_PHRASES,
  HERO_HOOK_EXTRA_BANNED,
  VALID_FEATURE_IDS,
  REQUIRED_H2_HEADINGS,
  REQUIRED_H3_HEADINGS,
  PERSONAL_VISIT_PHRASES,
  MECHANICAL_TRANSITION_OPENERS,
};
