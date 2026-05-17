# Padeli Audit Content

Post-publish content auditor for [padeli.com](https://padeli.com). Scans live
listings and blog posts across 7 layers, plus a write mode (`fix-hours`) that
repairs draft listings with missing or incomplete opening times.

## What It Does

| Layer | What it checks |
|------:|---|
| 1 | QC reuse — 67-point listing validator + 54-point blog validator |
| 2 | Yoast SEO — focus keyword, meta, OG tags, schema (12 checks) |
| 3 | Expert SEO — keyword placement, density, AEO signals, freshness (28 checks) |
| 4 | Live page — rendered HTML: title, meta, canonical, schema, OG (10 checks) |
| 5 | GSC performance — position, CTR, impressions, queries, trends (7 signals) |
| 6 | Link validation — HTTP HEAD checks on every external URL |
| 7 | GA4 engagement — bounce rate, dwell time, engagement rate |

Plus **`fix-hours`** — re-resolves missing `_opening_hours` on draft listings
via a deterministic Playtomic → Google Places waterfall, then patches WP.

## Quick Start

```bash
# Clone
git clone https://github.com/rcspence1/padeli-audit-content.git
cd padeli-audit-content

# Set env vars in ~/.zshrc (read-only modes need the WP creds; fix-hours
# additionally needs GOOGLE_PLACES_API_KEY)
export PADELI_WP_USER="..."
export PADELI_WP_APP_PASSWORD="..."
export GOOGLE_PLACES_API_KEY="..."

# Audit a single listing
node content-auditor.js listing 10097

# Batch audit all drafts (fast — skip live page checks)
node content-auditor.js listings --status draft --skip-live --limit 20

# Repair missing opening hours on all drafts (the write mode)
node content-auditor.js fix-hours --all-drafts --dry-run    # preview
node content-auditor.js fix-hours --all-drafts              # execute
```

Full skill spec: [`SKILL.md`](./SKILL.md).

## Requirements

- Node.js v24+ (native `fetch`, zero external deps)
- WordPress REST API credentials for padeli.com
- Google Places API key (for the `fix-hours` write mode only)

## Safety

All audit modes are **read-only**. The only mode that writes back to WordPress
is `fix-hours`, which patches the specific `_opening_hours` meta field (and the
14 Listeo per-day fields) on draft listings where data is recoverable. Use
`--dry-run` to preview any patch before it writes.
