#!/usr/bin/env python3
"""Keep every version of every evaluation a recording writes, with the time it appeared.

usage: snapshot.py <work>/.verdict/evaluations <out-dir> [stop-file]
Polls every 0.1 s; each new or changed <id>.json is copied to <out-dir>/<epoch>__<id>.json. Re-aggregation overwrites an
evaluation in place, so without this the replay could only show its last version. Stops when stop-file exists.
"""
import os, shutil, sys, time
src, out = sys.argv[1], sys.argv[2]
stop = sys.argv[3] if len(sys.argv) > 3 else None
os.makedirs(out, exist_ok=True)
seen = {}
while not (stop and os.path.exists(stop)):
    if os.path.isdir(src):
        for f in os.listdir(src):
            if not f.endswith(".json"): continue
            p = os.path.join(src, f)
            try: st = os.stat(p); key = (st.st_mtime_ns, st.st_size)
            except FileNotFoundError: continue
            if seen.get(f) != key:
                seen[f] = key
                try: shutil.copyfile(p, os.path.join(out, f"{time.time():.3f}__{f}"))
                except FileNotFoundError: pass
    time.sleep(0.1)
