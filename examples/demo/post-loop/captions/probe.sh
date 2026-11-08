#!/bin/bash
# probe.sh <video> <file>...: score loose drafts with caption-review.yaml (rubric calibration, not a round)
P=$(cd "$(dirname "$0")" && pwd); V=$1; shift; args=()
for f in "$@"; do args+=(-s "$(basename "$f" .md)=post=$(realpath "$f"),brief=$P/$V/brief.md"); done
D=$(mktemp -d)
(cd /home/user/verdict && NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$D node packages/cli/dist/bin.js compare -r "$P/caption-review.yaml" "${args[@]}" --json >/dev/null 2>&1)
python3 - "$D" "$@" <<'PY'
import json, os, sys
d = os.path.join(sys.argv[1], "evaluations")
for f in sorted(os.listdir(d)):
    e = json.load(open(os.path.join(d, f))); a = e["aggregate"]
    print(f"{e['subject']['name']}: {a['score']} | " + " ".join(f"{c['criterionId']}={round((c.get('normalized') or 0)*100)}" for c in e["criteria"] if c['criterionId'] not in ('claims_true','hashtags','mentions','styled_text','no_hype') or (c.get('normalized') or 0) < 1))
PY
[ -n "$PEEK" ] && for f in $D/evaluations/*; do python3 -c "import json,sys; e=json.load(open(sys.argv[1])); [print(e[\"subject\"][\"name\"], c[\"criterionId\"], (c.get(\"ratings\") or [{}])[0].get(\"probabilities\")) for c in e[\"criteria\"] if c[\"criterionId\"] in sys.argv[2].split(\",\")]" $f "$PEEK"; done
