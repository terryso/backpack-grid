#!/usr/bin/env python3
"""risk.json 的唯一写入通道：内核 flock 事务 + 合并语义。

用法: risk_write.py '<json>'
  json 可含 "peakEquity" 和/或 "paused"；缺省的字段保留磁盘最新值。

合并规则（对 decide 与 peak_probe 两个写入方统一生效）：
  - peakEquity 只升不降（棘轮）：new = max(磁盘最新, 传入值)
  - paused 未显式提供则逐字保留最新值（探测/巡检不得清除熔断锁存）
  - 磁盘文件损坏或形状非法 → 拒写、原文保留、退出码 2（禁止自动重播种）
  - 写入为唯一临时文件 + 原子 rename；锁为内核 flock（持有者死亡自动释放）
"""
import fcntl
import json
import os
import sys
import tempfile

ROOT = os.environ.get("BG_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, "state", "risk.json")


def shape_ok(o):
    if not isinstance(o, dict):
        return False
    pk = o.get("peakEquity")
    if isinstance(pk, bool) or pk is None:
        return False
    if not (isinstance(pk, (int, float)) or (isinstance(pk, str) and pk.strip() != "")):
        return False
    try:
        n = float(pk)
    except (TypeError, ValueError):
        return False
    if n != n or n in (float("inf"), float("-inf")) or n < 0:
        return False
    return o.get("paused") is None or isinstance(o.get("paused"), dict)


def main():
    arg = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
    lock = open(os.path.join(ROOT, "state", "risk.lock"), "a+")
    fcntl.flock(lock, fcntl.LOCK_EX)
    try:
        if os.path.exists(P):
            raw = open(P, encoding="utf8").read()
            try:
                latest = json.loads(raw)
            except ValueError:
                print("RISK_WRITE_REFUSED_CORRUPT")
                return 2
            if not shape_ok(latest):
                print("RISK_WRITE_REFUSED_INVALID_SHAPE")
                return 2
        else:
            latest = {"peakEquity": 0, "paused": None}  # 首次初始化（无文件时）
        changed = False
        if "peakEquity" in arg:
            try:
                new = float(arg["peakEquity"])
            except (TypeError, ValueError):
                new = float("nan")
            cur_raw = latest["peakEquity"]
            cur = float(cur_raw)
            if new == new and new not in (float("inf"), float("-inf")) and new > cur:
                latest["peakEquity"] = new
                changed = True
            elif isinstance(cur_raw, str):
                latest["peakEquity"] = cur  # 一次性规范化：磁盘上的数字字符串形态归一为数值
                changed = True
        if "paused" in arg:
            if arg["paused"] != latest["paused"]:
                latest["paused"] = arg["paused"]
                changed = True
        for k in ("lastEquity", "lastAt"):  # 巡检回写最新权益观测（透传，无合并语义）
            if k in arg and arg[k] != latest.get(k):
                latest[k] = arg[k]
                changed = True
        if changed or not os.path.exists(P):
            d = os.path.dirname(P)
            fd, tmp = tempfile.mkstemp(dir=d, prefix=".risk.", suffix=".tmp")
            with os.fdopen(fd, "w", encoding="utf8") as f:
                f.write(json.dumps(latest, indent=2))
            os.rename(tmp, P)
        print(json.dumps(latest))
        return 0
    finally:
        fcntl.flock(lock, fcntl.LOCK_UN)


if __name__ == "__main__":
    sys.exit(main())
