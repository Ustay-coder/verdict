#!/bin/bash
# score.sh <b|c|d|e|f> <round>: compare one video's three drafts with caption-review.yaml and keep them in rounds/<round>/
P=$(cd "$(dirname "$0")" && pwd); V=$1; R=$2; RUB=$P/caption-review.yaml
mkdir -p "$P/$V/rounds/$R" && cp "$P/$V"/drafts/{a,b,c}.md "$P/$V/rounds/$R/"
cd /home/user/verdict
NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$P/$V/.verdict node packages/cli/dist/bin.js compare -r "$RUB" \
  -s "Draft A=post=$P/$V/drafts/a.md,brief=$P/$V/brief.md" -s "Draft B=post=$P/$V/drafts/b.md,brief=$P/$V/brief.md" \
  -s "Draft C=post=$P/$V/drafts/c.md,brief=$P/$V/brief.md" --json > /dev/null 2>"$P/$V/.last-err"
python3 - "$P/$V" "$R" <<'PY' | tee "$P/$V/rounds/$R/scores.txt"
import json, os, sys
v, r = sys.argv[1], sys.argv[2]; d = os.path.join(v, ".verdict", "evaluations")
def xlen(t):  # X's weighted length (twitter-text v3): these ranges count 1, everything else 2
    rs = [(0, 4351), (8192, 8205), (8208, 8223), (8242, 8247)]
    return sum(1 if any(a <= ord(ch) <= b for a, b in rs) else 2 for ch in t)
evs = [json.load(open(os.path.join(d, f))) for f in os.listdir(d)]
b = max(evs, key=lambda e: e["createdAt"])["batchId"]
for e in sorted([e for e in evs if e.get("batchId") == b], key=lambda e: e["subject"]["name"]):
    a = e["aggregate"]; k = e["subject"]["name"][-1].lower()
    t = open(os.path.join(v, "drafts", k + ".md")).read().strip()
    crit = " ".join(f"{c['criterionId']}={round((c.get('normalized') or 0) * 100)}" for c in e["criteria"])
    err = [c["criterionId"] for c in e["criteria"] if any(x.get("status") != "scored" for x in c.get("ratings") or [])]
    print(f"round {r} {e['subject']['name']}: {a['score']} {a.get('grade')} {'PASS' if a.get('passed') else 'FAIL'} x={xlen(t)} | {crit}" + (f" | JUDGE ERROR: {','.join(err)}" if err else ""))
PY
