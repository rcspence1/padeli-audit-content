---
name: padeli:audit-content
description: "Audit live padeli.com content for SEO quality, Yoast compliance, expert-level ranking signals, rendered page health, link integrity, and real search performance. Runs 7-layer analysis: QC validators (67-point listing / 54-point blog), Yoast SEO (12 checks), expert SEO (22 checks), live page verification (10 checks), link validation (external URL HEAD checks), GSC performance (7 signals — clicks, impressions, CTR, position, trends, queries), GA4 engagement (3 signals — bounce, dwell, engagement rate), and Ahrefs (stubbed for Lite plan). Use when Ryan says 'audit', 'check content', 'SEO audit', 'scan listings', 'check links', or '/padeli:audit-content'."
user-invocable: true
---

# Padeli Audit Content

Post-publish content auditor for padeli.com. Scans live listings and blog posts across 5 layers:

1. **QC Reuse** -- 67-point listing validator + 54-point blog validator (existing pipeline checks)
2. **Yoast SEO** -- focus keyword, meta, OG tags, schema graph, robots directives (12 checks)
3. **Expert SEO** -- keyword placement, density, content depth, AEO signals, linking, freshness (17 checks)
4. **Live Page** -- rendered HTML verification: title, meta, canonical, OG, schema, robots, errors (10 checks)
5. **GSC/GA** -- search performance data (stubbed -- needs Mark's credentials)
6. **Link Validation** -- extracts all external URLs from body HTML and meta fields (_booking_link, _playtomic_url, _direct_booking_url, _website). HTTP HEAD check on each URL with redirect following. Categorizes as PASS (200-399), FAIL (404/410/connection error), or WARN (500+/timeout). Available for both listings and blog posts.

**Composite Score:** QC 35-40% + Yoast 25-30% + Expert 25-30% + Live 0-15%

---

## Input Modes

### Mode 1: Single Listing

```
/padeli:audit-content listing 10097
/padeli:audit-content listing 11520
```

Audits one listing by WP post ID.

### Mode 2: Single Blog Post

```
/padeli:audit-content post 5363
/padeli:audit-content post best-padel-rackets-uk-2026
```

Audits one blog post by WP ID or slug.

### Mode 3: Batch Listings

```
/padeli:audit-content listings
/padeli:audit-content listings --limit 20
/padeli:audit-content listings --status publish
```

Audits all (or N) listings. Returns summary with top issues and worst performers.

### Mode 4: Batch Blog Posts

```
/padeli:audit-content posts
/padeli:audit-content posts --limit 10
```

Audits all (or N) blog posts.

### Mode 5: Full Site

```
/padeli:audit-content site
/padeli:audit-content site --limit 50
```

Audits everything -- listings + posts. Returns combined summary.

### Mode 6: Rendered Page Only

```
/padeli:audit-content page https://padeli.com/listing/pure-padel-darlington/
```

Quick front-end check only (Layer 4 -- no WP API needed).

### Mode 7: Fix Opening Hours (write mode)

```
/padeli:audit-content fix-hours 16786
/padeli:audit-content fix-hours --all-drafts --dry-run
/padeli:audit-content fix-hours --all-drafts --country AU
```

Repair missing or incomplete `_opening_hours` on draft listings. Re-resolves
hours through a deterministic waterfall:
  1. **Playtomic raw** (if `opening_hours_raw` provided)
  2. **Google Places API** (via `_place_id`)
  3. Returns `unfixable` if neither source produces 7-day data

Patches both `_opening_hours` (canonical "Mon-Fri 06:00-23:00, Sat 07:00-21:00,
Sun 07:00-21:00") AND the 14 Listeo per-day fields (`_monday_opening_hour`,
`_monday_closing_hour`, etc.) in a single WP REST PUT.

Use `--dry-run` to preview the patch without writing. Use `--country` to scope
to a specific country (`AU`, `AE`, `GB`, etc., or substring match on address).
This is the **only write-mode** in the auditor — all other modes are read-only.

---

## Execution Steps

### Step 1: Parse Input

Determine audit mode from Ryan's message. Extract:
- `mode` -- listing / post / listings / posts / site / page
- `target` -- ID, slug, or URL (for single modes)
- `limit` -- max items for batch modes (default: all)
- `status` -- publish / draft / any (default: any for listings, publish for posts)
- `skipLive` -- skip rendered page checks for speed (use `--skip-live`)
- `skipLinks` -- skip link validation checks for speed (use `--skip-links`)

### Step 2: Run the Audit

**For single items:**

```bash
node -e "
const { auditSingleListing, formatSingleReport } = require('./content-auditor');
auditSingleListing({ID}, { skipLive: false }).then(r => {
  console.log(formatSingleReport(r));
  console.log('\n--- RAW JSON ---');
  console.log(JSON.stringify(r, null, 2));
}).catch(err => console.error('Error:', err.message));
"
```

Or for posts:

```bash
node -e "
const { auditSinglePost, formatSingleReport } = require('./content-auditor');
auditSinglePost('{ID_OR_SLUG}', { skipLive: false }).then(r => {
  console.log(formatSingleReport(r));
}).catch(err => console.error('Error:', err.message));
"
```

**For batch audits:**

```bash
node -e "
const { auditAllListings, formatBatchSummary } = require('./content-auditor');
auditAllListings({ limit: {N}, status: '{STATUS}', skipLive: true }).then(r => {
  console.log(formatBatchSummary(r.summary));
}).catch(err => console.error('Error:', err.message));
"
```

**Or via CLI directly:**

```bash
node content-auditor.js listing 10097
node content-auditor.js post best-padel-rackets-uk-2026
node content-auditor.js listings --limit 20 --skip-live
node content-auditor.js posts --limit 10
node content-auditor.js site --limit 50 --skip-live
node content-auditor.js page https://padeli.com/listing/pure-padel-darlington/
```

Add `--json` for raw JSON output instead of formatted report.

### Step 3: Present Results

**For single audits**, show the full formatted report with all layers.

**For batch audits**, show the summary first, then offer to drill into worst performers:

```
LISTING AUDIT SUMMARY
Total: 227 | Passed: 180 | Failed: 47 | Errors: 0
Pass Rate: 79% | Avg Score: 72%

Top Issues:
  [Y01] No focus keyword set -- 89 occurrences (39%)
  [E08] Internal links below target -- 156 occurrences (69%)
  [E09] No external links -- 134 occurrences (59%)

Worst Performers:
  #4521 Club Name -- 12 errors, 8 warnings
  #4890 Club Name -- 9 errors, 6 warnings
```

Then ask: "Want me to drill into any of these? Or export the full results?"

### Step 4: Actionable Recommendations

After presenting results, group issues by fix type:

1. **Quick wins** (fix in bulk via script): missing focus keywords, empty meta descriptions, missing OG images
2. **Content improvements** (manual/AI rewrite): low keyword density, missing TLDR blocks, thin content
3. **Technical fixes** (one-time): noindex directives, missing schema, broken canonical URLs
4. **Structural gaps** (pipeline upgrade): missing H2 sections, no internal links, no tables for AEO

---

## The Audit Layers

### Layer 1: QC Reuse

Runs existing pipeline validators against live content pulled from WP REST API.

**Listings (67 checks):**
- Structural (5): status, verified, categories, regions, features
- Content (17): body structure, H2 order, word count, banned phrases, paragraph length, FAQ
- Hero Hook (5): length, sentence count, banned terms
- Meta (14): address, place ID, phone format, website, booking URLs, Yoast fields
- FAQ (5): count, venue naming, empty answers
- Schema (5): FAQPage, LocalBusiness, JSON-LD format
- Images (2): featured media, gallery count

**Blog Posts (54 checks):**
- Voice & Style (12): banned phrases, reading level, transitions
- Structure (13): heading hierarchy, word count, DA paragraph, reading time
- Linking (10): internal count, external count, anchor diversity
- Yoast/SEO (8): title, meta desc, focus keyword, canonical
- Images (7): count, alt text, featured image
- YMYL (5): health content verification
- Hard Limits (6): slug, fact-check log, max word count

### Layer 2: Yoast SEO Analysis (12 checks)

Pulls `yoast_head_json` and `_yoast_wpseo_*` meta from WP REST API.

| Check | What | Severity |
|-------|------|----------|
| Y01 | Focus keyword set | Error |
| Y02 | Yoast title 50-65 chars | Warning |
| Y03 | Meta desc 120-156 chars | Warning |
| Y04 | Focus keyword in title | Warning |
| Y05 | Focus keyword in meta desc | Warning |
| Y06 | Not noindexed | Error |
| Y07 | Canonical URL set | Warning |
| Y08 | OG title present | Warning |
| Y09 | OG description present | Warning |
| Y10 | OG image present | Warning |
| Y11 | Schema graph completeness (WebPage, Org, Breadcrumb) | Warning |
| Y12 | Twitter card type | Info |

### Layer 3: Expert SEO Checks (34 checks)

Informed by Ahrefs (on-page SEO, AEO course, content audit framework), Nathan Gotch (ranking factors, content optimisation, SEO 2.0), Yoast (agentic AI discoverability, 2026), and padeli content strategy.

| Check | What | Source | Severity |
|-------|------|--------|----------|
| E01 | Keyword in H1 | Ahrefs | Error |
| E02 | Keyword in first 100 words | Gotch | Warning |
| E03 | Keyword density 0.5-2.5% | Ahrefs | Warning |
| E04 | Keyword in slug | Ahrefs | Warning |
| E05 | Word count vs target | All | Error/Info |
| E06 | H2 heading count | Gotch | Warning |
| E07 | Keyword in section headings | Ahrefs | Warning |
| E08 | Internal links vs target | Ahrefs | Warning |
| E09 | External authority links | Gotch | Warning |
| E10 | Images in content | Ahrefs | Warning |
| E11 | Alt text with keyword | Ahrefs | Warning |
| E12 | Content freshness (<180 days) | Ahrefs | Warning |
| E13 | Featured image set | All | Warning |
| E14 | AEO: TLDR/DA block present | Gotch | Info |
| E15 | FAQPage schema in content | Ahrefs | Warning |
| E16 | Table present (AI bait) | Gotch | Info |
| E17 | List elements present | Ahrefs | Info |
| E18 | Sentence brevity (>75% under 20 words) | Gotch | Warning |
| E19 | Multiple H1 tags (should be 1) | Ahrefs | Warning |
| E20 | Year in slug current (not outdated) | Ahrefs | Warning |
| E21 | Suspicious outbound links (shorteners) | Ahrefs | Warning |
| E22 | Specific data points (information gain) | Ahrefs | Info |
| E23 | Definition pattern in first 200 words | Yoast/AEO | Info |
| E24 | DA block positioned in first 200 words | Yoast/AEO | Info |
| E25 | Entity naming consistency (title/meta/body/schema) | Yoast/AEO | Warning |
| E26 | Published/updated date signals (schema + visible) | Yoast/AEO | Info |
| E27 | Step-by-step format for how-to content | Yoast/AEO | Info |
| E28 | Citation-worthy unique data points | Yoast/AEO | Warning/Info |
| E29 | First-hand experience markers (distinctive perspective) | Google AI Guide | Warning/Info |
| E30 | Anti-commodity template detection (listicle/guide titles need data density) | Google AI Guide | Warning/Info |
| E31 | Author byline + Person schema (E-E-A-T) | Google AI Guide | Warning/Info |
| E32 | Snippet eligibility (no nosnippet / max-snippet:0 / data-nosnippet) | Google AI Guide | **Error** |
| E33 | Multimedia richness (≥1 image per 400 words) | Google AI Guide | Warning/Info |
| E34 | Entity clarity in schema (focus entity in `name` or `about`) | Google AI Guide | Warning/Info |

**E29–E34 added 2026-05-17** — direct implementation of Google's
[AI Optimization Guide](https://developers.google.com/search/docs/fundamentals/ai-optimization-guide).
These determine eligibility for AI Overviews and AI Mode answers, not just
classic Search rankings. E32 (snippet eligibility) is **error-grade** because
a page that blocks snippets cannot appear in AI surfaces at all.

### Layer 4: Live Page Checks (10 checks)

Fetches the rendered HTML and checks front-end output.

| Check | What | Severity |
|-------|------|----------|
| L01 | Page accessible (HTTP 200) | Error |
| L02 | Title tag present | Error |
| L03 | Meta description on page | Warning |
| L04 | Canonical URL tag | Warning |
| L05 | OG tags (title, desc, image) | Warning |
| L06 | JSON-LD schema blocks present | Warning |
| L07 | FAQPage schema on rendered page | Warning |
| L08 | No noindex directive | Error |
| L09 | Hreflang tags (informational) | Info |
| L10 | No error page indicators (404/500) | Error |

### Layer 5: GSC Performance (7 signals)

Live — uses OAuth token at `~/.config/gcloud/padeli-oauth-token.json`.

| Signal | What | Severity |
|--------|------|----------|
| G01 | Average position check (page 1 vs 2 vs 3+) | Warning/Info |
| G02 | Impressions-to-clicks ratio (0-click detection) | Error/Warning |
| G03 | Low impressions (authority/backlink deficit) | Info |
| G04 | CTR vs expected for position (title/meta quality) | Warning |
| G05 | Position trend vs previous 28 days | Warning/Info |
| G06 | Impression trend drop (>30% decline) | Warning |
| G07 | No GSC data (new or unindexed page) | Info |

Also returns: top 10 queries per page, clicks, impressions, CTR, position, trend deltas.

### Layer 6: Link Validation

Extracts all external URLs from body HTML and meta fields (`_booking_link`, `_playtomic_url`, `_direct_booking_url`, `_website`). Performs HTTP HEAD check on each URL with redirect following. Available for both listings and blog posts.

| Result | Condition | Severity |
|--------|-----------|----------|
| PASS | HTTP 200-399 | -- |
| FAIL | HTTP 404, 410, connection error | Error |
| WARN | HTTP 500+, timeout | Warning |

Can be run standalone via `check-links` CLI command or as part of full audits. Skip with `--skip-links`.

### Layer 7: GA4 Engagement (3 signals)

Live — uses GA4 property `properties/530686060` (Padeli.com).

| Signal | What | Severity |
|--------|------|----------|
| GA2 | Bounce rate >80% | Warning |
| GA3 | Avg session <30s with 10+ pageviews | Warning |
| GA4 | Engagement rate <40% | Info |

### Layer 8: Ahrefs (Stubbed)

Waiting for Ahrefs Lite subscription. When available:
- Keyword difficulty per ranking query
- Backlink count and referring domains
- Traffic estimate vs actual
- Content gap analysis

---

## Output Format

### Single Audit

```
PASS/FAIL -- {Name} (ID: {id})
  Type: listing/post ({post_type})
  Status: publish/draft
  Score: {composite}%
  Link: {url}

  Errors ({N}):
    - [code] description

  Warnings ({N}):
    - [code] description

  Yoast SEO Issues ({N}, score: {N}%):
    - [Y01] description

  Expert SEO Issues ({N}, score: {N}%):
    - [E01] description

  SEO Opportunities ({N}):
    - [E14] description

  Live Page Issues ({N}):
    - [L01] description

  GSC: {status message}
```

### Batch Summary

```
=== LISTING AUDIT SUMMARY ===
Total: {N} | Passed: {N} | Failed: {N} | Errors: {N}
Pass Rate: {N}% | Avg Score: {N}%

Top Issues:
  [{code}] -- {count} occurrences ({pct}%)

Worst Performers:
  #{id} {name} -- {errors} errors, {warnings} warnings
```

---

## Standalone Operations

```bash
# Single listing audit
node content-auditor.js listing 10097

# Single post audit (by ID or slug)
node content-auditor.js post 5363
node content-auditor.js post best-padel-rackets-uk-2026

# Batch listings (fast mode -- skip live page checks)
node content-auditor.js listings --skip-live --limit 50

# Batch posts
node content-auditor.js posts --limit 20

# Full site audit
node content-auditor.js site --skip-live

# Rendered page check only (no WP API)
node content-auditor.js page https://padeli.com/listing/pure-padel-darlington/

# Link validation only
node content-auditor.js check-links 10097              # Check links on a single listing/post
node content-auditor.js check-links --all              # Check links on all published listings
node content-auditor.js check-links --all-posts        # Check links on all published posts

# JSON output for piping/processing
node content-auditor.js listing 10097 --json

# Skip link validation during full audits
node content-auditor.js listing 10097 --skip-links
```

---

## Safety Rules

- **Read-only.** This skill never modifies any content. It only reads from WP REST API and fetches rendered pages.
- **Rate limited.** 200ms delay between live page fetches to avoid hammering the server.
- **No credentials exposed.** Uses env vars (PADELI_WP_USER, PADELI_WP_APP_PASSWORD) via wp-client.js.
- **GSC/GA blocked.** Layer 5 returns stubs until Mark provides service account credentials.

---

## Dependencies

- Node.js v24+ (native fetch, no npm packages, zero external deps)
- All required modules bundled in this repo:

| Module | What it does |
|--------|--------------|
| `content-auditor.js` | Main audit engine — all 7 layers, orchestrators, reports, fix-hours mode |
| `opening-hours-resolver.js` | Playtomic → Google Places waterfall for repairing `_opening_hours` |
| `wp-client.js` | WP REST client (auth, GET/POST/PUT/DELETE) |
| `wp-payload.js` | Hours string parser + Listeo per-day field builder |
| `qc-validator.js` | 67-point listing QC validator |
| `blog-qc-validator.js` | 54-point blog QC validator |
| `utils.js` | String utilities (stripHtml, countWords, etc.) |
| `notion-sync.js` | Post-audit Notion status updates |

- Env vars (export in `~/.zshrc`):
  - `PADELI_WP_USER` — WP username
  - `PADELI_WP_APP_PASSWORD` — WP application password
  - `GOOGLE_PLACES_API_KEY` — used by `fix-hours` mode to recover opening hours
  - (Optional) GSC/GA OAuth token at `~/.config/gcloud/padeli-oauth-token.json` for Layers 5 & 6

---

## Future: Ahrefs Layer

When Ahrefs Lite subscription is active ($129/mo):

1. Add `AHREFS_API_KEY` env var
2. Implement `fetchAhrefsData()` in content-auditor.js (stub already in place)
3. Data feeds: keyword difficulty, backlinks, referring domains, traffic estimates, content gaps
4. Composite score reweighted to include competitive positioning data
