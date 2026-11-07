#!/bin/bash
# score.sh <page.md> [label]: one evaluation with the strict rubric; prints score and every criterion
C=$(cd "$(dirname "$0")" && pwd); V=$C/..
cd /home/user/verdict
NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$C/.verdict node packages/cli/dist/bin.js eval -r $V/detail-review-strict.yaml -i page=$1 -i brief=$V/start/brief.json --json 2>/dev/null > $C/.last.json
python3 - $C/.last.json "${2:-$(basename $1)}" <<'PY'
import json,sys
e=json.load(open(sys.argv[1])); e=e.get("evaluation",e); a=e["aggregate"]
print(sys.argv[2], a["score"], a.get("grade"), "|", " ".join(f'{c["criterionId"]}={round((c.get("normalized") or 0)*100)}' for c in e["criteria"]))
PY
