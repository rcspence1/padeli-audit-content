/**
 * publish-gate.js — the BPA gold-standard PUBLISH GATE (all 9 non-negotiables).
 *
 * Why this exists: audit-content is a strong DETECTOR but its PASS verdict only
 * trips on QC hard-errors, so hero-image / gallery / hours / working-links /
 * Playtomic-correctness / geo-URL-200 are detected-but-not-blocking. This module
 * promotes ALL NINE non-negotiables to a hard gate so nothing below gold standard
 * goes (or stays) live. Citation quality = completeness + accuracy → no exceptions.
 *
 * Pure + reusable. Reads DIRECTLY from the WP object/meta (exact) and consumes an
 * already-computed audit result for the network checks (links + Playtomic drift).
 * Works in two modes:
 *   - mode:'draft' → "is this draft ready to be completed + published?"
 *       gallery + inbound-links + geo-URL-200 are DEFERRED (built/verified at publish),
 *       but their INPUTS are required (photo source, region+_listing_type).
 *   - mode:'live'  → the FINAL gold-standard stamp on a published listing; every one
 *       of the 9 must be physically present/correct (incl. rendered gallery + inlinks).
 *
 * No external deps. Does not write anything.
 */

// ---- meta helpers (Listeo stores many values as single-element arrays) --------
function mv(meta, key) {
  if (!meta) return '';
  let v = meta[key];
  if (Array.isArray(v)) v = v[0];
  return v === undefined || v === null ? '' : v;
}
function nonEmpty(s) { return String(s == null ? '' : s).trim().length > 0; }
function wordCount(s) { return String(s || '').trim().split(/\s+/).filter(Boolean).length; }
function stripTags(html) { return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }

// ---- the nine non-negotiables ------------------------------------------------
// Each evaluator returns { status:'pass'|'fail'|'deferred', detail }.
// 'deferred' only ever returned in draft mode for build-at-publish items, AND only
// when the INPUT needed to build it is present; otherwise it's a 'fail'.

const NON_NEGOTIABLES = [
  {
    key: 'hero_description', label: 'Hero description (hook, ≤30 words)',
    evaluate(wp, audit, mode) {
      const hero = mv(wp.meta, '_coaches_tab_short_description');
      if (!nonEmpty(hero)) return { status: 'fail', detail: 'hero hook empty' };
      const w = wordCount(hero);
      if (w > 30) return { status: 'fail', detail: `hero hook ${w} words (max 30)` };
      // corroborate: no hero-related QC error
      const heroErr = (audit?.errors || []).find(e => /hero hook/i.test(e));
      if (heroErr) return { status: 'fail', detail: heroErr };
      return { status: 'pass', detail: `${w}w` };
    },
  },
  {
    key: 'hero_image', label: 'Hero / featured image',
    evaluate(wp) {
      const fm = Number(wp.featured_media || 0);
      if (fm > 0) return { status: 'pass', detail: `featured_media=${fm}` };
      return { status: 'fail', detail: 'no featured_media' };
    },
  },
  {
    key: 'gallery', label: 'Photo gallery (≥6, no hero-dup)',
    evaluate(wp, audit, mode) {
      const g = wp.meta ? wp.meta._gallery : undefined;
      const ids = g && typeof g === 'object' ? Object.keys(g) : (Array.isArray(g) ? g : []);
      const count = ids.length;
      if (mode === 'draft') {
        // Galleries are built by the photo pipeline AT publish. Require a source.
        if (count > 0) return { status: 'pass', detail: `gallery already built (${count})` };
        const hasSource = Number(wp.featured_media || 0) > 0 || nonEmpty(mv(wp.meta, '_place_id'));
        return hasSource
          ? { status: 'deferred', detail: 'gallery builds at publish (source present)' }
          : { status: 'fail', detail: 'no gallery AND no photo source (featured_media/_place_id)' };
      }
      // live mode — must physically exist, >=1 (ideally 6), and NOT duplicate the hero
      if (count === 0) return { status: 'fail', detail: 'gallery empty on live listing' };
      const fm = String(wp.featured_media || '');
      const heroDup = fm && ids.map(String).includes(fm);
      if (heroDup) return { status: 'fail', detail: 'hero image duplicated into gallery' };
      if (count < 6) return { status: 'pass', detail: `gallery ${count} (recommend 6+)`, soft: true };
      return { status: 'pass', detail: `gallery ${count}` };
    },
  },
  {
    key: 'opening_hours', label: 'Opening hours / timings',
    evaluate(wp) {
      const status = String(mv(wp.meta, '_opening_hours_status') || '').toLowerCase();
      const flat = mv(wp.meta, '_opening_hours');
      const hasPerDay = ['monday','tuesday','wednesday','thursday','friday','saturday','sunday']
        .some(d => nonEmpty(mv(wp.meta, `_${d}_opening_hour`)));
      if (status === 'on' && (nonEmpty(flat) || hasPerDay)) return { status: 'pass', detail: 'hours on + populated' };
      // PUBLISH-WITHOUT-HOURS-WHEN-VERIFIED-UNSOURCEABLE policy (approved 2026-07-13; same principle
      // as the publish-without-court soft-pass on line ~149). Many new Jakarta venues publish their
      // operating hours only inside booking apps (AYO/Courtside/ISMAYA+) with nothing on Google/IG/
      // website/GBP, so hours are genuinely unsourceable. When hours are blank BUT a booking link is
      // present (users can still book), soft-pass instead of hard-failing. Operator must have verified
      // hours are truly absent from all public sources first (blank > wrong on the hours themselves).
      const booking = String(mv(wp.meta, '_booking_link') || '').trim();
      if (/^https?:\/\//i.test(booking)) return { status: 'pass', soft: true, detail: 'hours unavailable from any public source; soft-pass per publish-without-hours policy (booking link present)' };
      return { status: 'fail', detail: `_opening_hours_status='${status||'unset'}' and no booking link to soft-pass on` };
    },
  },
  {
    key: 'region_url', label: 'Region + _listing_type (geo URL valid)',
    evaluate(wp, audit, mode) {
      const lt = mv(wp.meta, '_listing_type');
      const region = Array.isArray(wp.region) ? wp.region : [];
      if (!nonEmpty(lt)) return { status: 'fail', detail: '_listing_type unset → geo URL 404s' };
      if (region.length < 2) return { status: 'fail', detail: `region chain ${region.length} (<2) → flat /listing/ fallback` };
      if (mode === 'live') {
        // geo-URL-200 is verified by the runner (needs a live HEAD); pass-through flag
        if (audit && audit._geoUrl200 === false) return { status: 'fail', detail: 'geo URL did not return 200' };
      }
      return { status: 'pass', detail: `type=${lt}, region depth ${region.length}` };
    },
  },
  {
    key: 'internal_links', label: 'Internal inlinks',
    evaluate(wp, audit, mode) {
      if (mode === 'draft') {
        // Inbound links are owned by post-publish; outbound by Listeo's geo-widget at render.
        // Cannot exist on a draft — deferred (verified live).
        return { status: 'deferred', detail: 'inlinks added/verified post-publish (Listeo widget + post-publish)' };
      }
      // live: count internal links in rendered HTML if available
      const html = audit?.live?.html || '';
      if (!html) return { status: 'deferred', detail: 'no rendered HTML captured (run with live)' };
      const internal = (html.match(/href=\"[^\"]*padeli\.com\/(clubs|coaching|tournaments)\/[^\"]+\"/g) || []).length
        + (html.match(/href=\"\/(clubs|coaching|tournaments)\/[^\"]+\"/g) || []).length;
      if (internal >= 3) return { status: 'pass', detail: `${internal} internal links rendered` };
      return { status: 'fail', detail: `only ${internal} internal links rendered (<3)` };
    },
  },
  {
    key: 'links_working', label: 'All links working',
    evaluate(wp, audit) {
      const links = audit?.links;
      if (!links) return { status: 'deferred', detail: 'links not validated (run without --skip-links)' };
      const failed = links.summary ? links.summary.failed : (links.checks || []).filter(c => c.pass === false && c.severity === 'error').length;
      if (failed > 0) {
        const bad = (links.checks || []).filter(c => c.pass === false && c.severity !== 'info').map(c => c.url).filter(Boolean).slice(0, 4);
        return { status: 'fail', detail: `${failed} dead link(s): ${bad.join(', ')}` };
      }
      return { status: 'pass', detail: `all ${links.summary ? links.summary.total : '?'} links OK` };
    },
  },
  {
    key: 'factual_accuracy', label: 'Factually accurate (Playtomic court data)',
    evaluate(wp, audit) {
      const courts = parseInt(mv(wp.meta, '_clubs_tab_total_courts'), 10) || 0;
      const drift = audit?.playtomicDrift;
      // If linked to Playtomic, no error-severity drift (PT02/PT03/PT05) allowed.
      if (drift && !drift.skipped && Array.isArray(drift.checks)) {
        const errs = drift.checks.filter(c => c.pass === false && c.severity === 'error');
        if (errs.length) return { status: 'fail', detail: errs.map(e => e.message).join(' | ') };
      }
      if (courts <= 0) return { status: 'pass', soft: true, detail: 'no court count available (blank per publish-without-court policy; Playtomic drift still hard-checked above)' };
      return { status: 'pass', detail: drift && !drift.skipped ? `courts=${courts}, Playtomic-verified` : `courts=${courts} (no PT link to cross-check)` };
    },
  },
  {
    key: 'body_seo', label: 'Body content + Yoast meta',
    evaluate(wp, audit) {
      const body = wp.content && (wp.content.raw || wp.content.rendered) || '';
      const words = wordCount(stripTags(body));
      if (words < 600) return { status: 'fail', detail: `body ${words} words (<600)` };
      const title = mv(wp.meta, '_yoast_wpseo_title');
      const desc = mv(wp.meta, '_yoast_wpseo_metadesc');
      const fkw = mv(wp.meta, '_yoast_wpseo_focuskw');
      const missing = [];
      if (!nonEmpty(title)) missing.push('title');
      if (!nonEmpty(desc)) missing.push('metadesc');
      if (!nonEmpty(fkw)) missing.push('focuskw');
      if (missing.length) return { status: 'fail', detail: `Yoast missing: ${missing.join(', ')} (body ${words}w ok)` };
      return { status: 'pass', detail: `body ${words}w + Yoast complete` };
    },
  },
];

/**
 * Evaluate the gate for one listing.
 * @param {object} wp - the WP listing object (with .meta, .region, .featured_media, .content)
 * @param {object} audit - result of auditSingleListing (for links/playtomicDrift/live/errors/score). Optional but needed for links/factual/inlinks.
 * @param {object} opts - { mode:'draft'|'live' }
 */
function evaluateGate(wp, audit = {}, opts = {}) {
  const mode = opts.mode === 'live' ? 'live' : 'draft';
  const items = NON_NEGOTIABLES.map(n => {
    const r = n.evaluate(wp, audit, mode);
    return { key: n.key, label: n.label, status: r.status, soft: !!r.soft, detail: r.detail };
  });
  const failures = items.filter(i => i.status === 'fail');
  const deferred = items.filter(i => i.status === 'deferred');
  const pass = failures.length === 0;
  return {
    listingId: wp.id,
    slug: wp.slug,
    name: (wp.title && (wp.title.raw || wp.title.rendered)) || wp.slug,
    status: wp.status,
    mode,
    pass,                                   // true = clears all NON-deferred non-negotiables
    readyToPublish: mode === 'draft' && pass, // draft cleared (deferred items will build at publish)
    goldStandard: mode === 'live' && pass && deferred.length === 0, // every one of 9 physically green
    score: audit && typeof audit.score === 'number' ? audit.score : null,
    failCount: failures.length,
    deferredCount: deferred.length,
    failures: failures.map(f => `${f.label}: ${f.detail}`),
    items,
  };
}

module.exports = { evaluateGate, NON_NEGOTIABLES };
