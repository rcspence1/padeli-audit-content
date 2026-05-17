/**
 * Opening Hours Resolver
 *
 * Deterministic waterfall for resolving a venue's opening hours:
 *   1. Playtomic raw data (venue.opening_hours_raw)
 *   2. Google Places API (regularOpeningHours.weekdayDescriptions via place_id)
 *   3. MISSING — caller decides to flag in Notion / halt the listing
 *
 * Output is the canonical _opening_hours string format used by Listeo:
 *   "Mon-Fri 06:00-23:00, Sat 07:00-21:00, Sun 07:00-21:00"
 *
 * Consecutive days with identical hours are collapsed into ranges.
 * Days with no hours (closed) are omitted.
 */

const DAYS_FULL = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const DAYS_SHORT = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/**
 * Collapse a 7-slot array of {open, close} (or null) into the canonical string.
 * @param {Array<{open: string, close: string}|null>} weekArr — index 0=Mon ... 6=Sun
 * @returns {string} canonical hours string, or '' if no days are open
 */
function collapseWeekToString(weekArr) {
  if (!Array.isArray(weekArr) || weekArr.length !== 7) return '';
  const parts = [];
  let i = 0;
  while (i < 7) {
    if (!weekArr[i]) { i++; continue; }
    const { open, close } = weekArr[i];
    let j = i;
    while (j + 1 < 7 && weekArr[j + 1] && weekArr[j + 1].open === open && weekArr[j + 1].close === close) {
      j++;
    }
    const dayPart = i === j ? DAYS_SHORT[i] : `${DAYS_SHORT[i]}-${DAYS_SHORT[j]}`;
    parts.push(`${dayPart} ${open}-${close}`);
    i = j + 1;
  }
  return parts.join(', ');
}

/**
 * Parse Playtomic opening_hours_raw into the canonical string.
 * Playtomic format: { MONDAY: { opening_time: "09:00", closing_time: "21:00" }, ... }
 * @param {object|null} raw — Playtomic opening_hours object
 * @returns {string} canonical hours string, or '' if no usable data
 */
function parsePlaytomicHours(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
  const week = DAYS_FULL.map(d => {
    const entry = raw[d];
    if (!entry || !entry.opening_time || !entry.closing_time) return null;
    const open = String(entry.opening_time).trim();
    const close = String(entry.closing_time).trim();
    if (!/^\d{1,2}:\d{2}$/.test(open) || !/^\d{1,2}:\d{2}$/.test(close)) return null;
    return { open: pad2(open), close: pad2(close) };
  });
  if (week.every(x => x === null)) return '';
  return collapseWeekToString(week);
}

/**
 * Parse Google Places weekdayDescriptions array into the canonical string.
 * Google format: ["Monday: 6:00 AM – 11:00 PM", "Tuesday: Closed", ...]
 *   — order is Monday-first (per Google v1 spec when locale is en-*)
 *   — handles both 12-hour (with AM/PM) and 24-hour times
 *   — handles "Closed" entries
 *   — handles en-dash "–" and hyphen "-" as separators
 * @param {string[]} descriptions
 * @returns {string} canonical hours string
 */
function parseGooglePlacesHours(descriptions) {
  if (!Array.isArray(descriptions) || descriptions.length === 0) return '';
  const byDay = {};
  for (const line of descriptions) {
    if (typeof line !== 'string') continue;
    const m = line.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday):\s*(.+)$/i);
    if (!m) continue;
    const day = m[1].toUpperCase();
    const rest = m[2].trim();
    if (/^closed$/i.test(rest) || /^24\s*hours/i.test(rest)) {
      if (/^24\s*hours/i.test(rest)) byDay[day] = { open: '00:00', close: '23:59' };
      // "Closed" -> leave undefined
      continue;
    }
    // Time format: "6:00 AM – 11:00 PM" or "06:00 – 22:00" or with hyphen
    const tm = rest.match(/(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)\s*[–-]\s*(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)/i);
    if (!tm) continue;
    const open = to24h(tm[1]);
    const close = to24h(tm[2]);
    if (open && close) byDay[day] = { open, close };
  }
  const week = DAYS_FULL.map(d => byDay[d] || null);
  if (week.every(x => x === null)) return '';
  return collapseWeekToString(week);
}

/**
 * Fetch opening hours from Google Places API v1.
 * @param {string} placeId
 * @param {{apiKey?: string}} [opts]
 * @returns {Promise<{ok: true, descriptions: string[]} | {ok: false, reason: string}>}
 */
async function fetchGooglePlacesHours(placeId, opts = {}) {
  if (!placeId) return { ok: false, reason: 'no_place_id' };
  const key = opts.apiKey || process.env.GOOGLE_PLACES_API_KEY;
  if (!key) return { ok: false, reason: 'no_api_key' };
  const url = `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'regularOpeningHours,businessStatus',
      },
    });
    if (!res.ok) {
      const body = await res.text();
      const oneLine = body.replace(/\s+/g, ' ').slice(0, 100);
      return { ok: false, reason: `http_${res.status}: ${oneLine}` };
    }
    const data = await res.json();
    const descriptions = data?.regularOpeningHours?.weekdayDescriptions;
    if (!Array.isArray(descriptions) || descriptions.length === 0) {
      return { ok: false, reason: 'no_hours_in_response' };
    }
    return { ok: true, descriptions };
  } catch (e) {
    return { ok: false, reason: `fetch_error: ${e.message}` };
  }
}

/**
 * Resolve opening hours via the full waterfall.
 *
 * @param {object} venue — must have at least one of: opening_hours_raw, place_id
 * @returns {Promise<{
 *   hours: string,            // canonical string, '' if unresolved
 *   source: 'playtomic'|'google_places'|null,
 *   sourcesTried: string[],   // what we attempted, with status notes
 * }>}
 */
async function resolveOpeningHours(venue) {
  const sourcesTried = [];

  // Step 1: Playtomic
  if (venue && venue.opening_hours_raw) {
    const ptHours = parsePlaytomicHours(venue.opening_hours_raw);
    if (ptHours) {
      sourcesTried.push('playtomic:ok');
      return { hours: ptHours, source: 'playtomic', sourcesTried };
    }
    sourcesTried.push('playtomic:empty_data');
  } else {
    sourcesTried.push('playtomic:no_data');
  }

  // Step 2: Google Places
  if (venue && venue.place_id) {
    const gp = await fetchGooglePlacesHours(venue.place_id);
    if (gp.ok) {
      const gpHours = parseGooglePlacesHours(gp.descriptions);
      if (gpHours) {
        sourcesTried.push('google_places:ok');
        return { hours: gpHours, source: 'google_places', sourcesTried };
      }
      sourcesTried.push('google_places:unparseable');
    } else {
      sourcesTried.push(`google_places:${gp.reason}`);
    }
  } else {
    sourcesTried.push('google_places:no_place_id');
  }

  return { hours: '', source: null, sourcesTried };
}

function pad2(time) {
  const [h, m] = time.split(':');
  return `${h.padStart(2, '0')}:${(m || '00').padStart(2, '0')}`;
}

function to24h(s) {
  s = s.trim().toUpperCase();
  const ampm = /AM|PM/.test(s);
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  if (ampm) {
    if (m[3] === 'PM' && h < 12) h += 12;
    else if (m[3] === 'AM' && h === 12) h = 0;
  }
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

module.exports = {
  resolveOpeningHours,
  parsePlaytomicHours,
  parseGooglePlacesHours,
  fetchGooglePlacesHours,
  collapseWeekToString,
};
