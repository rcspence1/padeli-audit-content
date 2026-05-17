/**
 * WP REST Payload Builder & Pusher for Padeli
 *
 * Converts research JSON into WP REST API payloads,
 * builds Gutenberg block HTML, FAQ/Course JSON-LD schemas,
 * and optionally pushes to WordPress.
 *
 * Includes meta wipe protection: snapshots Listeo protected fields
 * before POST, verifies after, and auto-refills any wiped fields.
 *
 * Node.js v24+ (native fetch, no external deps)
 */

const SITE_URL = 'https://padeli.com';

// ---------------------------------------------------------------------------
// Listeo Protected Meta Keys
// ---------------------------------------------------------------------------
// Listeo Core's pre-save filter can silently wipe these on REST POST
// when they are not explicitly included in the meta dict.
// We snapshot them before every write and refill any that get wiped.

const LISTEO_PROTECTED = [
  '_opening_hours',
  '_coaches_tab_short_description',
  '_coaches_tab_languages_spoken',
  '_address',
  '_friendly_address',
  '_geolocation_lat',
  '_geolocation_long',
  '_place_id',
  '_listing_timezone'
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCredentials() {
  const user = process.env.PADELI_WP_USER;
  const pass = process.env.PADELI_WP_APP_PASSWORD;
  if (!user || !pass) {
    throw new Error('Missing PADELI_WP_USER or PADELI_WP_APP_PASSWORD env vars');
  }
  return Buffer.from(`${user}:${pass}`).toString('base64');
}

// ---------------------------------------------------------------------------
// Timezone Resolution
// ---------------------------------------------------------------------------
// Maps country_code (+ optional city) to IANA timezone for Listeo's
// _listing_timezone field, which controls the "Now Open/Closed" badge.

const COUNTRY_TIMEZONES = {
  // Single-timezone countries — direct mapping
  GB: 'Europe/London',
  IE: 'Europe/Dublin',
  FR: 'Europe/Paris',
  ES: 'Europe/Madrid',
  PT: 'Europe/Lisbon',
  IT: 'Europe/Rome',
  DE: 'Europe/Berlin',
  NL: 'Europe/Amsterdam',
  BE: 'Europe/Brussels',
  SE: 'Europe/Stockholm',
  NO: 'Europe/Oslo',
  DK: 'Europe/Copenhagen',
  FI: 'Europe/Helsinki',
  AT: 'Europe/Vienna',
  CH: 'Europe/Zurich',
  PL: 'Europe/Warsaw',
  CZ: 'Europe/Prague',
  HU: 'Europe/Budapest',
  RO: 'Europe/Bucharest',
  GR: 'Europe/Athens',
  HR: 'Europe/Zagreb',
  SI: 'Europe/Ljubljana',
  SK: 'Europe/Bratislava',
  BG: 'Europe/Sofia',
  RS: 'Europe/Belgrade',
  LT: 'Europe/Vilnius',
  LV: 'Europe/Riga',
  EE: 'Europe/Tallinn',
  CY: 'Asia/Nicosia',
  MT: 'Europe/Malta',
  LU: 'Europe/Luxembourg',
  QA: 'Asia/Qatar',
  AE: 'Asia/Dubai',
  BH: 'Asia/Bahrain',
  KW: 'Asia/Kuwait',
  OM: 'Asia/Muscat',
  SA: 'Asia/Riyadh',
  EG: 'Africa/Cairo',
  ZA: 'Africa/Johannesburg',
  KE: 'Africa/Nairobi',
  MA: 'Africa/Casablanca',
  SG: 'Asia/Singapore',
  JP: 'Asia/Tokyo',
  KR: 'Asia/Seoul',
  TH: 'Asia/Bangkok',
  MY: 'Asia/Kuala_Lumpur',
  PH: 'Asia/Manila',
  IN: 'Asia/Kolkata',
  NZ: 'Pacific/Auckland',
  AR: 'America/Argentina/Buenos_Aires',
  CL: 'America/Santiago',
  CO: 'America/Bogota',
  PE: 'America/Lima',
  UY: 'America/Montevideo',
  PY: 'America/Asuncion',
  EC: 'America/Guayaquil',
  PA: 'America/Panama',
  CR: 'America/Costa_Rica',
  DO: 'America/Santo_Domingo',
  MX: 'America/Mexico_City',
  JM: 'America/Jamaica',
  TT: 'America/Port_of_Spain',
};

// Multi-timezone countries — city keyword → timezone
const CITY_TIMEZONES = {
  AU: {
    _default: 'Australia/Sydney',
    perth: 'Australia/Perth',
    darwin: 'Australia/Darwin',
    adelaide: 'Australia/Adelaide',
    brisbane: 'Australia/Brisbane',
    'gold coast': 'Australia/Brisbane',
    cairns: 'Australia/Brisbane',
    townsville: 'Australia/Brisbane',
    hobart: 'Australia/Hobart',
    melbourne: 'Australia/Melbourne',
    sydney: 'Australia/Sydney',
    canberra: 'Australia/Sydney',
    newcastle: 'Australia/Sydney',
    wollongong: 'Australia/Sydney',
  },
  US: {
    _default: 'America/New_York',
    'new york': 'America/New_York',
    boston: 'America/New_York',
    philadelphia: 'America/New_York',
    miami: 'America/New_York',
    atlanta: 'America/New_York',
    washington: 'America/New_York',
    charlotte: 'America/New_York',
    chicago: 'America/Chicago',
    dallas: 'America/Chicago',
    houston: 'America/Chicago',
    austin: 'America/Chicago',
    'san antonio': 'America/Chicago',
    nashville: 'America/Chicago',
    minneapolis: 'America/Chicago',
    denver: 'America/Denver',
    phoenix: 'America/Phoenix',
    'salt lake': 'America/Denver',
    albuquerque: 'America/Denver',
    'las vegas': 'America/Los_Angeles',
    'los angeles': 'America/Los_Angeles',
    'san francisco': 'America/Los_Angeles',
    'san diego': 'America/Los_Angeles',
    seattle: 'America/Los_Angeles',
    portland: 'America/Los_Angeles',
    sacramento: 'America/Los_Angeles',
    anchorage: 'America/Anchorage',
    honolulu: 'Pacific/Honolulu',
  },
  CA: {
    _default: 'America/Toronto',
    toronto: 'America/Toronto',
    ottawa: 'America/Toronto',
    montreal: 'America/Toronto',
    quebec: 'America/Toronto',
    halifax: 'America/Halifax',
    winnipeg: 'America/Winnipeg',
    regina: 'America/Regina',
    calgary: 'America/Edmonton',
    edmonton: 'America/Edmonton',
    vancouver: 'America/Vancouver',
    victoria: 'America/Vancouver',
  },
  BR: {
    _default: 'America/Sao_Paulo',
    'sao paulo': 'America/Sao_Paulo',
    'rio de janeiro': 'America/Sao_Paulo',
    brasilia: 'America/Sao_Paulo',
    manaus: 'America/Manaus',
    recife: 'America/Recife',
    fortaleza: 'America/Fortaleza',
  },
  ID: {
    _default: 'Asia/Jakarta',
    jakarta: 'Asia/Jakarta',
    bandung: 'Asia/Jakarta',
    surabaya: 'Asia/Jakarta',
    bali: 'Asia/Makassar',
    denpasar: 'Asia/Makassar',
    makassar: 'Asia/Makassar',
    jayapura: 'Asia/Jayapura',
  },
  RU: {
    _default: 'Europe/Moscow',
    moscow: 'Europe/Moscow',
    'saint petersburg': 'Europe/Moscow',
    vladivostok: 'Asia/Vladivostok',
    novosibirsk: 'Asia/Novosibirsk',
    yekaterinburg: 'Asia/Yekaterinburg',
  },
};

function resolveTimezone(countryCode, city) {
  const cc = (countryCode || '').toUpperCase();
  if (!cc) return null;

  // Check multi-timezone countries first
  if (CITY_TIMEZONES[cc]) {
    const cityLower = (city || '').toLowerCase().trim();
    if (cityLower) {
      // Try exact match, then substring match
      for (const [key, tz] of Object.entries(CITY_TIMEZONES[cc])) {
        if (key === '_default') continue;
        if (cityLower.includes(key) || key.includes(cityLower)) return tz;
      }
    }
    return CITY_TIMEZONES[cc]._default;
  }

  // Single-timezone countries
  return COUNTRY_TIMEZONES[cc] || null;
}

/**
 * Replace em/en dashes with " - ". Convert H2→H3 (Listeo theme uses H1 for venue name,
 * H3 for content sections — confirmed from live BPA listing).
 */
function sanitiseBody(html) {
  let out = html
    .replace(/[\u2013\u2014]/g, ' - ');

  // Convert H2 to H3 (correct hierarchy for Listeo theme)
  out = out.replace(/<!-- wp:heading -->/g, '<!-- wp:heading {"level":3} -->');
  out = out.replace(/<h2([^>]*)>/gi, '<h3$1>');
  out = out.replace(/<\/h2>/gi, '</h3>');
  // Ensure wp-block-heading class is present
  out = out.replace(/<h3(?![^>]*class=)([^>]*)>/gi, '<h3 class="wp-block-heading"$1>');

  // Strip any "Quick answer:" DA blocks
  out = out.replace(/<!-- wp:paragraph -->\s*<p>\s*Quick answer:.*?<\/p>\s*<!-- \/wp:paragraph -->/gi, '');

  return out;
}

// ---------------------------------------------------------------------------
// Opening Hours Parser
// ---------------------------------------------------------------------------

/**
 * Parse a flat opening hours string into Listeo per-day meta fields.
 * Input format: "Mon-Fri HH:MM-HH:MM, Sat HH:MM-HH:MM, Sun HH:MM-HH:MM"
 * Output: { _monday_opening_hour: ["06:30"], _monday_closing_hour: ["23:00"], ... }
 */
function parseOpeningHours(hoursStr) {
  if (!hoursStr || typeof hoursStr !== 'string') return {};

  const dayMap = {
    mon: 'monday', tue: 'tuesday', wed: 'wednesday', thu: 'thursday',
    fri: 'friday', sat: 'saturday', sun: 'sunday'
  };
  const dayOrder = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const result = {};

  // Init all days to empty arrays
  for (const full of Object.values(dayMap)) {
    result[`_${full}_opening_hour`] = [];
    result[`_${full}_closing_hour`] = [];
  }

  // Normalise common shorthands before parsing
  const normalised = hoursStr
    .replace(/\bdaily\b/gi, 'Mon-Sun')
    .replace(/\beveryday\b/gi, 'Mon-Sun')
    .replace(/\bweekdays\b/gi, 'Mon-Fri')
    .replace(/\bweekends?\b/gi, 'Sat-Sun')
    .replace(/\b24\s*\/?\s*7\b/gi, 'Mon-Sun 00:00-23:59');

  // Split by comma segments: "Mon-Fri 06:00-23:00", "Sat 07:00-22:00"
  const segments = normalised.split(',').map(s => s.trim());

  for (const seg of segments) {
    // Match pattern: "Mon-Fri 06:00-23:00" or "Sat 06:00-23:00" or "Mon 06:00-23:00"
    const match = seg.match(/^(\w{3})(?:-(\w{3}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/i);
    if (!match) continue;

    const startDay = match[1].toLowerCase().substring(0, 3);
    const endDay = match[2] ? match[2].toLowerCase().substring(0, 3) : startDay;
    const openTime = match[3];
    const closeTime = match[4];

    const startIdx = dayOrder.indexOf(startDay);
    const endIdx = dayOrder.indexOf(endDay);
    if (startIdx === -1 || endIdx === -1) continue;

    for (let i = startIdx; i <= endIdx; i++) {
      const full = dayMap[dayOrder[i]];
      result[`_${full}_opening_hour`] = [openTime];
      result[`_${full}_closing_hour`] = [closeTime];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Schema Builders
// ---------------------------------------------------------------------------

/**
 * Build FAQ JSON-LD as a wp:html block.
 */
function buildFaqSchema(faqs) {
  if (!faqs || faqs.length === 0) return '';

  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqs.map(faq => ({
      '@type': 'Question',
      name: faq.question,
      acceptedAnswer: {
        '@type': 'Answer',
        text: faq.answer
      }
    }))
  };

  return `<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(schema)}\n</script>\n<!-- /wp:html -->`;
}

/**
 * Build Course JSON-LD as a wp:html block.
 * Only used when coaching_state == "in_house".
 */
function buildCourseSchema(venueName, venueUrl, coachingAbout) {
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'Course',
    name: `Padel coaching at ${venueName}`,
    description: coachingAbout || `Professional padel coaching available at ${venueName}.`,
    provider: {
      '@type': 'SportsActivityLocation',
      name: venueName,
      url: venueUrl
    },
    hasCourseInstance: {
      '@type': 'CourseInstance',
      courseMode: 'InPerson'
    }
  };

  return `<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify(schema)}\n</script>\n<!-- /wp:html -->`;
}

// ---------------------------------------------------------------------------
// Internal Link Injection
// ---------------------------------------------------------------------------

/**
 * Inject internal links to related listings and blog posts on padeli.com.
 * Adds a contextual sentence with links in the "Best for" section or at end of body.
 * Uses the page index from data/page_index.json (built by linker.js).
 *
 * @param {string} content - The body HTML content
 * @param {string} venueName - Current venue name (excluded from link targets)
 * @param {object} opts - { country_code, city }
 * @returns {string} Content with internal links injected
 */
function injectInternalLinks(content, venueName, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const indexPath = path.join(__dirname, '..', 'data', 'page_index.json');

  let pageIndex;
  try {
    pageIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    // No page index available — skip internal links silently
    return content;
  }

  const allListings = pageIndex.listings || [];
  const allPosts = pageIndex.pages || [];
  const city = (opts.city || '').toLowerCase();
  const cc = (opts.country_code || '').toUpperCase();
  const venueNameLower = venueName.toLowerCase();

  // Find related listings: same city first, then same country, exclude self
  const sameCity = allListings.filter(l =>
    l.slug !== venueNameLower.replace(/\s+/g, '-') &&
    l.title && l.title.toLowerCase() !== venueNameLower &&
    city && l.url && l.title.toLowerCase().includes(city)
  );
  const sameCountry = allListings.filter(l =>
    l.slug !== venueNameLower.replace(/\s+/g, '-') &&
    l.title && l.title.toLowerCase() !== venueNameLower &&
    !sameCity.includes(l) &&
    l.region && l.region.toLowerCase().includes(cc.toLowerCase())
  );

  // Pick up to 3 related listings (prefer same city)
  const relatedListings = [...sameCity.slice(0, 2), ...sameCountry.slice(0, 1)].slice(0, 3);

  // Find related blog posts (city guides, "best padel in X" posts)
  const relatedPosts = allPosts.filter(p =>
    p.title && city && (
      p.title.toLowerCase().includes(city) ||
      p.title.toLowerCase().includes('padel')
    ) &&
    p.status === 'published'
  ).slice(0, 2);

  if (relatedListings.length === 0 && relatedPosts.length === 0) {
    return content; // Nothing to link to
  }

  // Build the internal links paragraph
  const links = [];
  for (const listing of relatedListings) {
    const url = listing.url || `${SITE_URL}/listing/${listing.slug}/`;
    links.push(`<a href="${url}">${listing.title}</a>`);
  }
  for (const post of relatedPosts) {
    const url = post.url || `${SITE_URL}/${post.slug}/`;
    links.push(`<a href="${url}">${post.title}</a>`);
  }

  const linkSentence = links.length === 1
    ? `Looking for more padel options? See ${links[0]}.`
    : `Looking for more padel options nearby? See ${links.slice(0, -1).join(', ')} and ${links[links.length - 1]}.`;

  const linkBlock = `<!-- wp:paragraph --><p>${linkSentence}</p><!-- /wp:paragraph -->`;

  // Inject before the last closing section (before FAQ/Course schema blocks)
  // Find the last wp:html block (which is schema) and insert before it
  const schemaPos = content.lastIndexOf('<!-- wp:html -->');
  if (schemaPos > 0) {
    return content.slice(0, schemaPos) + '\n\n' + linkBlock + '\n\n' + content.slice(schemaPos);
  }

  // No schema block — append at end
  return content + '\n\n' + linkBlock;
}

// ---------------------------------------------------------------------------
// Payload Builder
// ---------------------------------------------------------------------------

/**
 * Build the full WP REST payload for a listing.
 *
 * @param {string|number} listingId - WP post ID or 'NEW' for creation
 * @param {object} researchData - The research object for this listing
 * @param {string} venueName - Human-readable venue name
 * @param {string} venueUrl - Canonical URL of the listing on padeli.com
 * @returns {object} The payload ready for POST to WP REST
 */
function buildPayload(listingId, researchData, venueName, venueUrl, opts = {}) {
  const d = researchData;

  // Sanitise body HTML
  let content = sanitiseBody(d.body_html || '');

  // Append FAQ schema
  const faqBlock = buildFaqSchema(d.faqs);
  if (faqBlock) {
    content += '\n\n' + faqBlock;
  }

  // Append Course schema if in-house coaching
  if (d.coaching_state === 'in_house') {
    const courseBlock = buildCourseSchema(venueName, venueUrl, d.coaching_about);
    content += '\n\n' + courseBlock;
  }

  // Build meta object
  const meta = {
    _verified: '0',
    _coaches_tab_short_description: d.hero_hook || '',
    _faq_list: d.faqs || [],
    _faq_status: 'on',
    _yoast_wpseo_title: d.yoast?.title || '',
    _yoast_wpseo_metadesc: d.yoast?.metadesc || '',
    _yoast_wpseo_focuskw: d.yoast?.focuskw || '',
    '_yoast_wpseo_opengraph-title': d.yoast?.og_title || '',
    '_yoast_wpseo_opengraph-description': d.yoast?.og_description || '',
    '_yoast_wpseo_twitter-title': d.yoast?.twitter_title || '',
    '_yoast_wpseo_twitter-description': d.yoast?.twitter_description || '',
    ...(d.meta_updates || {})
  };

  // PROTECT hero hook — meta_updates must never overwrite this
  if (d.hero_hook) {
    meta._coaches_tab_short_description = d.hero_hook;
  }

  // PROTECT timezone — always resolve from country_code + city, ignore meta_updates value
  const tzCountry = d.country_code || opts.country_code || '';
  const tzCity = d.city || opts.city || '';
  const resolvedTz = resolveTimezone(tzCountry, tzCity);
  if (resolvedTz) {
    meta._listing_timezone = resolvedTz;
  }

  // Parse flat _opening_hours string into Listeo per-day fields
  if (meta._opening_hours && typeof meta._opening_hours === 'string') {
    const perDayHours = parseOpeningHours(meta._opening_hours);
    Object.assign(meta, perDayHours);
    meta._opening_hours_status = 'on';
    // Keep the flat string too — it's in LISTEO_PROTECTED
  }

  // Route email from research body into _email meta if not already set
  if (!meta._email && d.body_html) {
    const emailMatch = d.body_html.match(/[\w.+-]+@[\w-]+\.[\w.]+/);
    if (emailMatch) {
      meta._email = emailMatch[0];
    }
  }

  // Hero hook → excerpt (renders in Listeo hero area below venue name)
  const excerpt = d.hero_hook || '';

  // (Timezone resolved above, after meta_updates spread)

  // Booking URL — route Playtomic URL to all three booking meta fields
  if (d.meta_updates && !d.meta_updates._booking_link) {
    // Try playtomic_url from research, or fall back to discovery data
    const bookingUrl = d.playtomic_url || d.meta_updates._playtomic_url || '';
    if (bookingUrl) {
      meta._booking_link = bookingUrl;
      meta._direct_booking_url = bookingUrl;
      meta._playtomic_url = bookingUrl;
    }
  }

  // Internal links — inject links to related listings and blog posts
  content = injectInternalLinks(content, venueName, opts);

  // Build payload
  const payload = {
    content,
    excerpt,
    status: 'draft',
    meta,
    listing_feature: d.features_to_add || [],
    // Dual category assignment — both required for Listeo widgets and filters
    listing_category: [189],
    clubs_category: [135]
  };

  // ACF fields (coaching)
  if (d.coaching_about || d.coaching_price) {
    payload.acf = {};
    if (d.coaching_about) payload.acf.coaching_about = d.coaching_about;
    if (d.coaching_price) payload.acf.coaching_price = d.coaching_price;
  }

  return payload;
}

// ---------------------------------------------------------------------------
// WP REST API Functions
// ---------------------------------------------------------------------------

/**
 * GET a listing from WP REST API (with ?context=edit).
 *
 * @param {string|number} listingId - WP post ID
 * @returns {object} WP listing data
 */
async function getListing(listingId) {
  const auth = getCredentials();
  const url = `${SITE_URL}/wp-json/wp/v2/listing/${listingId}?context=edit`;

  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    }
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WP REST error ${res.status}: ${errorBody}`);
  }

  return res.json();
}

/**
 * Snapshot all LISTEO_PROTECTED meta values from a listing.
 *
 * @param {object} listingData - Full listing object from getListing()
 * @returns {object} Map of meta key -> value for all protected keys that have a value
 */
function snapshotProtectedMeta(listingData) {
  const meta = listingData.meta || {};
  const snapshot = {};
  for (const key of LISTEO_PROTECTED) {
    const val = meta[key];
    // Store anything that is truthy (non-null, non-empty string, non-empty array)
    if (val !== undefined && val !== null && val !== '' &&
        !(Array.isArray(val) && val.length === 0)) {
      snapshot[key] = val;
    }
  }
  return snapshot;
}

/**
 * Compare post-write listing meta against a snapshot and return wiped keys.
 *
 * @param {object} snapshot - From snapshotProtectedMeta() before the write
 * @param {object} postWriteData - Full listing object from getListing() after the write
 * @returns {string[]} Array of meta keys that were wiped
 */
function findWipedFields(snapshot, postWriteData) {
  const meta = postWriteData.meta || {};
  const wiped = [];
  for (const key of Object.keys(snapshot)) {
    const afterVal = meta[key];
    // Field was present before but is now missing, null, or empty
    if (afterVal === undefined || afterVal === null || afterVal === '' ||
        (Array.isArray(afterVal) && afterVal.length === 0)) {
      wiped.push(key);
    }
  }
  return wiped;
}

/**
 * Push a payload to WordPress REST API with meta wipe protection.
 *
 * Handles both CREATE and UPDATE:
 *   - listingId === 'NEW' -> POST to /wp-json/wp/v2/listing (create)
 *   - listingId is numeric -> POST to /wp-json/wp/v2/listing/{id} (update)
 *
 * For updates, snapshots protected meta before writing and auto-refills
 * any fields that Listeo's pre-save filter silently wipes.
 *
 * @param {string|number} listingId - WP post ID or 'NEW' for creation
 * @param {object} payload - Built payload from buildPayload()
 * @returns {object} WP response
 */
async function pushToWordPress(listingId, payload) {
  // Guard: detect raw research data passed instead of built payload.
  // Research data has body_html; built payloads have content.
  if (payload.body_html && !payload.content) {
    throw new Error(
      'pushToWordPress received raw research data (has body_html, missing content). ' +
      'Call buildPayload() first to convert research data into a WP payload.'
    );
  }

  const isCreate = listingId === 'NEW';
  const endpoint = isCreate
    ? `${SITE_URL}/wp-json/wp/v2/listing`
    : `${SITE_URL}/wp-json/wp/v2/listing/${listingId}`;

  const auth = getCredentials();

  // -----------------------------------------------------------------------
  // PRE-WRITE: Snapshot protected meta (updates only)
  // -----------------------------------------------------------------------
  let snapshot = {};
  if (!isCreate) {
    try {
      const before = await getListing(listingId);
      snapshot = snapshotProtectedMeta(before);
      if (Object.keys(snapshot).length > 0) {
        console.log(`[meta-protect] Snapshot captured for listing ${listingId}: ${Object.keys(snapshot).join(', ')}`);
      }
    } catch (err) {
      console.warn(`[meta-protect] Could not snapshot listing ${listingId} before write: ${err.message}`);
      // Continue with the write — snapshot is best-effort
    }
  }

  // -----------------------------------------------------------------------
  // WRITE: POST to WP REST
  // Strip _coaches_tab_short_description from the main payload — Listeo's
  // save_post hook strips it during bulk meta writes. It will be written
  // in the isolated hero hook pass after all other writes settle.
  // -----------------------------------------------------------------------
  const mainPayload = { ...payload };
  if (mainPayload.meta && mainPayload.meta._coaches_tab_short_description) {
    mainPayload.meta = { ...mainPayload.meta };
    delete mainPayload.meta._coaches_tab_short_description;
  }

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0'
    },
    body: JSON.stringify(mainPayload)
  });

  if (!res.ok) {
    const errorBody = await res.text();
    throw new Error(`WP REST error ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
  const actualId = data.id || listingId;
  console.log(`${isCreate ? 'Created' : 'Updated'} listing ${actualId} - status: ${data.status}, link: ${data.link || 'N/A'}`);

  // -----------------------------------------------------------------------
  // POST-WRITE: Meta reinforcement — Listeo's save_post hook can silently
  // drop custom meta on the first write to a new listing. A second POST
  // with just the meta ensures all fields stick.
  // IMPORTANT: Exclude _coaches_tab_short_description from bulk writes —
  // Listeo's save_post hook strips it during bulk meta updates. It gets
  // written in the isolated hero hook pass below.
  // -----------------------------------------------------------------------
  if (payload.meta && Object.keys(payload.meta).length > 0) {
    try {
      const reinforceMeta = { ...payload.meta };
      delete reinforceMeta._coaches_tab_short_description;

      const reinforceRes = await fetch(`${SITE_URL}/wp-json/wp/v2/listing/${actualId}`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0'
        },
        body: JSON.stringify({ meta: reinforceMeta })
      });

      if (!reinforceRes.ok) {
        const reinforceErr = await reinforceRes.text();
        console.error(`[meta-reinforce] Failed for listing ${actualId}: ${reinforceErr}`);
      } else {
        console.log(`[meta-reinforce] Reinforced ${Object.keys(payload.meta).length} meta field(s) on listing ${actualId}`);
      }
    } catch (err) {
      console.error(`[meta-reinforce] Error for listing ${actualId}: ${err.message}`);
    }
  }

  // -----------------------------------------------------------------------
  // POST-WRITE: Wipe scan and auto-refill (updates only, when we have a snapshot)
  // -----------------------------------------------------------------------
  if (Object.keys(snapshot).length > 0) {
    try {
      const after = await getListing(actualId);
      const wiped = findWipedFields(snapshot, after);

      if (wiped.length > 0) {
        console.warn(`[meta-protect] WIPE DETECTED on listing ${actualId}: ${wiped.join(', ')}`);

        // Build refill payload from snapshot
        const refill = {};
        for (const key of wiped) {
          refill[key] = snapshot[key];
        }

        // POST the refill
        const refillRes = await fetch(`${SITE_URL}/wp-json/wp/v2/listing/${actualId}`, {
          method: 'POST',
          headers: {
            'Authorization': `Basic ${auth}`,
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0'
          },
          body: JSON.stringify({ meta: refill })
        });

        if (!refillRes.ok) {
          const refillErr = await refillRes.text();
          console.error(`[meta-protect] Refill POST failed for listing ${actualId}: ${refillErr}`);
        } else {
          console.log(`[meta-protect] Restored ${wiped.length} wiped field(s) on listing ${actualId}: ${wiped.join(', ')}`);
        }
      } else {
        console.log(`[meta-protect] No wipes detected on listing ${actualId} — all protected fields intact`);
      }
    } catch (err) {
      console.error(`[meta-protect] Post-write wipe scan failed for listing ${actualId}: ${err.message}`);
    }
  }

  return data;
}

// ---------------------------------------------------------------------------
// Hero Hook Writer (standalone, call AFTER pushToWordPress completes)
// ---------------------------------------------------------------------------

/**
 * Write the hero hook (_coaches_tab_short_description) as a completely
 * isolated operation. Must be called AFTER pushToWordPress has returned
 * and all its save_post hooks have settled.
 *
 * Listeo's save_post hook strips this field during bulk meta writes.
 * Writing it in total isolation — with no other concurrent WP writes —
 * is the only reliable way to persist it.
 *
 * @param {string|number} listingId - WP post ID
 * @param {string} heroHook - The hero description text
 * @returns {boolean} True if verified as persisted
 */
async function writeHeroHook(listingId, heroHook) {
  if (!heroHook || !listingId) return false;

  const auth = getCredentials();
  const endpoint = `${SITE_URL}/wp-json/wp/v2/listing/${listingId}`;
  const headers = {
    'Authorization': `Basic ${auth}`,
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0'
  };

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Write ONLY this one field — nothing else
      await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          meta: { _coaches_tab_short_description: heroHook }
        })
      });

      // Verify with a clean GET after save_post settles
      await new Promise(r => setTimeout(r, 2000));
      const verifyRes = await fetch(`${endpoint}?context=edit&t=${Date.now()}`, {
        headers: { 'Authorization': `Basic ${auth}`, 'User-Agent': 'Mozilla/5.0' }
      });

      if (verifyRes.ok) {
        const data = await verifyRes.json();
        const val = data.meta?._coaches_tab_short_description || '';
        if (val) {
          console.log(`[hero-hook] Verified on listing ${listingId} (attempt ${attempt}): "${val.substring(0, 60)}..."`);
          return true;
        }
      }

      console.warn(`[hero-hook] Not persisted on listing ${listingId} (attempt ${attempt}), ${attempt < 3 ? 'retrying in 3s...' : 'giving up'}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    } catch (err) {
      console.error(`[hero-hook] Attempt ${attempt} failed for listing ${listingId}: ${err.message}`);
      if (attempt < 3) await new Promise(r => setTimeout(r, 3000));
    }
  }

  console.error(`[hero-hook] FAILED to persist hero hook on listing ${listingId} after 3 attempts`);
  return false;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  LISTEO_PROTECTED,
  buildPayload,
  buildFaqSchema,
  buildCourseSchema,
  pushToWordPress,
  writeHeroHook,
  getListing,
  snapshotProtectedMeta,
  findWipedFields,
  resolveTimezone,
  parseOpeningHours,
};
