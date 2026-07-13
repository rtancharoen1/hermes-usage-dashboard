#!/usr/bin/env python3
import sqlite3, json, os, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

DB = os.path.expanduser('~/.hermes/state.db')
OUT = Path('/Users/lexx/hermes-workspace/hermes-usage-dashboard/usage-data.json')
TZ = ZoneInfo('Asia/Bangkok')
TOKEN_COLS = ['input','output','cache_read','cache_write','reasoning','total','all_in']

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

def local_dt(ts):
    return datetime.datetime.fromtimestamp(float(ts), TZ)

def empty_bucket(label_key, label):
    return {label_key: label, 'sessions':0, 'calls':0, 'tool_calls':0,
            'input':0, 'output':0, 'cache_read':0, 'cache_write':0,
            'reasoning':0, 'total':0, 'all_in':0}

def add_row(b, r):
    b['sessions'] += r['sessions'] or 0
    b['calls'] += r['calls'] or 0
    b['tool_calls'] += r['tool_calls'] or 0
    for k in ['input','output','cache_read','cache_write','reasoning','total','all_in']:
        b[k] += r[k] or 0

def where_clause(scope):
    if scope == 'codex':
        return "billing_provider='openai-codex' AND model='gpt-5.5'"
    if scope == 'all_tracked':
        return "(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0"
    raise ValueError(scope)

def fetch_overall(scope):
    where=where_clause(scope)
    row=conn.execute(f"""
      SELECT count(*) sessions, min(started_at) mn, max(started_at) mx,
             sum(api_call_count) calls, sum(tool_call_count) tool_calls,
             sum(input_tokens) input, sum(output_tokens) output,
             sum(cache_read_tokens) cache_read, sum(cache_write_tokens) cache_write,
             sum(reasoning_tokens) reasoning,
             sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total,
             sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) all_in
      FROM sessions WHERE {where}
    """).fetchone()
    return {
      'sessions': row['sessions'] or 0,
      'first_local': local_dt(row['mn']).strftime('%Y-%m-%d %H:%M:%S') if row['mn'] else None,
      'last_local': local_dt(row['mx']).strftime('%Y-%m-%d %H:%M:%S') if row['mx'] else None,
      'api_calls': row['calls'] or 0,
      'tool_calls': row['tool_calls'] or 0,
      'input': row['input'] or 0,
      'output': row['output'] or 0,
      'cache_read': row['cache_read'] or 0,
      'cache_write': row['cache_write'] or 0,
      'reasoning': row['reasoning'] or 0,
      'total': row['total'] or 0,
      'all_in': row['all_in'] or 0,
    }

def fetch_daily(scope):
    where=where_clause(scope)
    rows=conn.execute(f"""
      SELECT date(started_at,'unixepoch','+7 hours') day,
             count(*) sessions, sum(api_call_count) calls, sum(tool_call_count) tool_calls,
             sum(input_tokens) input, sum(output_tokens) output,
             sum(cache_read_tokens) cache_read, sum(cache_write_tokens) cache_write,
             sum(reasoning_tokens) reasoning,
             sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total,
             sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) all_in
      FROM sessions WHERE {where}
      GROUP BY 1 ORDER BY 1
    """).fetchall()
    return [dict(r) for r in rows]

def fetch_periods_where(where):
    """Return exact rolling-window aggregates, anchored to generation time."""
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    periods = {}
    for key, hours in [('last_24_hours', 24), ('last_7_days', 24 * 7), ('last_30_days', 24 * 30)]:
        cutoff = now - (hours * 3600)
        row = conn.execute(f"""
          SELECT count(*) sessions, sum(api_call_count) calls, sum(tool_call_count) tool_calls,
                 sum(input_tokens) input, sum(output_tokens) output,
                 sum(cache_read_tokens) cache_read, sum(cache_write_tokens) cache_write,
                 sum(reasoning_tokens) reasoning,
                 sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total,
                 sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) all_in
          FROM sessions WHERE {where} AND started_at >= ? AND started_at <= ?
        """, (cutoff, now)).fetchone()
        bucket = empty_bucket('period', key)
        bucket.pop('period')
        bucket.update({k: row[k] or 0 for k in row.keys()})
        bucket['start_local'] = local_dt(cutoff).isoformat(timespec='seconds')
        bucket['end_local'] = local_dt(now).isoformat(timespec='seconds')
        periods[key] = bucket
    return periods

def fetch_periods(scope):
    return fetch_periods_where(where_clause(scope))

def project_name(cwd, display_name):
    """Return a public-safe project label from explicit session metadata."""
    if cwd:
        normalized = os.path.normpath(cwd)
        workspace_prefix = '/Users/lexx/hermes-workspace/'
        if normalized.startswith(workspace_prefix):
            return normalized[len(workspace_prefix):].split(os.sep, 1)[0]
        if normalized.startswith('/Users/lexx/Documents/Obsidian Vault'):
            return 'Obsidian Vault'
        if normalized.startswith('/Users/lexx/.hermes/hermes-agent'):
            return 'Hermes Agent'
        if normalized == '/Users/lexx':
            return 'Home workspace'
        return os.path.basename(normalized) or 'Unattributed'
    if display_name:
        parts = [part.strip() for part in display_name.split('/')]
        if len(parts) >= 2 and parts[1].startswith('#'):
            return parts[1].lstrip('#').strip() or 'Unattributed'
        return display_name.strip()
    return 'Unattributed'

def fetch_project_usage():
    rows = conn.execute("""
      SELECT started_at, cwd, display_name,
             input_tokens+output_tokens+cache_read_tokens+cache_write_tokens total
      FROM sessions
      WHERE (input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) > 0
    """).fetchall()
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    specs = [('all', None), ('last_7_days', now - 7 * 86400), ('last_30_days', now - 30 * 86400)]
    result = {}
    for key, cutoff in specs:
        buckets = {}
        for row in rows:
            if cutoff is not None and row['started_at'] < cutoff:
                continue
            name = project_name(row['cwd'], row['display_name'])
            bucket = buckets.setdefault(name, {'name': name, 'sessions': 0, 'total': 0})
            bucket['sessions'] += 1
            bucket['total'] += row['total'] or 0
        unattributed = buckets.pop('Unattributed', {'sessions': 0, 'total': 0})
        projects = sorted(buckets.values(), key=lambda item: item['total'], reverse=True)
        attributed_total = sum(item['total'] for item in projects)
        total = attributed_total + unattributed['total']
        result[key] = {
          'projects': projects,
          'attributed_total': attributed_total,
          'unattributed_total': unattributed['total'],
          'unattributed_sessions': unattributed['sessions'],
          'total': total,
          'coverage': attributed_total / total if total else 0,
        }
    return result

def weekly_from_daily(daily):
    buckets={}
    for r in daily:
        d=datetime.date.fromisoformat(r['day'])
        start=d-datetime.timedelta(days=d.weekday())
        end=start+datetime.timedelta(days=6)
        key=start.isoformat()
        b=buckets.setdefault(key, empty_bucket('week_start', key))
        b['week_end']=end.isoformat()
        add_row(b,r)
    return [buckets[k] for k in sorted(buckets)]

def model_key(provider, model):
    return f'{provider} / {model}'

model_rows=conn.execute("""
  SELECT coalesce(billing_provider,'(none)') provider, coalesce(model,'(none)') model,
         count(*) sessions, sum(api_call_count) calls, sum(tool_call_count) tool_calls,
         sum(input_tokens) input, sum(output_tokens) output,
         sum(cache_read_tokens) cache_read, sum(cache_write_tokens) cache_write,
         sum(reasoning_tokens) reasoning,
         sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total,
         sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) all_in,
         min(started_at) mn, max(started_at) mx
  FROM sessions GROUP BY 1,2 ORDER BY total DESC
""").fetchall()
model_totals=[]
metadata_only=[]
for r in model_rows:
    item={k:r[k] for k in r.keys() if k not in ('mn','mx')}
    item['key']=model_key(item['provider'], item['model'])
    item['first_local']=local_dt(r['mn']).strftime('%Y-%m-%d %H:%M:%S') if r['mn'] else None
    item['last_local']=local_dt(r['mx']).strftime('%Y-%m-%d %H:%M:%S') if r['mx'] else None
    if (item['total'] or 0)>0:
        model_totals.append(item)
    else:
        metadata_only.append(item)

# daily by model for nonzero telemetry models
series_by_model={}
for item in model_totals:
    provider=item['provider'].replace("'","''")
    model=item['model'].replace("'","''")
    rows=conn.execute(f"""
      SELECT date(started_at,'unixepoch','+7 hours') day,
             count(*) sessions, sum(api_call_count) calls, sum(tool_call_count) tool_calls,
             sum(input_tokens) input, sum(output_tokens) output,
             sum(cache_read_tokens) cache_read, sum(cache_write_tokens) cache_write,
             sum(reasoning_tokens) reasoning,
             sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total,
             sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) all_in
      FROM sessions
      WHERE coalesce(billing_provider,'(none)')='{provider}' AND coalesce(model,'(none)')='{model}'
        AND (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0
      GROUP BY 1 ORDER BY 1
    """).fetchall()
    key=item['key']
    daily=[dict(r) for r in rows]
    model_where = (
        f"coalesce(billing_provider,'(none)')='{provider}' "
        f"AND coalesce(model,'(none)')='{model}' "
        "AND (input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) > 0"
    )
    series_by_model[key]={
      'provider':item['provider'],'model':item['model'],'daily':daily,
      'weekly':weekly_from_daily(daily),'periods':fetch_periods_where(model_where),'total':item
    }

codex_daily=fetch_daily('codex')
all_daily=fetch_daily('all_tracked')
scopes={
  'codex': {
    'label':'Codex quota focus',
    'description':'openai-codex / gpt-5.5 only. Primary quota-pressure view.',
    'model': {'provider':'openai-codex','model':'gpt-5.5','primary':True},
    'overall': fetch_overall('codex'),
    'daily': codex_daily,
    'weekly': weekly_from_daily(codex_daily),
    'periods': fetch_periods('codex'),
  },
  'all_tracked': {
    'label':'All tracked models',
    'description':'Aggregates sessions with nonzero token telemetry across providers/models.',
    'model': {'provider':'all','model':'token telemetry','primary':False},
    'overall': fetch_overall('all_tracked'),
    'daily': all_daily,
    'weekly': weekly_from_daily(all_daily),
    'periods': fetch_periods('all_tracked'),
  }
}

data={
  'generated_at_local': datetime.datetime.now(TZ).isoformat(),
  'timezone':'Asia/Bangkok',
  'model': scopes['codex']['model'],
  'overall': scopes['codex']['overall'],
  'daily': scopes['codex']['daily'],
  'weekly': scopes['codex']['weekly'],
  'scopes': scopes,
  'model_totals': model_totals,
  'series_by_model': series_by_model,
  'project_usage': fetch_project_usage(),
  'metadata_only_models': metadata_only,
  'notes': {
    'quota_remaining':'Not exposed by local state.db',
    'metadata_only':'Rows with model metadata but zero token telemetry are excluded from token totals.',
    'last_known_429':'2026-07-05 usage_limit_reached, reset around 19:01 +07',
  }
}
OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2))
print(OUT)
print('codex_days',len(scopes['codex']['daily']),'all_days',len(scopes['all_tracked']['daily']),'models',len(model_totals),'metadata_only',len(metadata_only))
