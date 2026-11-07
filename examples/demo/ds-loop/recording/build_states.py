#!/usr/bin/env python3
"""Rebuild every state of the agent's target file from a Claude Code session transcript.

usage: build_states.py <take-dir> <original-file> <target-name> <out-dir>
  take-dir      holds landing.cast-style `<name>.cast.markers` and `session.jsonl` (see recording/record.py)
  original-file the file as it was before the run (e.g. ds-loop/start/index.html)
  target-name   basename the agent edited (e.g. index.html)
Writes <out-dir>/states/NN.html and <out-dir>/timeline.json: each state with its cast time (seconds, aligned to the
recording via the prompt-submit marker) plus every evaluate result (score, grade, per-criterion normalized and rationale).
The last state must equal the file the agent left behind; pass --final <path> to assert it.
"""
import json, os, re, sys
from datetime import datetime

take, original, target, out = sys.argv[1:5]
final = sys.argv[sys.argv.index("--final") + 1] if "--final" in sys.argv else None
markers = {l.split("\t")[1].strip(): float(l.split("\t")[0]) for l in open(next(os.path.join(take, f) for f in os.listdir(take) if f.endswith(".cast.markers")))}
doc = open(original).read()
os.makedirs(f"{out}/states", exist_ok=True)
states, evals, pending, t0 = [{"src": 0.0, "file": "states/00.html"}], [], {}, None
open(f"{out}/states/00.html", "w").write(doc)
for line in open(f"{take}/session.jsonl"):
    e = json.loads(line)
    m = e.get("message") or {}
    c = m.get("content")
    ts = e.get("timestamp")
    t = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp() if ts else None
    if e.get("type") == "user" and isinstance(c, str) and t0 is None:
        t0 = t
    if not isinstance(c, list):
        continue
    for b in c:
        if b.get("type") == "tool_use":
            pending[b["id"]] = (b["name"], b["input"])
        elif b.get("type") == "tool_result" and b.get("tool_use_id") in pending:
            name, inp = pending.pop(b["tool_use_id"])
            src = round(t - t0 + markers["submitted"], 3)
            if b.get("is_error"):
                continue  # a refused edit (e.g. old_string not unique) changed nothing
            if name in ("Edit", "Write") and os.path.basename(inp.get("file_path", "")) == target:
                if name == "Edit":
                    assert inp["old_string"] in doc, f"edit {len(states)} does not apply"
                    doc = doc.replace(inp["old_string"], inp["new_string"], -1 if inp.get("replace_all") else 1)
                else:
                    doc = inp["content"]
                f = f"states/{len(states):02d}.html"
                open(f"{out}/{f}", "w").write(doc)
                states.append({"src": src, "file": f})
            elif name == "mcp__verdict__evaluate":
                content = b["content"]
                ev = json.loads(content if isinstance(content, str) else "".join(x.get("text", "") for x in content))
                evals.append({"src": src, "name": inp.get("name"), "score": ev["score"], "grade": ev["grade"], "state": len(states) - 1,
                              "criteria": [{"id": x["id"], "name": x["name"], "n": x.get("normalized") or 0, "rationale": x.get("rationale")} for x in ev["criteria"]]})
if final:
    assert open(final).read() == doc, "rebuilt final state differs from the agent's file"
json.dump({"markers": markers, "states": states, "evals": evals}, open(f"{out}/timeline.json", "w"), indent=1)
print(f"{len(states)} states, evals {[e['score'] for e in evals]}" + (" · final state matches" if final else ""))
