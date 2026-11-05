#!/usr/bin/env python3
"""Build the edit timeline from Take A's real artifacts: the asciicast, the session transcript and v1.md.

Every page state is v1.md with the agent's Edit calls applied in order, timed to the moment the tool result
arrived (aligned to the cast via the prompt-submit marker). Every score is the agent's own evaluate result.
usage: build_data.py <take-dir> <v1.md> <rubric.yaml> <out.json>
"""
import json, re, sys
from datetime import datetime

take, v1_path, rubric_path, out_path = sys.argv[1:5]
SUBMITTED = float([l.split("\t")[0] for l in open(f"{take}/landing.cast.markers") if l.strip().endswith("submitted")][0])

cast = [json.loads(l) for l in open(f"{take}/landing.cast").read().splitlines()[1:]]
cast = [[e[0], e[2]] for e in cast if e[1] == "o"]

doc = open(v1_path).read()
states = [{"src": 0.0, "md": doc, "label": "v1"}]
evals, pending, t0 = [], {}, None
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
            src = round(t - t0 + SUBMITTED, 3)
            if name == "Edit" and inp.get("file_path", "").endswith("landing.md"):
                assert doc.count(inp["old_string"]) >= 1
                doc = doc.replace(inp["old_string"], inp["new_string"], -1 if inp.get("replace_all") else 1)
                states.append({"src": src, "md": doc, "label": f"edit {len(states)}"})
            elif name == "Write" and inp.get("file_path", "").endswith("landing.md"):
                doc = inp["content"]
                states.append({"src": src, "md": doc, "label": f"write {len(states)}"})
            elif name == "mcp__verdict__evaluate":
                content = b["content"]
                ev = json.loads(content if isinstance(content, str) else "".join(x.get("text", "") for x in content))
                fixed = re.search(r"\(([a-z_]+)\)", inp.get("name", ""))
                evals.append({"src": src, "score": ev["score"], "grade": ev["grade"], "name": inp.get("name"),
                              "fixed": fixed.group(1) if fixed else None,
                              "criteria": [{"id": x["id"], "name": x["name"], "n": x.get("normalized") or 0} for x in ev["criteria"]]})

final_text = [l for l in open(f"{take}/session.jsonl") if '"stop_reason": "end_turn"' in l or '"stop_reason":"end_turn"' in l]
done_src = float([l.split("\t")[0] for l in open(f"{take}/landing.cast.markers") if l.strip().endswith("done")][0])

# Time warp (source seconds -> video speed). Slow down around every edit and every score so they read; fast elsewhere.
windows = [(s["src"] - 0.25, s["src"] + 1.7) for s in states[1:]] + [(e["src"] - 0.1, e["src"] + 0.9) for e in evals]
windows.sort()
merged = []
for a, b in windows:
    if merged and a <= merged[-1][1]:
        merged[-1] = (merged[-1][0], max(merged[-1][1], b))
    else:
        merged.append((a, b))
first_edit = states[1]["src"]
segments = [(12.3, SUBMITTED, 5.0), (SUBMITTED, evals[0]["src"] - 0.3, 12.0), (evals[0]["src"] - 0.3, first_edit - 0.25, 2.2)]
cursor = first_edit - 0.25
for a, b in merged:
    if b <= cursor:
        continue
    if a > cursor:
        segments.append((cursor, a, 9.0))
    segments.append((max(a, cursor), b, 1.35))
    cursor = b
segments.append((cursor, done_src - 1.0, 4.0))
segments.append((done_src - 1.0, done_src + 1.0, 1.0))

rubric = open(rubric_path).read()
levels = rubric[rubric.index("  - id: value_prop"): rubric.index("  - id: proof")].rstrip()
buzz = re.search(r'pattern: "(\\\\b\(revolutionary[^"]+)"', rubric).group(1).replace("\\\\", "\\")

assert all(b > a for a, b, _ in segments) and all(segments[i][1] == segments[i + 1][0] for i in range(len(segments) - 1)), segments
json.dump({"cast": cast, "states": states, "evals": evals, "segments": segments, "rubricLevels": levels,
           "buzzwordPattern": buzz, "agentSeconds": round(done_src - SUBMITTED)}, open(out_path, "w"))
vt = 0
for a, b, sp in segments:
    vt += (b - a) / sp
print(f"states={len(states)} evals={[e['score'] for e in evals]} fixed={[e['fixed'] for e in evals]}")
print(f"split-screen duration {vt:.1f}s, agent time {done_src - SUBMITTED:.0f}s, buzz pattern ok={bool(buzz)}")
