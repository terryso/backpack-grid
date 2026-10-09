#!/usr/bin/env python3
"""Incremental, account-bound SQLite raw fill store; no growing JSON rewrites."""
import json, os, sqlite3, sys
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
command=sys.argv[1]
if command=='load':
    out={'accountKey':account,'symbols':{}}
    for symbol,body in db.execute('SELECT symbol,body FROM cursors'):
        rec=json.loads(body);rec['fills']={}
        # Recent overlap IDs only; older historical records stay in SQLite.
        for id,raw in db.execute('SELECT id,body FROM fills WHERE symbol=? AND ts>=?',(symbol,max(1790726400000,rec['lastTo']-3600000))):rec['fills'][id]=json.loads(raw)
        out['symbols'][symbol]=rec
    print(json.dumps(out))
elif command=='save':
    state=json.load(sys.stdin)
    if state.get('accountKey')!=account:raise ValueError('history account mismatch')
    with db:
        db.execute("INSERT OR REPLACE INTO meta VALUES('account',?)",(account,))
        for symbol,rec in state['symbols'].items():
            previous_total=db.execute('SELECT body FROM totals WHERE symbol=?',(symbol,)).fetchone()
            total=json.loads(previous_total[0]) if previous_total else {'feeUsd':0,'makerVol':0,'takerVol':0,'makerN':0,'takerN':0,'otherFees':{}}
            for id,f in rec['fills'].items():
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
    symbols={}
    for symbol,raw in db.execute('SELECT symbol,body FROM cursors'):
        r=json.loads(raw);total=json.loads(db.execute('SELECT body FROM totals WHERE symbol=?',(symbol,)).fetchone()[0]);s={**r,**total}
        symbols[symbol]=s
    print(json.dumps({'accountKey':account,'symbols':symbols,'acquiredAt':state['acquiredAt'],'asOf':state['asOf'],'incomplete':state['incomplete'],'source':'sqlite-raw-fill-ledger','auditIncomplete':state.get('auditIncomplete',False)}))
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
    meta={k:db.execute("SELECT value FROM meta WHERE key=?",(k,)).fetchone() for k in ('incomplete','asOf')}
    n,maxts=db.execute('SELECT COUNT(*),MAX(ts) FROM fills').fetchone()
    bounds=[(json.loads(b).get('from'),json.loads(b).get('lastTo')) for (b,) in db.execute('SELECT body FROM cursors')]
    coverage=min((f for f,_ in bounds if isinstance(f,(int,float))),default=None)
    covered=min((t for _,t in bounds if isinstance(t,(int,float))),default=None)
    print(json.dumps({'incomplete':json.loads(meta['incomplete'][0]) if meta['incomplete'] else True,
                      'asOf':json.loads(meta['asOf'][0]) if meta['asOf'] else None,
                      'fillCount':n,'fillsMaxTs':maxts,'coverageFrom':coverage,'coverageTo':covered}))
else:raise ValueError('unknown history store command')
db.close()
