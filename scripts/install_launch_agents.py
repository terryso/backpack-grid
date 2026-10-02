#!/Users/nick/.browser-use-env/bin/python3
"""Generate explicit, reproducible launchd entrypoints. Does not start jobs.
All jobs have RunAtLoad=false: installing/reloading never forces a trading round.
"""
import json
import os
import plistlib
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
DEST = Path.home() / "Library/LaunchAgents"
JOBS = [
    ("com.backpack.grid-monitor", "com.backpack.grid-monitor.plist", "round_locked.sh", 900),
    ("com.backpack-grid-peak", "com.backpack-grid-peak.plist", "peak_probe.sh", 60),
    ("com.backpack-grid-history", "com.backpack-grid-history.plist", "collect_history.sh", 900),
    ("com.backpack-grid-research", "com.backpack-grid-research.plist", "refresh_research.sh", 900),
]
for label, filename, script, interval in JOBS:
    item = {"Label": label, "ProgramArguments": ["/bin/bash", str(ROOT / "scripts" / script)],
            "WorkingDirectory": str(ROOT), "StartInterval": interval, "RunAtLoad": False,
            "StandardOutPath": str(ROOT / "state" / (label + ".log")),
            "StandardErrorPath": str(ROOT / "state" / (label + ".log")),
            "EnvironmentVariables": {"PATH": "/Users/nick/.nvm/versions/node/v22.14.0/bin:" + str(Path.home() / ".local/bin") + ":/usr/local/bin:/usr/bin:/bin"}}
    if "--install" in sys.argv:
        DEST.mkdir(parents=True, exist_ok=True)
        if (DEST / filename).exists():
            backup = ROOT / "state" / (filename + ".before-fixes")
            if not backup.exists(): backup.write_bytes((DEST / filename).read_bytes())
        tmp = DEST / (filename + ".tmp")
        tmp.write_bytes(plistlib.dumps(item))
        os.replace(tmp, DEST / filename)
    print(json.dumps({"path": str(DEST / filename), **item}, ensure_ascii=False))
