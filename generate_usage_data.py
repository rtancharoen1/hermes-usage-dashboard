#!/usr/bin/env python3
import sqlite3, json, os, datetime, hashlib, re
from pathlib import Path
from zoneinfo import ZoneInfo

DB = os.path.expanduser('~/.hermes/state.db')
OUT = Path('/Users/lexx/hermes-workspace/hermes-usage-dashboard/usage-data.json')
RUNTIME_DB = OUT.parent / '.runtime' / 'realtime-telemetry.sqlite3'
LOG_DIR = Path.home() / '.hermes' / 'logs'
TZ = ZoneInfo('Asia/Bangkok')
TOKEN_COLS = ['input','output','cache_read','cache_write','reasoning','total','all_in']

API_CALL_RE = re.compile(
    r'^(?P<time>\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}),\d+ '
    r'.*?\[(?P<session>[^]]+)\].*?API call #(?P<call>\d+): '
    r'model=(?P<model>\S+) provider=(?P<provider>\S+) '
    r'in=(?P<input>\d+) out=(?P<output>\d+) total=(?P<total>\d+)'
)

RANGE_SPECS = {
    '10m': (10 * 60, 30),
    '1h': (60 * 60, 60),
    '12h': (12 * 60 * 60, 15 * 60),
    '24h': (24 * 60 * 60, 30 * 60),
    '7d': (7 * 24 * 60 * 60, 6 * 60 * 60),
    '30d': (30 * 24 * 60 * 60, 24 * 60 * 60),
}

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

def ingest_api_call_logs():
    """Persist call-level aggregate telemetry locally so log rotation cannot erase it."""
    RUNTIME_DB.parent.mkdir(parents=True, exist_ok=True)
    rt = sqlite3.connect(RUNTIME_DB)
    rt.row_factory = sqlite3.Row
    rt.execute('PRAGMA journal_mode=WAL')
    rt.execute('''
      CREATE TABLE IF NOT EXISTS api_calls (
        event_key TEXT PRIMARY KEY,
        timestamp REAL NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input INTEGER NOT NULL,
        output INTEGER NOT NULL,
        cache_read INTEGER NOT NULL,
        cache_write INTEGER NOT NULL DEFAULT 0,
        reasoning INTEGER NOT NULL DEFAULT 0,
        total INTEGER NOT NULL
      )
    ''')
    inserted = 0
    for log_path in sorted(LOG_DIR.glob('agent.log*')):
        if not log_path.is_file():
            continue
        for line in log_path.read_text(errors='replace').splitlines():
            if 'API call #' not in line:
                continue
            match = API_CALL_RE.search(line)
            if not match:
                continue
            cache_match = re.search(r'cache=(\d+)/(\d+)', line)
            cache_read = int(cache_match.group(1)) if cache_match else 0
            logical_input = int(match.group('input'))
            output = int(match.group('output'))
            timestamp = datetime.datetime.strptime(
                match.group('time'), '%Y-%m-%d %H:%M:%S'
            ).replace(tzinfo=TZ).timestamp()
            identity = '|'.join((
                match.group('time'), match.group('session'), match.group('call'),
                match.group('provider'), match.group('model'),
                match.group('input'), match.group('output'),
            ))
            event_key = hashlib.sha256(identity.encode()).hexdigest()
            cursor = rt.execute('''
              INSERT OR IGNORE INTO api_calls
              (event_key,timestamp,provider,model,input,output,cache_read,total)
              VALUES (?,?,?,?,?,?,?,?)
            ''', (
                event_key, timestamp, match.group('provider'), match.group('model'),
                max(0, logical_input - cache_read), output, cache_read,
                logical_input + output,
            ))
            inserted += cursor.rowcount
    # Keep a safety margin beyond the longest public window.
    rt.execute('DELETE FROM api_calls WHERE timestamp < ?', (
        datetime.datetime.now(datetime.timezone.utc).timestamp() - 35 * 86400,
    ))
    rt.commit()
    return rt, inserted

def realtime_scope(rt, now, where_sql='', params=()):
    clause = f' AND {where_sql}' if where_sql else ''
    first = rt.execute(
        f'SELECT min(timestamp) FROM api_calls WHERE 1=1{clause}', params
    ).fetchone()[0]
    windows = {}
    series = {}
    for key, (duration, bucket_seconds) in RANGE_SPECS.items():
        cutoff = now - duration
        row = rt.execute(f'''
          SELECT count(*) calls,
                 coalesce(sum(input),0) input,
                 coalesce(sum(output),0) output,
                 coalesce(sum(cache_read),0) cache_read,
                 coalesce(sum(cache_write),0) cache_write,
                 coalesce(sum(reasoning),0) reasoning,
                 coalesce(sum(total),0) total
          FROM api_calls
          WHERE timestamp >= ? AND timestamp <= ?{clause}
        ''', (cutoff, now, *params)).fetchone()
        window = dict(row)
        window.update({
            'start_local': local_dt(cutoff).isoformat(timespec='seconds'),
            'end_local': local_dt(now).isoformat(timespec='seconds'),
            'coverage_start_local': local_dt(first).isoformat(timespec='seconds') if first else None,
            'complete': bool(first is not None and first <= cutoff),
            'source': 'agent.log call telemetry',
        })
        window['all_in'] = window['total'] + window['reasoning']
        windows[key] = window

        raw = rt.execute(f'''
          SELECT cast(timestamp / ? as integer) * ? bucket,
                 count(*) calls, sum(input) input, sum(output) output,
                 sum(cache_read) cache_read, sum(cache_write) cache_write,
                 sum(reasoning) reasoning, sum(total) total
          FROM api_calls
          WHERE timestamp >= ? AND timestamp <= ?{clause}
          GROUP BY bucket ORDER BY bucket
        ''', (bucket_seconds, bucket_seconds, cutoff, now, *params)).fetchall()
        by_bucket = {int(r['bucket']): dict(r) for r in raw}
        start_bucket = int(cutoff // bucket_seconds) * bucket_seconds
        end_bucket = int(now // bucket_seconds) * bucket_seconds
        points = []
        for bucket in range(start_bucket, end_bucket + 1, bucket_seconds):
            point = by_bucket.get(bucket, {
                'bucket': bucket, 'calls': 0, 'input': 0, 'output': 0,
                'cache_read': 0, 'cache_write': 0, 'reasoning': 0, 'total': 0,
            })
            point['all_in'] = point['total'] + point['reasoning']
            point['bucket_start'] = local_dt(bucket).isoformat(timespec='seconds')
            points.append(point)
        series[key] = {
            'bucket_seconds': bucket_seconds,
            'complete': window['complete'],
            'points': points,
        }
    return {'windows': windows, 'series': series}

rt_conn, realtime_inserted = ingest_api_call_logs()

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

def fetch_rolling_daily_where(where):
    now = datetime.datetime.now(datetime.timezone.utc).timestamp()
    result = {}
    for key, days in [('7d', 7), ('30d', 30)]:
        rows = conn.execute(f'''
          SELECT date(started_at,'unixepoch','+7 hours') day,
                 count(*) sessions, sum(api_call_count) calls, sum(tool_call_count) tool_calls,
                 sum(input_tokens) input, sum(output_tokens) output,
                 sum(cache_read_tokens) cache_read, sum(cache_write_tokens) cache_write,
                 sum(reasoning_tokens) reasoning,
                 sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens) total,
                 sum(input_tokens+output_tokens+cache_read_tokens+cache_write_tokens+reasoning_tokens) all_in
          FROM sessions
          WHERE {where} AND started_at >= ? AND started_at <= ?
          GROUP BY 1 ORDER BY 1
        ''', (now - days * 86400, now)).fetchall()
        result[key] = [dict(row) for row in rows]
    return result

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
      'weekly':weekly_from_daily(daily),'periods':fetch_periods_where(model_where),
      'rolling_daily':fetch_rolling_daily_where(model_where),'total':item
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
    'rolling_daily': fetch_rolling_daily_where(where_clause('codex')),
  },
  'all_tracked': {
    'label':'All tracked models',
    'description':'Aggregates sessions with nonzero token telemetry across providers/models.',
    'model': {'provider':'all','model':'token telemetry','primary':False},
    'overall': fetch_overall('all_tracked'),
    'daily': all_daily,
    'weekly': weekly_from_daily(all_daily),
    'periods': fetch_periods('all_tracked'),
    'rolling_daily': fetch_rolling_daily_where(where_clause('all_tracked')),
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
  'realtime': {
    'refresh_minutes': 30,
    'archive_private': True,
    'ingested_this_run': realtime_inserted,
    'scopes': {},
  },
  'notes': {
    'quota_remaining':'Not exposed by local state.db',
    'metadata_only':'Rows with model metadata but zero token telemetry are excluded from token totals.',
    'last_known_429':'2026-07-05 usage_limit_reached, reset around 19:01 +07',
  }
}

now_ts = datetime.datetime.now(datetime.timezone.utc).timestamp()
data['realtime']['scopes']['all_tracked'] = realtime_scope(rt_conn, now_ts)
for item in model_totals:
    realtime_model = realtime_scope(
        rt_conn, now_ts,
        'provider = ? AND model = ?',
        (item['provider'], item['model']),
    )
    if realtime_model['windows']['30d']['calls']:
        data['realtime']['scopes'][item['key']] = realtime_model
rt_conn.close()
OUT.write_text(json.dumps(data,ensure_ascii=False,indent=2))
print(OUT)
print('codex_days',len(scopes['codex']['daily']),'all_days',len(scopes['all_tracked']['daily']),'models',len(model_totals),'metadata_only',len(metadata_only))
