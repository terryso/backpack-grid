#!/usr/bin/env python3
"""Only risk.json writer. Bounded kernel-flock transaction; peak only rises,
existing latch is never cleared. Manual recovery may omit paused.
Optional assessment is evaluated using the latest peak INSIDE the transaction.
"""
import fcntl
import json
import math
import os
import re
import sys
import tempfile
import time

ROOT = os.environ.get("BG_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, "state", "risk.json")


def number(v):
    if isinstance(v, bool) or not isinstance(v, (int, float, str)) or (isinstance(v, str) and not re.fullmatch(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?", v.strip(), re.I | re.ASCII)):
        raise ValueError("invalid numeric type")
    n = float(v)
    if not math.isfinite(n):
        raise ValueError("non-finite number")
    return n


def shape_ok(v):
    try:
        return isinstance(v, dict) and number(v.get("peakEquity")) >= 0 and (v.get("paused") is None or isinstance(v.get("paused"), dict))
    except ValueError:
        return False


def main():
    arg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    if not isinstance(arg, dict):
        raise ValueError("payload must be an object")
    if "peakEquity" in arg and number(arg["peakEquity"]) < 0:
        raise ValueError("negative peak")
    if "paused" in arg and not isinstance(arg["paused"], dict):
        raise ValueError("latch cannot be cleared through the writer")
    assessment = arg.get("assessment")
    if assessment is not None:
        if not isinstance(assessment, dict):
            raise ValueError("invalid assessment")
        eq, budget = number(assessment.get("equity")), number(assessment.get("budgetPct"))
        if not 0 < budget <= 100 or not isinstance(assessment.get("at"), str):
            raise ValueError("invalid assessment values")
    os.makedirs(os.path.dirname(P), exist_ok=True)
    with open(os.path.join(ROOT, "state", "risk.lock"), "a+") as lock:
        deadline = time.monotonic() + 5
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise TimeoutError("risk lock acquisition timed out")
                time.sleep(0.05)
        if os.path.exists(P):
            with open(P, encoding="utf8") as f:
                latest = json.load(f)
            if not shape_ok(latest):
                raise ValueError("RISK_WRITE_REFUSED_INVALID_SHAPE")
        else:
            latest = {"peakEquity": 0, "paused": None}
        before = json.dumps(latest, sort_keys=True)
        identity_path = os.path.join(ROOT, "state", "account_identity.json")
        if os.path.exists(identity_path):
            with open(identity_path, encoding="utf8") as f:
                identity = json.load(f)
            if not isinstance(arg.get("accountKey"), str) or arg["accountKey"] != identity.get("accountKey") or latest.get("accountKey", arg["accountKey"]) != arg["accountKey"]:
                raise ValueError("ACCOUNT_IDENTITY_MISMATCH")
            latest["accountKey"] = arg["accountKey"]
        elif "accountKey" in arg:
            raise ValueError("ACCOUNT_IDENTITY_PIN_MISSING")
        latest["peakEquity"] = max(number(latest["peakEquity"]), number(arg.get("peakEquity", 0)))
        latest.setdefault("paused", None)
        if "paused" in arg and latest["paused"] is None:
            latest["paused"] = arg["paused"]
        if assessment is not None and latest["paused"] is None:
            peak = latest["peakEquity"]
            dd = (peak - eq) / peak * 100 if peak else 0
            if dd >= budget:
                latest["paused"] = {"at": assessment["at"], "reason": f"drawdown {dd:.1f}% >= budget {budget}%", "peakEquity": peak, "equity": eq}
        for k in ("lastEquity", "lastAt"):
            if k in arg:
                latest[k] = arg[k]
        if before != json.dumps(latest, sort_keys=True) or not os.path.exists(P):
            fd, tmp = tempfile.mkstemp(dir=os.path.dirname(P), prefix=".risk.", suffix=".tmp")
            try:
                with os.fdopen(fd, "w", encoding="utf8") as f:
                    json.dump(latest, f, indent=2, allow_nan=False)
                    f.flush()
                    os.fsync(f.fileno())
                os.replace(tmp, P)
            finally:
                if os.path.exists(tmp):
                    os.unlink(tmp)
        print(json.dumps(latest, allow_nan=False))
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print("RISK_WRITE_FAILED: " + str(e), file=sys.stderr)
        sys.exit(2)
