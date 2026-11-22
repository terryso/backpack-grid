#!/usr/bin/env python3
"""Serialize manual direction changes and cloud compare-and-apply on one lock."""
import datetime
import fcntl
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import uuid

root = pathlib.Path(os.environ['BG_ROOT'])
state = root / 'state'
file = state / 'direction_override.json'
request = json.load(sys.stdin)
key = request['accountKey']
valid = ('Long', 'Short', 'Neutral')

with (state / 'direction_override.lock').open('a+') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        raw = file.read_bytes()
        reg = json.loads(raw)
    except FileNotFoundError:
        raw, reg = None, None
    except (ValueError, UnicodeDecodeError):
        raw, reg = b'invalid', None
    version = hashlib.sha256(key.encode() + b'\0' + (raw if raw is not None else b'<missing>')).hexdigest()
    good = isinstance(reg, dict) and reg.get('schemaVersion') == 1 and reg.get('accountKey') == key and isinstance(reg.get('directions'), dict)
    if request['op'] in ('cloud', 'local') and raw is not None and not good:
        raise ValueError('direction state invalid or foreign')
    if not good:
        reg = {'schemaVersion': 1, 'accountKey': key, 'directions': {}}
    directions = reg['directions']
    if request['op'] == 'manual':
        market, direction = request['market'], request['direction']
        if not isinstance(market, str) or not market or direction not in valid:
            raise ValueError('invalid direction or market')
        # Neutral clears a market override, preserving the existing CLI contract.
        if direction == 'Neutral': directions.pop(market, None)
        else: directions[market] = direction
        outcome = {'status': 'manual'}
    elif request['op'] in ('cloud', 'local'):
        event = request['event']
        if not isinstance(event, dict) or not isinstance(event.get('id'), str) or not event['id'] or event.get('from') not in valid or event.get('to') not in valid or event['from'] == event['to'] or not isinstance(event.get('version'), str) or not isinstance(event.get('at'), str):
            raise ValueError('invalid event')
        try:
            created = datetime.datetime.fromisoformat(event['at'].replace('Z', '+00:00'))
            age = (datetime.datetime.now(datetime.timezone.utc) - created).total_seconds()
        except (ValueError, TypeError):
            raise ValueError('invalid event time')
        previous = reg.get('lastCloudEvent')
        if request['op'] == 'cloud' and isinstance(previous, dict) and previous.get('id') == event['id']:
            print(json.dumps(previous)); sys.exit(0)
        current = directions.get('*', 'Neutral')
        if not isinstance(current, str) or current not in valid:
            raise ValueError('invalid global direction')
        status = 'expired' if age < 0 or age > 7200 else 'conflict' if version != event['version'] or current != event['from'] else 'applied'
        if status == 'applied':
            if event['to'] == 'Neutral': directions.pop('*', None)
            else: directions['*'] = event['to']
        outcome = {'id': event['id'], 'status': status}
        if request['op'] == 'cloud':
            reg['lastCloudEvent'] = outcome
        elif status != 'applied':
            # A local rejection must not overwrite the cloud acknowledgment or
            # mutate the revision that another process is comparing.
            print(json.dumps(outcome)); sys.exit(0)
    else:
        raise ValueError('invalid operation')
    reg['revision'] = str(uuid.uuid4())
    if request['op'] == 'manual' and 'at' in request:
        manual_at = datetime.datetime.fromisoformat(request['at'].replace('Z', '+00:00'))
        if manual_at.tzinfo is None: raise ValueError('invalid manual time')
        reg['updatedAt'] = request['at']
    else:
        reg['updatedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
    fd, tmp = tempfile.mkstemp(prefix='.direction-', dir=state)
    try:
        with os.fdopen(fd, 'w') as out:
            json.dump(reg, out, ensure_ascii=False, indent=2)
            out.flush()
            os.fsync(out.fileno())
        os.replace(tmp, file)
        directory_fd = os.open(state, os.O_RDONLY)
        try: os.fsync(directory_fd)
        finally: os.close(directory_fd)
    finally:
        if os.path.exists(tmp): os.unlink(tmp)
    print(json.dumps(outcome))
