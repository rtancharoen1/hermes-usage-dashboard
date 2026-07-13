/* Hermes Usage Dashboard
 * Vanilla JS, no external deps. Renders KPIs + inline SVG charts.
 */

'use strict';

const SVG_NS = 'http://www.w3.org/2000/svg';

const state = {
  source: null,
  data: null,
  selection: 'all_tracked',
  range: 30,
  metric: 'total',
  view: 'daily',
  modelRange: 'all',
  tableSort: { key: 'day', dir: 'desc' },
};


const METRICS = {
  total:      { label: 'Total tokens',    color: 'var(--c-amber)' },
  input:      { label: 'Input tokens',    color: 'var(--c-input)' },
  output:     { label: 'Output tokens',   color: 'var(--c-output)' },
  cache_read: { label: 'Cache read',      color: 'var(--c-cache-read)' },
  calls:      { label: 'API calls',       color: 'var(--c-reason)' },
  grouped:    { label: 'Token composition', color: 'var(--c-amber)' },
};

const GROUPED_KEYS = ['input', 'output', 'cache_read', 'cache_write', 'reasoning'];
const GROUPED_META = {
  input:       { label: 'Input',       color: 'var(--c-input)' },
  output:      { label: 'Output',      color: 'var(--c-output)' },
  cache_read:  { label: 'Cache read',  color: 'var(--c-cache-read)' },
  cache_write: { label: 'Cache write', color: 'var(--c-cache-write)' },
  reasoning:   { label: 'Reasoning',   color: 'var(--c-reason)' },
};

/* ---------- formatting ---------- */

function fmtInt(n) {
  if (n == null || isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}
function fmtCompact(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e9) return (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
  if (abs >= 1e6) return (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
  if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
  return String(Math.round(n));
}
function fmtPct(n) {
  if (n == null || isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}
function fmtDelta(n) {
  if (n == null || isNaN(n)) return '—';
  const s = (n >= 0 ? '+' : '') + (n * 100).toFixed(0) + '%';
  return s;
}
function fmtDay(d) {
  // 2026-07-05 -> Jul 05
  const [y, m, day] = d.split('-');
  const mm = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m - 1];
  return `${mm} ${day}`;
}
function fmtShortDate(d) {
  const [, m, day] = d.split('-');
  return `${m}/${day}`;
}
function fmtPeriodStart(iso) {
  const match = String(iso || '').match(/^\d{4}-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return match ? `${match[1]}/${match[2]} ${match[3]}:${match[4]}` : '—';
}
function fmtMonth(m) {
  const [y, mm] = m.split('-');
  const names = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${names[+mm - 1]} ${y.slice(2)}`;
}

/* ---------- SVG helpers ---------- */

function el(name, attrs, children) {
  const node = document.createElementNS(SVG_NS, name);
  if (attrs) for (const k in attrs) node.setAttribute(k, attrs[k]);
  if (children) for (const c of children) node.appendChild(c);
  return node;
}
function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

/* ---------- collapsible sections ---------- */

const SECTION_VISIBILITY_KEY = 'hermes-usage-section-visibility-v1';

function setupCollapsibleSections() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(SECTION_VISIBILITY_KEY) || '{}'); } catch (_) {}

  document.querySelectorAll('main section.section').forEach((section, index) => {
    let head = Array.from(section.children).find(node => node.classList?.contains('section-head'));
    if (!head) {
      head = document.createElement('div');
      head.className = 'section-head';
      const heading = document.createElement('h2');
      heading.id = `section-controls-${index}`;
      heading.textContent = 'Filters & controls';
      head.appendChild(heading);
      section.prepend(head);
      section.setAttribute('aria-labelledby', heading.id);
    }

    const heading = head.querySelector('h2');
    const key = heading?.id || `dashboard-section-${index}`;
    const content = document.createElement('div');
    content.className = 'section-content';
    content.id = `${key}-content`;
    Array.from(section.children).filter(node => node !== head).forEach(node => content.appendChild(node));
    section.appendChild(content);

    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'section-toggle';
    button.setAttribute('aria-controls', content.id);
    const setOpen = open => {
      content.hidden = !open;
      button.setAttribute('aria-expanded', String(open));
      button.innerHTML = `<span aria-hidden="true">${open ? '−' : '+'}</span> ${open ? 'Hide' : 'Show'}`;
      section.classList.toggle('is-collapsed', !open);
    };
    setOpen(saved[key] !== false);
    button.addEventListener('click', () => {
      const open = button.getAttribute('aria-expanded') !== 'true';
      setOpen(open);
      saved[key] = open;
      try { localStorage.setItem(SECTION_VISIBILITY_KEY, JSON.stringify(saved)); } catch (_) {}
    });
    head.appendChild(button);
  });
}

/* ---------- boot ---------- */

async function boot() {
  try {
    const res = await fetch('./usage-data.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    state.source = await res.json();
    setupModelControl();
  } catch (err) {
    document.body.innerHTML = `<pre style="padding:24px;color:#f5a524">Failed to load usage-data.json. Serve this folder with a static server (e.g. python3 -m http.server) and reload.\n\n${err.message}</pre>`;
    return;
  }
  setupCollapsibleSections();
  wireControls();
  wireModelBreakdownRange();
  wireDayDialog();
  renderAll();
  window.addEventListener('resize', () => {
    // charts are SVG viewBox based, but recompute for label spacing
    renderCharts();
  }, { passive: true });
}

function renderAll() {
  renderHeader();
  renderKPIs();
  renderAnalysis();
  renderTable();
  renderCharts();
  renderModelBreakdown();
  renderGPT56Versions();
  renderHeatmap();
}

function renderCharts() {
  renderMainChart();
  renderWeeklyChart();
  renderScatterChart();
}

/* ---------- header ---------- */

function renderHeader() {
  const d = state.data;
  document.getElementById('meta-generated').textContent =
    d.generated_at_local.replace('T', ' ').split('+')[0].split('.')[0];
  document.getElementById('meta-tz').textContent = d.timezone;
  document.getElementById('meta-provider').textContent = d.model.provider === 'all' ? 'All tracked models' : `${d.model.provider} · ${d.model.model}`;
  document.getElementById('head-model-name').textContent = d.model.provider === 'all' ? 'All models' : d.model.model;
  document.getElementById('meta-sessions').textContent = fmtInt(d.overall.sessions);
}

/* ---------- KPIs ---------- */

function renderKPIs() {
  const d = state.data;
  const daily = d.daily;
  const periods = d.periods || {};
  const periodSpecs = [
    ['24h', periods.last_24_hours, 1],
    ['7d', periods.last_7_days, 7],
    ['30d', periods.last_30_days, 30],
  ];

  for (const [id, exact, fallbackDays] of periodSpecs) {
    const fallbackRows = daily.slice(-fallbackDays);
    const period = exact || {
      total: fallbackRows.reduce((sum, row) => sum + (row.total || 0), 0),
      calls: fallbackRows.reduce((sum, row) => sum + (row.calls || 0), 0),
      start_local: fallbackRows[0] ? `${fallbackRows[0].day}T00:00:00` : '',
    };
    const value = document.getElementById(`kpi-${id}-total`);
    value.textContent = fmtCompact(period.total);
    value.setAttribute('title', fmtInt(period.total));
    document.getElementById(`kpi-${id}-range`).textContent = `since ${fmtPeriodStart(period.start_local)}`;
    document.getElementById(`kpi-${id}-calls`).textContent = fmtInt(period.calls);
    const average = document.getElementById(`kpi-${id}-average`);
    if (average) {
      const tokensPerDay = period.total / fallbackDays;
      average.textContent = fmtCompact(tokensPerDay);
      average.setAttribute('title', `${fmtInt(tokensPerDay)} tokens per day`);
    }
  }

  document.getElementById('kpi-total').textContent = fmtCompact(d.overall.total);
  document.getElementById('kpi-total').setAttribute('title', fmtInt(d.overall.total));
  document.getElementById('kpi-first').textContent = d.overall.first_local.split(' ')[0];

  drawSpark(document.getElementById('spark-24h'),
    daily.slice(-14).map(x => x.total), { fill: true, color: 'var(--c-amber)' });
  drawSpark(document.getElementById('spark-7d'),
    daily.slice(-7).map(x => x.total), { fill: false, color: 'var(--c-reason)' });
  drawSpark(document.getElementById('spark-30d'),
    daily.slice(-30).map(x => x.total), { fill: false, color: 'var(--c-fg-mute)' });

  // stacked mini bar for overall composition
  const overall = d.overall;
  const parts = [
    ['cache_read', overall.cache_read, 'var(--c-cache-read)'],
    ['input',      overall.input,      'var(--c-input)'],
    ['output',     overall.output,     'var(--c-output)'],
    ['cache_write',overall.cache_write,'var(--c-cache-write)'],
  ];
  const sum = parts.reduce((s, p) => s + p[1], 0);
  const stack = document.getElementById('stack-mini');
  stack.innerHTML = '';
  for (const [k, v, c] of parts) {
    const seg = document.createElement('span');
    seg.style.width = (v / sum * 100).toFixed(3) + '%';
    seg.style.background = c;
    seg.title = `${k}: ${fmtInt(v)} (${fmtPct(v/sum)})`;
    stack.appendChild(seg);
  }
}

function drawSpark(svg, values, opts) {
  clear(svg);
  if (!values.length) return;
  const W = 200, H = 40, pad = 2;
  const max = Math.max(...values);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const step = (W - pad * 2) / Math.max(values.length - 1, 1);
  const pts = values.map((v, i) => [
    pad + i * step,
    H - pad - ((v - min) / span) * (H - pad * 2),
  ]);
  const dLine = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
  if (opts.fill) {
    const dArea = dLine + ` L${pts[pts.length-1][0].toFixed(1)},${H-pad} L${pts[0][0].toFixed(1)},${H-pad} Z`;
    svg.appendChild(el('path', { d: dArea, fill: opts.color, opacity: 0.15 }));
  }
  svg.appendChild(el('path', { d: dLine, fill: 'none', stroke: opts.color, 'stroke-width': 1.5 }));
  const last = pts[pts.length - 1];
  svg.appendChild(el('circle', { cx: last[0], cy: last[1], r: 2, fill: opts.color }));
}

/* ---------- controls ---------- */

function wireControls() {
  wireSegment('ctrl-range', v => { state.range = v === 'all' ? 'all' : parseInt(v, 10); renderCharts(); });
  wireSegment('ctrl-metric', v => { state.metric = v; renderMainChart(); renderScatterChart(); });
  wireSegment('ctrl-view', v => { state.view = v; renderMainChart(); });
  document.querySelectorAll('#daily-table thead th').forEach(th => {
    const btn = th.querySelector('.th-btn');
    btn.addEventListener('click', () => {
      const key = th.dataset.key;
      if (state.tableSort.key === key) {
        state.tableSort.dir = state.tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.tableSort.key = key;
        state.tableSort.dir = 'desc';
      }
      renderTable();
    });
  });
}
function wireSegment(id, cb) {
  const group = document.getElementById(id);
  group.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      group.querySelectorAll('button').forEach(b => b.setAttribute('aria-selected', 'false'));
      btn.setAttribute('aria-selected', 'true');
      const v = btn.dataset.range || btn.dataset.metric || btn.dataset.view;
      cb(v);
    });
  });
}

/* ---------- data slicing ---------- */

function slicedDaily() {
  const d = state.data.daily;
  if (state.range === 'all') return d;
  return d.slice(-state.range);
}

function monthlyRows() {
  const buckets = new Map();
  for (const r of state.data.daily) {
    const month = r.day.slice(0, 7);
    if (!buckets.has(month)) {
      buckets.set(month, {
        month, sessions: 0, calls: 0, tool_calls: 0, input: 0, output: 0,
        cache_read: 0, cache_write: 0, reasoning: 0, total: 0, all_in: 0,
      });
    }
    const b = buckets.get(month);
    b.sessions += r.sessions || 0;
    b.calls += r.calls || 0;
    b.tool_calls += r.tool_calls || 0;
    for (const k of ['input','output','cache_read','cache_write','reasoning','total','all_in']) {
      b[k] += r[k] || 0;
    }
  }
  return Array.from(buckets.values()).sort((a, b) => a.month.localeCompare(b.month));
}

function mainRows() {
  if (state.view === 'weekly') return state.data.weekly;
  if (state.view === 'monthly') return monthlyRows();
  return slicedDaily();
}

function rowLabel(r) {
  if (state.view === 'weekly') return r.week_start;
  if (state.view === 'monthly') return r.month;
  return r.day;
}

function formatAxisLabel(label) {
  if (state.view === 'weekly') return fmtShortDate(label);
  if (state.view === 'monthly') return fmtMonth(label);
  return fmtDay(label);
}

function formatTooltipLabel(label) {
  if (state.view === 'monthly') return fmtMonth(label);
  return label;
}

/* ---------- main chart ---------- */

function renderMainChart() {
  const svg = document.getElementById('chart-main');
  clear(svg);
  const rows = mainRows();
  const metric = state.metric;
  const meta = METRICS[metric];
  const viewLabel = state.view === 'weekly' ? 'Weekly' : state.view === 'monthly' ? 'Monthly' : 'Daily';

  document.getElementById('chart-main-sub').textContent = `${viewLabel} · ${meta.label}`;

  const legend = document.getElementById('chart-main-legend');
  if (metric === 'grouped') {
    legend.innerHTML = GROUPED_KEYS.map(k =>
      `<span class="lg-item"><i class="lg-swatch" style="background:${GROUPED_META[k].color}"></i>${GROUPED_META[k].label}</span>`
    ).join('') + `<span class="lg-item" style="color:var(--c-fg-dim)">${rows.length} groups</span>`;
    drawStackedCompositionChart(svg, rows.map(rowLabel), rows, { yLabel: 'tokens' });
    return;
  }

  legend.innerHTML =
    `<span class="lg-item"><i class="lg-swatch" style="background:${meta.color}"></i>${meta.label}</span>` +
    `<span class="lg-item" style="color:var(--c-fg-dim)">${rows.length} points</span>`;

  const values = rows.map(r => metric === 'calls' ? r.calls : r[metric]);
  const labels = rows.map(rowLabel);

  drawBarLineChart(svg, labels, values, {
    color: meta.color,
    kind: 'bar',
    yLabel: metric === 'calls' ? 'calls' : 'tokens',
  });
}

function drawBarLineChart(svg, labels, values, opts) {
  const W = 1200, H = 380;
  const pad = { l: 60, r: 20, t: 24, b: 44 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  const max = Math.max(1, ...values, ...(opts.thresholds || []).map(t => t.value));
  const yTicks = niceTicks(0, max, 5);
  const yMax = yTicks[yTicks.length - 1];

  // grid + y axis
  yTicks.forEach(t => {
    const y = pad.t + ch - (t / yMax) * ch;
    svg.appendChild(el('line', {
      class: 'grid-line', x1: pad.l, y1: y, x2: W - pad.r, y2: y
    }));
    svg.appendChild(el('text', {
      class: 'axis-tick', x: pad.l - 8, y: y + 3, 'text-anchor': 'end'
    })).textContent = fmtCompact(t);
  });

  // baseline
  svg.appendChild(el('line', {
    class: 'axis-line', x1: pad.l, y1: pad.t + ch, x2: W - pad.r, y2: pad.t + ch
  }));

  // bars
  const bw = cw / values.length;
  const barW = Math.max(1, Math.min(bw * 0.72, 38));
  values.forEach((v, i) => {
    const h = (v / yMax) * ch;
    const x = pad.l + i * bw + (bw - barW) / 2;
    const y = pad.t + ch - h;
    const thresholdColor = opts.thresholds?.length
      ? (v >= opts.thresholds[1].value ? 'var(--c-red)' : v >= opts.thresholds[0].value ? 'var(--c-amber)' : opts.color)
      : opts.color;
    const rect = el('rect', {
      class: 'bar',
      x: x.toFixed(2), y: y.toFixed(2),
      width: barW.toFixed(2), height: Math.max(h, 0.5).toFixed(2),
      fill: thresholdColor, rx: 1,
    });
    attachTooltip(rect, () => `${labels[i]}\n${opts.yLabel}: ${fmtInt(v)}`);
    svg.appendChild(rect);
  });

  (opts.thresholds || []).forEach(t => {
    const y = pad.t + ch - (t.value / yMax) * ch;
    svg.appendChild(el('line', { class: 'threshold-line', x1: pad.l, y1: y, x2: W - pad.r, y2: y, stroke: t.color }));
    const label = el('text', { class: 'threshold-label', x: W - pad.r - 4, y: y - 5, 'text-anchor': 'end', fill: t.color });
    label.textContent = t.label;
    svg.appendChild(label);
  });

  // x axis labels — decimated
  const tickEvery = Math.max(1, Math.ceil(values.length / 12));
  labels.forEach((lb, i) => {
    if (i % tickEvery !== 0 && i !== values.length - 1) return;
    const x = pad.l + i * bw + bw / 2;
    svg.appendChild(el('text', {
      class: 'axis-tick', x: x.toFixed(1), y: pad.t + ch + 16, 'text-anchor': 'middle'
    })).textContent = formatAxisLabel(lb);
  });

  // y axis label
  const yLabel = el('text', {
    class: 'axis-label', x: pad.l, y: pad.t - 8, 'text-anchor': 'start'
  });
  yLabel.textContent = opts.yLabel.toUpperCase();
  svg.appendChild(yLabel);
}

function drawStackedCompositionChart(svg, labels, rows, opts) {
  const W = 1200, H = 380;
  const pad = { l: 60, r: 20, t: 24, b: 48 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const series = GROUPED_KEYS;
  const totals = rows.map(r => series.reduce((sum, key) => sum + (r[key] || 0), 0));
  const max = Math.max(1, ...totals);
  const yTicks = niceTicks(0, max, 5);
  const yMax = yTicks[yTicks.length - 1];

  yTicks.forEach(t => {
    const y = pad.t + ch - (t / yMax) * ch;
    svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, y1: y, x2: W - pad.r, y2: y }));
    svg.appendChild(el('text', {
      class: 'axis-tick', x: pad.l - 8, y: y + 3, 'text-anchor': 'end'
    })).textContent = fmtCompact(t);
  });
  svg.appendChild(el('line', {
    class: 'axis-line', x1: pad.l, y1: pad.t + ch, x2: W - pad.r, y2: pad.t + ch
  }));

  const groupW = cw / Math.max(rows.length, 1);
  const barW = Math.max(1, Math.min(groupW * 0.72, 48));
  rows.forEach((r, i) => {
    const x = pad.l + i * groupW + (groupW - barW) / 2;
    let cumulative = 0;
    series.forEach(k => {
      const v = r[k] || 0;
      const h = (v / yMax) * ch;
      const y = pad.t + ch - ((cumulative + v) / yMax) * ch;
      const rect = el('rect', {
        class: 'bar', x: x.toFixed(2), y: y.toFixed(2),
        width: barW.toFixed(2), height: Math.max(h, v ? 0.5 : 0).toFixed(2),
        fill: GROUPED_META[k].color,
      });
      attachTooltip(rect, () => `${formatTooltipLabel(labels[i])}\n${GROUPED_META[k].label}: ${fmtInt(v)}\nComposition total: ${fmtInt(totals[i])}`);
      svg.appendChild(rect);
      cumulative += v;
    });
  });

  const tickEvery = Math.max(1, Math.ceil(rows.length / 12));
  labels.forEach((lb, i) => {
    if (i % tickEvery !== 0 && i !== rows.length - 1) return;
    const x = pad.l + i * groupW + groupW / 2;
    svg.appendChild(el('text', {
      class: 'axis-tick', x: x.toFixed(1), y: pad.t + ch + 18, 'text-anchor': 'middle'
    })).textContent = formatAxisLabel(lb);
  });

  const yLabel = el('text', {
    class: 'axis-label', x: pad.l, y: pad.t - 8, 'text-anchor': 'start'
  });
  yLabel.textContent = opts.yLabel.toUpperCase();
  svg.appendChild(yLabel);
}

function niceTicks(min, max, count) {
  const range = niceNum(max - min, false);
  const step = niceNum(range / (count - 1), true);
  const niceMin = Math.floor(min / step) * step;
  const niceMax = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = niceMin; v <= niceMax + step * 0.5; v += step) ticks.push(v);
  return ticks;
}
function niceNum(range, round) {
  const exp = Math.floor(Math.log10(range));
  const frac = range / Math.pow(10, exp);
  let nice;
  if (round) {
    if (frac < 1.5) nice = 1; else if (frac < 3) nice = 2;
    else if (frac < 7) nice = 5; else nice = 10;
  } else {
    if (frac <= 1) nice = 1; else if (frac <= 2) nice = 2;
    else if (frac <= 5) nice = 5; else nice = 10;
  }
  return nice * Math.pow(10, exp);
}

/* ---------- weekly ---------- */

function renderWeeklyChart() {
  const svg = document.getElementById('chart-weekly');
  clear(svg);
  const rows = state.data.weekly;

  const W = 800, H = 320;
  const pad = { l: 60, r: 16, t: 24, b: 46 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  const values = rows.map(r => r.total);
  const max = Math.max(1, ...values);
  const yTicks = niceTicks(0, max, 4);
  const yMax = yTicks[yTicks.length - 1];

  yTicks.forEach(t => {
    const y = pad.t + ch - (t / yMax) * ch;
    svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, y1: y, x2: W - pad.r, y2: y }));
    svg.appendChild(el('text', {
      class: 'axis-tick', x: pad.l - 8, y: y + 3, 'text-anchor': 'end'
    })).textContent = fmtCompact(t);
  });
  svg.appendChild(el('line', {
    class: 'axis-line', x1: pad.l, y1: pad.t + ch, x2: W - pad.r, y2: pad.t + ch
  }));

  const bw = cw / values.length;
  const barW = Math.min(bw * 0.68, 44);

  values.forEach((v, i) => {
    const h = (v / yMax) * ch;
    const x = pad.l + i * bw + (bw - barW) / 2;
    const y = pad.t + ch - h;
    const isMax = v === max;
    const rect = el('rect', {
      class: 'bar', x: x.toFixed(2), y: y.toFixed(2),
      width: barW.toFixed(2), height: Math.max(h, 0.5).toFixed(2),
      fill: isMax ? 'var(--c-amber)' : 'var(--c-cache-read)',
    });
    attachTooltip(rect, () =>
      `${rows[i].week_start} → ${rows[i].week_end}\nTotal: ${fmtInt(v)}\nCalls: ${fmtInt(rows[i].calls)}`);
    svg.appendChild(rect);

    if (i % 2 === 0 || i === values.length - 1) {
      svg.appendChild(el('text', {
        class: 'axis-tick', x: (x + barW / 2).toFixed(1), y: pad.t + ch + 16, 'text-anchor': 'middle'
      })).textContent = fmtShortDate(rows[i].week_start);
    }
  });

  const yLabel = el('text', {
    class: 'axis-label', x: pad.l, y: pad.t - 8, 'text-anchor': 'start'
  });
  yLabel.textContent = 'TOKENS';
  svg.appendChild(yLabel);
}

/* ---------- scatter ---------- */

function renderScatterChart() {
  const svg = document.getElementById('chart-scatter');
  clear(svg);
  const rows = slicedDaily();

  const W = 800, H = 320;
  const pad = { l: 60, r: 20, t: 24, b: 44 };
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;

  const xs = rows.map(r => r.calls);
  const ys = rows.map(r => r.total);
  const xMax = Math.max(1, ...xs);
  const yMax = Math.max(1, ...ys);
  const xTicks = niceTicks(0, xMax, 5);
  const yTicks = niceTicks(0, yMax, 5);
  const xTop = xTicks[xTicks.length - 1];
  const yTop = yTicks[yTicks.length - 1];

  yTicks.forEach(t => {
    const y = pad.t + ch - (t / yTop) * ch;
    svg.appendChild(el('line', { class: 'grid-line', x1: pad.l, y1: y, x2: W - pad.r, y2: y }));
    svg.appendChild(el('text', {
      class: 'axis-tick', x: pad.l - 8, y: y + 3, 'text-anchor': 'end'
    })).textContent = fmtCompact(t);
  });
  xTicks.forEach(t => {
    const x = pad.l + (t / xTop) * cw;
    svg.appendChild(el('line', {
      class: 'grid-line', x1: x, y1: pad.t, x2: x, y2: pad.t + ch
    }));
    svg.appendChild(el('text', {
      class: 'axis-tick', x: x, y: pad.t + ch + 16, 'text-anchor': 'middle'
    })).textContent = fmtCompact(t);
  });

  svg.appendChild(el('line', {
    class: 'axis-line', x1: pad.l, y1: pad.t + ch, x2: W - pad.r, y2: pad.t + ch
  }));
  svg.appendChild(el('line', {
    class: 'axis-line', x1: pad.l, y1: pad.t, x2: pad.l, y2: pad.t + ch
  }));

  rows.forEach((r, i) => {
    const x = pad.l + (xs[i] / xTop) * cw;
    const y = pad.t + ch - (ys[i] / yTop) * ch;
    const rSize = Math.min(10, 3 + Math.sqrt(r.sessions || 1));
    const dot = el('circle', {
      cx: x.toFixed(1), cy: y.toFixed(1), r: rSize.toFixed(1),
      fill: 'var(--c-amber)', 'fill-opacity': 0.55,
      stroke: 'var(--c-amber)', 'stroke-width': 0.8,
    });
    attachTooltip(dot, () =>
      `${r.day}\nCalls: ${fmtInt(r.calls)}\nTokens: ${fmtInt(r.total)}\nSessions: ${fmtInt(r.sessions)}`);
    svg.appendChild(dot);
  });

  const xLabel = el('text', {
    class: 'axis-label', x: W - pad.r, y: pad.t + ch + 34, 'text-anchor': 'end'
  });
  xLabel.textContent = 'API CALLS';
  svg.appendChild(xLabel);
  const yLabel = el('text', {
    class: 'axis-label', x: pad.l, y: pad.t - 8, 'text-anchor': 'start'
  });
  yLabel.textContent = 'TOTAL TOKENS';
  svg.appendChild(yLabel);
}

/* ---------- analysis panel ---------- */

function renderAnalysis() {
  const o = state.data.overall;
  const daily = state.data.daily;
  const weekly = state.data.weekly;
  const sum = o.input + o.output + o.cache_read + o.cache_write;

  document.getElementById('pct-cache-read').textContent = fmtPct(o.cache_read / sum);
  document.getElementById('pct-input').textContent = fmtPct(o.input / sum);
  document.getElementById('pct-output').textContent = fmtPct(o.output / sum);
  document.getElementById('pct-reason').textContent = fmtPct(o.reasoning / o.all_in);

  const peakDay = daily.slice().sort((a, b) => b.total - a.total)[0];
  document.getElementById('peak-day').textContent = peakDay.day;
  document.getElementById('peak-day-total').textContent = fmtCompact(peakDay.total);

  const peakWeek = weekly.slice().sort((a, b) => b.total - a.total)[0];
  document.getElementById('peak-week').textContent =
    `${fmtShortDate(peakWeek.week_start)}–${fmtShortDate(peakWeek.week_end)}`;
  document.getElementById('peak-week-total').textContent = fmtCompact(peakWeek.total);
  renderProjectAnalysis();
}

function renderProjectAnalysis() {
  const root = document.getElementById('project-list');
  const coverage = document.getElementById('project-coverage');
  const data = state.source.project_usage?.all;
  if (!root || !coverage) return;
  root.innerHTML = '';
  if (!data || !data.projects?.length) {
    root.innerHTML = '<p class="empty-state">No identifiable project metadata is available yet.</p>';
    coverage.textContent = 'Projects require an explicit working directory or conversation display name.';
    return;
  }
  const rows = data.projects.slice(0, 5);
  const max = Math.max(...rows.map(row => row.total), 1);
  const attributed = data.attributed_total || 1;
  rows.forEach((row, index) => {
    const item = document.createElement('div');
    item.className = 'project-row';
    item.setAttribute('role', 'listitem');
    item.setAttribute('aria-label', `${row.name}: ${fmtInt(row.total)} tokens across ${fmtInt(row.sessions)} sessions`);
    const width = Math.max(1.5, row.total / max * 100);
    item.innerHTML = `<span class="project-rank mono">${String(index + 1).padStart(2, '0')}</span><span class="project-name"><strong>${escapeText(row.name)}</strong><small>${fmtInt(row.sessions)} sessions</small></span><span class="project-track"><i style="width:${width.toFixed(1)}%"></i></span><span class="project-total mono">${fmtInt(row.total)}<small>${fmtPct(row.total / attributed)} of attributed</small></span>`;
    root.appendChild(item);
  });
  coverage.innerHTML = `<strong>${fmtPct(data.coverage)}</strong> of all-time tokens have identifiable project metadata. <span class="mono">${fmtCompact(data.unattributed_total)}</span> tokens remain unattributed and are excluded from the ranking.`;
}

/* ---------- table ---------- */

function renderTable() {
  const tbody = document.getElementById('daily-tbody');
  const rows = state.data.daily.slice();
  const { key, dir } = state.tableSort;
  rows.sort((a, b) => {
    const va = a[key], vb = b[key];
    if (va < vb) return dir === 'asc' ? -1 : 1;
    if (va > vb) return dir === 'asc' ? 1 : -1;
    return 0;
  });

  tbody.innerHTML = '';
  const frag = document.createDocumentFragment();
  rows.forEach(r => {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td>${r.day}</td>` +
      `<td class="num">${fmtInt(r.sessions)}</td>` +
      `<td class="num">${fmtInt(r.calls)}</td>` +
      `<td class="num">${fmtInt(r.input)}</td>` +
      `<td class="num">${fmtInt(r.output)}</td>` +
      `<td class="num">${fmtInt(r.cache_read)}</td>` +
      `<td class="num">${fmtInt(r.reasoning)}</td>` +
      `<td class="num" style="color:var(--c-amber)">${fmtInt(r.total)}</td>`;
    frag.appendChild(tr);
  });
  tbody.appendChild(frag);

  // sort indicators
  document.querySelectorAll('#daily-table thead th').forEach(th => {
    if (th.dataset.key === key) {
      th.setAttribute('aria-sort', dir === 'asc' ? 'ascending' : 'descending');
    } else {
      th.removeAttribute('aria-sort');
    }
  });
}

/* ---------- tooltip ---------- */

const tip = document.getElementById('tooltip');
function attachTooltip(node, textFn) {
  node.addEventListener('mouseenter', e => {
    tip.textContent = textFn();
    tip.classList.add('on');
    tip.setAttribute('aria-hidden', 'false');
    moveTip(e);
  });
  node.addEventListener('mousemove', moveTip);
  node.addEventListener('mouseleave', () => {
    tip.classList.remove('on');
    tip.setAttribute('aria-hidden', 'true');
  });
}
function moveTip(e) {
  const pad = 14;
  const w = tip.offsetWidth, h = tip.offsetHeight;
  let x = e.clientX + pad;
  let y = e.clientY + pad;
  if (x + w + 8 > window.innerWidth) x = e.clientX - w - pad;
  if (y + h + 8 > window.innerHeight) y = e.clientY - h - pad;
  tip.style.left = x + 'px';
  tip.style.top = y + 'px';
}


/* ---------- model selection + daily drill-down ---------- */

function normalizeOverall(total) {
  return {
    ...total,
    api_calls: total.api_calls ?? total.calls ?? 0,
    first_local: total.first_local || '',
    last_local: total.last_local || '',
  };
}

function datasetFromSelection(value) {
  const src = state.source;
  if (value === 'all_tracked') {
    const scope = src.scopes.all_tracked;
    return { generated_at_local: src.generated_at_local, timezone: src.timezone, model: scope.model,
      overall: normalizeOverall(scope.overall), daily: scope.daily, weekly: scope.weekly, periods: scope.periods };
  }
  const series = src.series_by_model[value];
  if (!series) return datasetFromSelection('all_tracked');
  return { generated_at_local: src.generated_at_local, timezone: src.timezone,
    model: { provider: series.provider, model: series.model, primary: false },
    overall: normalizeOverall(series.total), daily: series.daily, weekly: series.weekly, periods: series.periods };
}

function setupModelControl() {
  const select = document.getElementById('model-select');
  const all = document.createElement('option');
  all.value = 'all_tracked'; all.textContent = 'All tracked models'; select.appendChild(all);
  state.source.model_totals.forEach(item => {
    const option = document.createElement('option');
    option.value = item.key;
    option.textContent = `${item.provider} / ${item.model} · ${fmtCompact(item.total)}`;
    select.appendChild(option);
  });
  select.value = state.selection;
  state.data = datasetFromSelection(state.selection);
  select.addEventListener('change', () => selectModel(select.value));
}

function selectModel(value) {
  state.selection = value;
  state.data = datasetFromSelection(value);
  const select = document.getElementById('model-select');
  if (select.value !== value) select.value = value;
  const label = value === 'all_tracked' ? 'All tracked models' : `${state.data.model.provider} / ${state.data.model.model}`;
  document.getElementById('model-filter-status').textContent = `Dashboard updated: ${label}`;
  renderAll();
}

function wireModelBreakdownRange() {
  const root = document.getElementById('model-breakdown-range');
  if (!root) return;
  root.querySelectorAll('button[data-model-range]').forEach(button => {
    button.addEventListener('click', () => {
      state.modelRange = button.dataset.modelRange;
      root.querySelectorAll('button[data-model-range]').forEach(item =>
        item.setAttribute('aria-pressed', item === button ? 'true' : 'false'));
      renderModelBreakdown();
    });
  });
}

function modelBreakdownRows() {
  if (state.modelRange === 'all') {
    return state.source.model_totals.map(item => ({ ...item })).sort((a, b) => b.total - a.total);
  }
  const periodKey = state.modelRange === '7' ? 'last_7_days' : 'last_30_days';
  return state.source.model_totals.map(item => {
    const period = state.source.series_by_model[item.key]?.periods?.[periodKey] || {};
    return { ...item, total: period.total || 0, sessions: period.sessions || 0, calls: period.calls || 0 };
  }).filter(item => item.total > 0).sort((a, b) => b.total - a.total);
}

function renderModelBreakdown() {
  const root = document.getElementById('model-breakdown');
  const rows = modelBreakdownRows();
  const max = Math.max(...rows.map(r => r.total), 1);
  const allTotal = rows.reduce((sum, row) => sum + row.total, 0) || 1;
  const rangeLabel = state.modelRange === '7' ? 'Last 7 days' : state.modelRange === '30' ? 'Last 30 days' : 'All time';
  document.getElementById('model-breakdown-sub').textContent = `${rangeLabel} · select a row to isolate it`;
  root.setAttribute('aria-label', `Token usage by provider and model, ${rangeLabel}`);
  root.innerHTML = '';
  if (!rows.length) {
    root.innerHTML = `<p class="empty-state">No model token telemetry in ${rangeLabel.toLowerCase()}.</p>`;
    return;
  }
  rows.forEach((r, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-row${state.selection === r.key ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', state.selection === r.key ? 'true' : 'false');
    button.setAttribute('aria-label', `${r.provider} ${r.model}: ${fmtInt(r.total)} tokens in ${rangeLabel}, ${fmtPct(r.total/allTotal)} of tracked usage`);
    const width = Math.max(1.5, r.total / max * 100);
    button.innerHTML = `<span class="model-rank mono">${String(i+1).padStart(2,'0')}</span><span class="model-name"><strong>${escapeText(r.model)}</strong><small>${escapeText(r.provider)}</small></span><span class="model-track"><i style="width:${width.toFixed(1)}%"></i></span><span class="model-total mono">${fmtCompact(r.total)}<small>${fmtPct(r.total/allTotal)}</small></span>`;
    button.addEventListener('click', () => selectModel(r.key));
    root.appendChild(button);
  });
}

function renderGPT56Versions() {
  const root = document.getElementById('gpt56-versions');
  if (!root) return;
  const rows = state.source.model_totals.filter(r => /^gpt-5\.6(?:[-.]|$)/i.test(r.model));
  root.innerHTML = '';
  if (!rows.length) {
    root.innerHTML = '<p class="empty-state">No GPT-5.6 token telemetry recorded yet. New variants will appear automatically after their first billed session.</p>';
    return;
  }
  const max = Math.max(...rows.map(r => r.total), 1);
  const familyTotal = rows.reduce((sum, r) => sum + (r.total || 0), 0) || 1;
  rows.forEach((r, i) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `model-row${state.selection === r.key ? ' selected' : ''}`;
    button.setAttribute('aria-pressed', state.selection === r.key ? 'true' : 'false');
    button.setAttribute('aria-label', `${r.model}: ${fmtInt(r.total)} tokens across ${fmtInt(r.sessions)} sessions; first seen ${r.first_local || 'unknown'}, last seen ${r.last_local || 'unknown'}`);
    const width = Math.max(1.5, r.total / max * 100);
    const firstSeen = (r.first_local || '—').split(' ')[0];
    const lastSeen = (r.last_local || '—').split(' ')[0];
    button.innerHTML = `<span class="model-rank mono">${String(i+1).padStart(2,'0')}</span><span class="model-name"><strong>${escapeText(r.model)}</strong><small>${fmtInt(r.sessions)} sessions · ${firstSeen} → ${lastSeen}</small></span><span class="model-track"><i style="width:${width.toFixed(1)}%"></i></span><span class="model-total mono">${fmtCompact(r.total)}<small>${fmtPct(r.total/familyTotal)} of GPT-5.6</small></span>`;
    button.addEventListener('click', () => selectModel(r.key));
    root.appendChild(button);
  });
}

function escapeText(value) {
  const span = document.createElement('span'); span.textContent = String(value); return span.innerHTML;
}

function wireDayDialog() {
  const dialog = document.getElementById('day-dialog');
  dialog.querySelector('.dialog-close').addEventListener('click', () => dialog.close());
}

function heatLevel(total, max) {
  const ratio = total / Math.max(max, 1);
  if (ratio >= 0.75) return 'critical';
  if (ratio >= 0.45) return 'warning';
  return ratio >= 0.2 ? 'level-2' : 'level-1';
}

function renderHeatmap() {
  const root=document.getElementById('usage-heatmap'); if(!root||!state.data)return;
  const rows=state.data.daily, max=Math.max(...rows.map(r=>r.total),1); root.innerHTML='';
  rows.forEach(r=>{const b=document.createElement('button');b.type='button';b.className=`heat-day ${heatLevel(r.total,max)}`;b.setAttribute('role','listitem');b.setAttribute('aria-label',`${r.day}: ${fmtInt(r.total)} tokens, ${r.sessions} sessions, ${r.calls} calls`);b.title=`${r.day}\n${fmtInt(r.total)} tokens`;b.innerHTML=`<span>${r.day.slice(5)}</span><small>${fmtCompact(r.total)}</small>`;b.addEventListener('click',()=>openDayDialog(r));root.appendChild(b)});
}

function openDayDialog(r) {
  const dialog=document.getElementById('day-dialog'); document.getElementById('day-dialog-title').textContent=r.day;
  const parts=[['Input',r.input],['Output',r.output],['Cache read',r.cache_read],['Cache write',r.cache_write],['Reasoning',r.reasoning]]; const denom=Math.max(1,r.all_in||r.total);
  const share = r.total / Math.max(...state.data.daily.map(x => x.total), 1);
  const status = share >= .75 ? 'Very high usage day' : share >= .45 ? 'High usage day' : 'Normal usage day';
  document.getElementById('day-dialog-content').innerHTML=`<div class="dialog-body"><p class="risk-${status.startsWith('Normal')?'low':status.startsWith('High')?'medium':'high'}"><strong>${status}</strong> for the selected model view</p><div class="detail-grid">${[['Total',r.total],['Sessions',r.sessions],['API calls',r.calls],['Tool calls',r.tool_calls],['Input',r.input],['Output',r.output],['Cache read',r.cache_read],['Cache write',r.cache_write],['Reasoning',r.reasoning]].map(([k,v])=>`<div><span>${k}</span><strong>${fmtInt(v)}</strong></div>`).join('')}</div><div class="composition-list"><h3>Token composition</h3>${parts.map(([k,v])=>`<div class="composition-line"><span>${k}</span><div class="composition-track"><div class="composition-fill" style="width:${Math.min(100,v/denom*100).toFixed(1)}%"></div></div><strong>${fmtPct(v/denom)}</strong></div>`).join('')}</div></div>`;
  dialog.showModal();
}

boot();
