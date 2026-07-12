# Hermes Usage Dashboard

Static, offline dashboard that summarises OpenAI Codex `gpt-5.5` usage from
local Hermes telemetry (`state.db` export → `usage-data.json`).

## Online dashboard

Published with GitHub Pages. `usage-data.json` is regenerated from the local Hermes database and pushed hourly by a local Hermes cron job. The export contains aggregate token/call counts by date and model only—no session titles or message content.

## Run locally

```sh
cd hermes-usage-dashboard
python3 -m http.server 5173
# open http://localhost:5173
```

No CDN, no build step. Vanilla HTML + CSS + JS. Charts are inline SVG.
Opening `index.html` directly with `file://` will fail on `fetch()` — always
serve through a local HTTP server.

## Files

- `index.html` — semantic markup, controls, sections.
- `styles.css` — dark editorial palette (Bloomberg / TE vibe), hairline
  dividers, mono numerics, dark/light via `prefers-color-scheme`,
  container queries on the KPI grid, reduced-motion respected.
- `app.js` — loads `usage-data.json`, renders KPIs, charts, table, tooltip.
- `usage-data.json` — input data.

## What is shown

- **Header** — provider, model, timezone, generated timestamp, 429 note.
- **GPT-5.6 versions** — an auto-updating panel that lists each billed `gpt-5.6-*` variant, its sessions, first/last-seen dates, total tokens, and share of GPT-5.6 usage. A newly used third variant appears after its first telemetry record.
- **KPIs** — today total, today calls, current week, all-time, quota status.
  Each KPI has a 14-day sparkline. Overall composition bar shows how much of
  all-time tokens are cache reads.
- **Controls** — range (14 / 30 / all), metric (total / input / output /
  cache_read / calls), view (daily / weekly).
- **Charts** — main bar chart, 14-day stacked composition
  (`cache_read`/`input`/`output`/`cache_write`), weekly totals with peak
  highlighted, calls-vs-tokens scatter sized by session count.
- **Analysis panels** — usage drivers, quota pressure, operational
  recommendations.
- **Daily table** — sortable by every column.

## Data model reminders

- `total = input + output + cache_read + cache_write`
- `all_in` includes `reasoning`
- `cache_read` dominates: reused context, not fresh generation
- Remaining OpenAI quota **cannot** be computed from `state.db`. The
  dashboard only surfaces the last observed 429 (`2026-07-05`, reset
  ≈ `19:01 +07`).

## Accessibility & UX

- Semantic landmarks (`header`, `main`, `section`, `footer`).
- Skip link to main content.
- Segmented controls are keyboard-focusable buttons with `aria-selected`.
- Sortable table headers are real buttons with `aria-sort`.
- Contrast tuned for both dark and light modes.
- Respects `prefers-reduced-motion`.

## Verify

- Syntax: `node --check app.js`
- Serve: `python3 -m http.server`
- Console: should be clean; a single warning appears only if
  `usage-data.json` fails to load.
