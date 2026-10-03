#!/Users/nick/.browser-use-env/bin/python3
"""以内核 flock 互斥执行命令——巡检与峰值探测的统一包装。

用法: with_lock.py [--wait N] <命令...>
- 默认：state/round.lock 被持有 → 立即退出码 3（跳过，不排队）
- --wait N：最多等 N 秒获取锁，超时退出码 3（探测耗时短，轮次等它收尾即可
  不丢轮；轮次本身耗时长，后面的调用超时跳过避免重复执行）
- 获取成功 → 持有至命令结束；持有者进程死亡时内核自动释放（无陈旧锁、无接管路径）

锁生命周期与业务绑定：锁 fd 通过 pass_fds 传给业务子进程，业务直接子进程
持有该 fd（更深后代是否保留由运行器决定）——包装器被 SIGKILL 后锁不释放（业务还活着），第二个包装器会被拒绝；
所有继承了该 fd 的进程退出后，锁由内核释放。首次运行自动创建 state/。
"""
import fcntl
import os
import math
import json
import subprocess
import sys
import time

args = sys.argv[1:]
wait_secs = 0.0
lock_name = "round"
while args and args[0].startswith("--"):
    option = args[0]
    if option == "--wait":
        wait_secs = float(args[1])
        if not math.isfinite(wait_secs) or wait_secs < 0 or wait_secs > 60: raise ValueError("wait must be 0..60 seconds")
    elif option == "--name" and args[1] in ("round", "history", "research", "ledger"):
        lock_name = args[1]
    else:
        raise ValueError("invalid lock option")
    args = args[2:]
if not args:
    print("usage: with_lock.py [--wait N] <command...>", file=sys.stderr)
    sys.exit(2)

ROOT = os.environ.get("BG_ROOT") or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.makedirs(os.path.join(ROOT, "state"), exist_ok=True)
lock_path = os.path.join(ROOT, "state", lock_name + ".lock")

lock = open(lock_path, "a+")
deadline = time.monotonic() + wait_secs
while True:
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            print("SKIP: round lock held", file=sys.stderr)
            sys.exit(3)
        time.sleep(0.5)

# 写入持有者 pid（诊断用）；业务子进程通过 pass_fds 继承同一 fd
lock.seek(0)
lock.truncate()
lock.write(str(os.getpid()))
lock.flush()

rc = subprocess.call(args, pass_fds=(lock.fileno(),),
                     env={**os.environ, "BG_LOCKED": "1" if lock_name == "round" else "0"})
if lock_name == "round" and rc != 0:
    status_path = os.path.join(ROOT, "state", "last_round_status")
    try:
        if open(status_path).read().strip() == "running":
            tmp = status_path + ".supervisor." + str(os.getpid())
            with open(tmp, "w") as f: f.write("aborted")
            os.replace(tmp, status_path)
            context = json.load(open(os.path.join(ROOT,"state","run_context.json")))
            event = {**context, "type":"end", "status":"aborted", "at":__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(), "exitCode":rc}
            with open(os.path.join(ROOT,"state","run_events.jsonl"),"a") as f: f.write(json.dumps(event)+"\n")
    except (OSError, ValueError): pass
sys.exit(rc if rc >= 0 else 128 - rc)
