#!/usr/bin/env python3
"""Incremental, account-bound SQLite raw fill store; no growing JSON rewrites."""
import json, math, os, re, sqlite3, sys
ROOT=os.environ.get('BG_ROOT') or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
identity=json.load(open(os.path.join(ROOT,'state/account_identity.json')))
account=identity['accountKey']
db=sqlite3.connect(os.path.join(ROOT,'state/history.sqlite'),timeout=5)
db.executescript('CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT);CREATE TABLE IF NOT EXISTS cursors(symbol TEXT PRIMARY KEY,body TEXT);CREATE TABLE IF NOT EXISTS fills(symbol TEXT,id TEXT,ts INTEGER,body TEXT,PRIMARY KEY(symbol,id));CREATE INDEX IF NOT EXISTS fills_ts ON fills(symbol,ts);CREATE TABLE IF NOT EXISTS totals(symbol TEXT PRIMARY KEY,body TEXT);')
existing=db.execute("SELECT value FROM meta WHERE key='account'").fetchone()
if existing and existing[0]!=account: raise ValueError('history account mismatch')
def timestamp(v):
    if isinstance(v,(int,float)): return int(v)
    from datetime import datetime
    v=v if v.endswith('Z') or '+' in v[10:] or '-' in v[10:] else v+'Z'
    return int(datetime.fromisoformat(v.replace('Z','+00:00')).timestamp()*1000)
def canonical(v):return json.dumps(v,sort_keys=True,separators=(',',':'))
def safe_integer(v):
    return type(v) in (int,float) and abs(v)<=9007199254740991 and math.isfinite(v) and int(v)==v
def row_id(v):
    if isinstance(v,str) and v!='':return v
    if safe_integer(v):return str(int(v))
    raise ValueError('invalid fill id')
def account_number(v):
    if isinstance(v,bool) or not isinstance(v,(int,float,str)):raise ValueError('invalid fill subaccount')
    if isinstance(v,str) and not re.fullmatch(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?',v.strip(),re.I|re.ASCII):raise ValueError('invalid fill subaccount')
    try:n=float(v)
    except (ValueError,OverflowError):raise ValueError('invalid fill subaccount')
    if not safe_integer(n):raise ValueError('invalid fill subaccount')
    return int(n)
command=sys.argv[1]
if command=='load':
    out={'accountKey':account,'symbols':{}}
    for k in ('forwardIncomplete','auditIncomplete'):
        row=db.execute('SELECT value FROM meta WHERE key=?',(k,)).fetchone()
        if row:out[k]=json.loads(row[0])
    for symbol,body in db.execute('SELECT symbol,body FROM cursors'):
        rec=json.loads(body);rec['fills']={}
        # Recent overlap IDs only; older historical records stay in SQLite.
        for id,raw in db.execute('SELECT id,body FROM fills WHERE symbol=? AND ts>=?',(symbol,max(1790726400000,rec['lastTo']-3600000))):rec['fills'][id]=json.loads(raw)
        out['symbols'][symbol]=rec
    print(json.dumps(out))
elif command=='save':
    state=json.load(sys.stdin)
    if state.get('accountKey')!=account:raise ValueError('history account mismatch')
    split_present='forwardIncomplete' in state or 'auditIncomplete' in state
    if split_present and (type(state.get('forwardIncomplete')) is not bool or type(state.get('auditIncomplete')) is not bool
            or type(state.get('incomplete')) is not bool or state['incomplete'] != (state['forwardIncomplete'] or state['auditIncomplete'])):
        raise ValueError('history completeness flags inconsistent')
    if split_present:
        if not isinstance(state.get('symbols'),dict):raise ValueError('history symbols invalid')
        try:as_of=timestamp(state['asOf'])
        except (KeyError,TypeError,ValueError,OverflowError,AttributeError):raise ValueError('history asOf invalid')
        if as_of<1790726400000:raise ValueError('history asOf invalid')
        for rec in state['symbols'].values():
            if not isinstance(rec,dict):raise ValueError('history cursor invalid')
            target=rec.get('auditTarget');cursor=rec.get('auditCursor');pending=rec.get('auditPendingEnd')
            if target is not None:
                if not safe_integer(target) or not safe_integer(cursor) or not 1790726400000<=cursor<=target<=as_of:
                    raise ValueError('audit cursor invalid')
                if pending is not None and (not safe_integer(pending) or not cursor<pending<=min(target,cursor+604800000)):
                    raise ValueError('audit pending window invalid')
            elif cursor is not None or pending is not None:raise ValueError('orphan audit cursor')
            if not state['forwardIncomplete'] and rec.get('incomplete') is not False:
                raise ValueError('forward completeness contradicts cursor')
            audited=rec.get('auditedThrough')
            try:
                if isinstance(audited,bool) or not isinstance(audited,(int,float,str)) or not str(audited).strip():raise ValueError()
                if isinstance(audited,str) and not re.fullmatch(r'[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?',audited.strip(),re.I|re.ASCII):raise ValueError()
                audited=float(audited)
                if not math.isfinite(audited):raise ValueError()
            except (ValueError,OverflowError):audited=None
            due=rec.get('auditTarget') is not None or bool(rec.get('auditError')) or audited is None or audited<1790726400000 or audited>as_of or as_of-audited>=86400000
            if not state['auditIncomplete'] and due:raise ValueError('audit completeness contradicts cursor')
    with db:
        db.execute("INSERT OR REPLACE INTO meta VALUES('account',?)",(account,))
        for symbol,rec in state['symbols'].items():
            previous_total=db.execute('SELECT body FROM totals WHERE symbol=?',(symbol,)).fetchone()
            total=json.loads(previous_total[0]) if previous_total else {'feeUsd':0,'makerVol':0,'takerVol':0,'makerN':0,'takerN':0,'otherFees':{}}
            for id,f in rec['fills'].items():
                if not isinstance(f,dict) or f.get('symbol')!=symbol or row_id(f.get('id') if f.get('id') is not None else f.get('tradeId'))!=id:
                    raise ValueError('fill market or id mismatch')
                if 'userId' in f:
                    uid=f['userId'];uid_text=uid if isinstance(uid,str) and uid.strip() else str(int(uid)) if safe_integer(uid) else None
                    if uid_text!=identity.get('userId'):raise ValueError('fill user mismatch')
                if 'subaccountId' in f and account_number(f['subaccountId'])!=identity.get('subaccountId'):
                    raise ValueError('fill subaccount mismatch')
                body=canonical(f);old=db.execute('SELECT body FROM fills WHERE symbol=? AND id=?',(symbol,id)).fetchone()
                if old and old[0]!=body:raise ValueError('immutable fill conflict')
                if not old:
                    db.execute('INSERT INTO fills VALUES(?,?,?,?)',(symbol,id,timestamp(f['timestamp']),body))
                    kind='maker' if f['isMaker'] else 'taker';total[kind+'Vol']+=float(f['price'])*float(f['quantity']);total[kind+'N']+=1
                    fee=float(f['fee'])
                    if f['feeSymbol']=='USDC':total['feeUsd']+=fee
                    else:total['otherFees'][f['feeSymbol']]=total['otherFees'].get(f['feeSymbol'],0)+fee
            db.execute('INSERT OR REPLACE INTO totals VALUES(?,?)',(symbol,canonical(total)))
            db.execute('INSERT OR REPLACE INTO cursors VALUES(?,?)',(symbol,canonical({k:v for k,v in rec.items() if k!='fills'})))
        for k in ('acquiredAt','asOf','incomplete'):db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',(k,canonical(state.get(k))))
        for k in ('forwardIncomplete','auditIncomplete'):
            if split_present:db.execute('INSERT OR REPLACE INTO meta VALUES(?,?)',(k,canonical(state[k])))
            else:db.execute('DELETE FROM meta WHERE key=?',(k,))
    symbols={}
    for symbol,raw in db.execute('SELECT symbol,body FROM cursors'):
        r=json.loads(raw);total=json.loads(db.execute('SELECT body FROM totals WHERE symbol=?',(symbol,)).fetchone()[0]);s={**r,**total}
        symbols[symbol]=s
    print(json.dumps({'accountKey':account,'symbols':symbols,'acquiredAt':state['acquiredAt'],'asOf':state['asOf'],'incomplete':state['incomplete'],'source':'sqlite-raw-fill-ledger','forwardIncomplete':state.get('forwardIncomplete'),'auditIncomplete':state.get('auditIncomplete')}))
elif command=='fills':
    # Read-only export for the operations-history page; newest first, capped.
    limit=max(1,min(int(sys.argv[2]) if len(sys.argv)>2 else 5000,20000))
    rows=db.execute('SELECT body FROM fills ORDER BY ts DESC LIMIT ?',(limit,)).fetchall()
    print(json.dumps([json.loads(b) for (b,) in rows]))
elif command=='status':
    # Coverage snapshot for the operations-history page (read-only): audit flags from the
    # last save plus the ground truth from the fills table itself (count + newest ts).
    # coverageFrom/To = per-symbol window bounds — account-bound facts from the cursors.
    # coverageTo is the LAGGARD symbol's cursor: aggregate coverage ends where the
    # slowest symbol ends (max would let one fast symbol mask a stalled one). It
    # advances to asOf on every successful collection regardless of trade activity, so
    # it is the collection freshness signal, not the last-fill time.
    meta={k:db.execute("SELECT value FROM meta WHERE key=?",(k,)).fetchone() for k in ('incomplete','asOf','forwardIncomplete','auditIncomplete')}
    def flag(k):
        if not meta[k]:return None
        value=json.loads(meta[k][0])
        return value if type(value) is bool else None
    incomplete=flag('incomplete')
    forward=flag('forwardIncomplete')
    audit=flag('auditIncomplete')
    if incomplete is None:incomplete=True
    if forward is not None and audit is not None and incomplete != (forward or audit):
        incomplete=True
        forward=None
        audit=None
    n,maxts=db.execute('SELECT COUNT(*),MAX(ts) FROM fills').fetchone()
    bounds=[(json.loads(b).get('from'),json.loads(b).get('lastTo')) for (b,) in db.execute('SELECT body FROM cursors')]
    coverage=min((f for f,_ in bounds if isinstance(f,(int,float))),default=None)
    covered=min((t for _,t in bounds if isinstance(t,(int,float))),default=None)
    print(json.dumps({'incomplete':incomplete,'forwardIncomplete':forward,'auditIncomplete':audit,
                      'asOf':json.loads(meta['asOf'][0]) if meta['asOf'] else None,
                      'fillCount':n,'fillsMaxTs':maxts,'coverageFrom':coverage,'coverageTo':covered}))
else:raise ValueError('unknown history store command')
db.close()
