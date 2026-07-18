# Hermes Usage Dashboard

Static, offline dashboard that summarises Hermes token usage from local
`state.db` totals plus call-level `agent.log` telemetry.

## Online dashboard

Published with GitHub Pages. `usage-data.json` is regenerated and pushed every
30 minutes by a script-only local Hermes cron job. The public export contains
aggregate time buckets, token/call counts, model labels, and public-safe project
labels—no session IDs, titles, prompts, message content, or filesystem paths.

Call-level events are retained in the private ignored file
`.runtime/realtime-telemetry.sqlite3` so rotating logs do not erase the 7-day
and 30-day history. That archive never enters Git.

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
- **KPIs** — rolling totals for 10 minutes, 1 hour, 12 hours, 24 hours, 7 days,
  and 30 days, with calls, cache rate, fresh input, output, and source badges.
- **Controls** — range (10m / 1h / 12h / 24h / 7d / 30d) and metric (total /
  composition / fresh input / output / cache read / calls).
- **Adaptive chart buckets** — 30 seconds, 1 minute, 15 minutes, 30 minutes,
  6 hours, and 1 day respectively.
- **Model breakdown** — independently filterable to last 7 days, last 30 days,
  or all time.
- **Charts** — primary usage chart with token composition integrated as a
  stacked mode (`input`/`output`/`cache_read`/`cache_write`/`reasoning`), weekly totals with peak
  highlighted, calls-vs-tokens scatter sized by session count.
- **Analysis panels** — usage drivers, quota pressure, operational
  recommendations, and the top five identifiable project contexts by token use.
- **Daily table** — sortable by every column.

## Data model reminders

- `total = input + output + cache_read + cache_write`
- `all_in` includes `reasoning`
- `cache_read` dominates: reused context, not fresh generation
- Project attribution uses explicit `cwd` or conversation `display_name`
  metadata only. Unattributed usage is reported separately and never guessed.
- Remaining OpenAI quota **cannot** be computed from `state.db`. The
  dashboard only surfaces the last observed 429 (`2026-07-05`, reset
  ≈ `19:01 +07`).
- Recent call telemetry separates fresh input from cache read using the API-call
  log line. Reasoning is not separately exposed on those lines.
- Until the private call archive has a complete 7-day or 30-day history, those
  windows use clearly labeled rolling session-start aggregates from `state.db`.

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
