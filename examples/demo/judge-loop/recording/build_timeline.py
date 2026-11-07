#!/usr/bin/env python3
"""Timeline of a judge-loop take: every version of the rubric and every check_against_humans result.

usage: build_timeline.py <take-dir> <start-rubric> <gold.jsonl> <out-dir> [--final <path>]
Writes <out-dir>/states/NN.yaml (the rubric after each Edit/Write the agent made) and <out-dir>/timeline.json:
states with their cast time (aligned to the recording's prompt-submit marker) and every check with, per gold item,
"agree" / "disagree" / "asked" (a subject the judge handed to a human), in gold-file order.
"""
import json, os, sys
from datetime import datetime

take, original, gold, out = sys.argv[1:5]
final = sys.argv[sys.argv.index("--final") + 1] if "--final" in sys.argv else None
target = os.path.basename(original)
markers = {l.split("\t")[1].strip(): float(l.split("\t")[0]) for l in open(next(os.path.join(take, f) for f in os.listdir(take) if f.endswith(".cast.markers")))}
items = [json.loads(l) for l in open(gold) if l.strip()]
doc = open(original).read()
os.makedirs(f"{out}/states", exist_ok=True)
states, checks, pending, t0 = [{"src": 0.0, "file": "states/00.yaml"}], [], {}, None
open(f"{out}/states/00.yaml", "w").write(doc)
for line in open(f"{take}/session.jsonl"):
    e = json.loads(line)
    c = (e.get("message") or {}).get("content")
    ts = e.get("timestamp")
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() if ts else None
    if e.get("type") == "user" and isinstance(c, str) and t0 is None:
        t0 = t
    if not isinstance(c, list):
        continue
    for b in c:
        if b.get("type") == "tool_use":
            pending[b["id"]] = (b["name"], b["input"], round(t - t0 + markers["submitted"], 3))
        elif b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
            name, inp, called = pending.pop(b["tool_use_id"])
            src = round(t - t0 + markers["submitted"], 3)
            if b.get("is_error"):
                continue
            if name in ("Edit", "Write") and os.path.basename(inp.get("file_path", "")) == target:
                if name == "Edit":
                    assert inp["old_string"] in doc, f"edit {len(states)} does not apply"
                    doc = doc.replace(inp["old_string"], inp["new_string"], -1 if inp.get("replace_all") else 1)
                else:
                    doc = inp["content"]
                f = f"states/{len(states):02d}.yaml"
                open(f"{out}/{f}", "w").write(doc)
                states.append({"src": src, "file": f})
            elif name == "mcp__verdict__check_against_humans":
                content = b["content"]
                r = json.loads(content if isinstance(content, str) else "".join(x.get("text", "") for x in content))
                if "error" in r:
                    continue
                gname = os.path.basename(inp.get("gold", ""))
                wrong = {d["name"] for d in r["disagreements"] if d["verdict"]["passed"] is not None and d["verdict"]["passed"] != d["human"].get("passed")}
                asked = set(r.get("askedHumanFor", []))
                cells = ["asked" if i["name"] in asked else "disagree" if i["name"] in wrong else "agree" for i in items] if gname == os.path.basename(gold) else None
                checks.append({"src": src, "called": called, "gold": gname, "agreed": r["agreed"], "decided": r["decided"], "askedHuman": r["askedHuman"],
                               "criteria": r["criteria"], "cells": cells, "state": len(states) - 1})
if final:
    assert open(final).read() == doc, "rebuilt final rubric differs from the agent's file"
json.dump({"markers": markers, "humans": [i["human"]["passed"] for i in items], "states": states, "checks": checks}, open(f"{out}/timeline.json", "w"), indent=1)
print(f"{len(states)} states, checks " + ", ".join(f"{c['gold']} {c['agreed']}/{c['decided']} asked {c['askedHuman']}" for c in checks) + (" · final rubric matches" if final else ""))
