#!/usr/bin/env python3
"""以内核 flock 互斥执行命令。

用法: with_lock.py <命令...>
- state/round.lock 被持有 → 立即退出码 3（跳过，不排队）
- 获取成功 → 持有至命令结束；持有者进程死亡时内核自动释放（无陈旧锁、无接管路径）
"""
import fcntl
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
lock_path = os.path.join(ROOT, "state", "round.lock")

lock = open(lock_path, "a+")
try:
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    print("SKIP: round lock held", file=sys.stderr)
    sys.exit(3)

# 写入持有者 pid（诊断用）；退出时 fd 关闭、锁由内核释放
lock.seek(0)
lock.truncate()
lock.write(str(os.getpid()))

rc = subprocess.call(sys.argv[1:], env={**os.environ, "BG_LOCKED": "1"})
sys.exit(rc)
