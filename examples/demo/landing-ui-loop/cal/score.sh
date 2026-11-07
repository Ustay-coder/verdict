#!/bin/bash
# score.sh <page.html> [label]: serves the page on :8790 (from its folder), runs one evaluation, prints every criterion.
# Needs the audit scorer on :7788 (node examples/demo/ds-loop/audit/server.mjs).
C=$(cd "$(dirname "$0")" && pwd); V=$C/..; P=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
mkdir -p /tmp/lp-serve && cp "$P" /tmp/lp-serve/index.html
(exec 3<>/dev/tcp/127.0.0.1/8790) 2>/dev/null || (cd /tmp/lp-serve && nohup python3 -m http.server 8790 --bind 127.0.0.1 >/dev/null 2>&1 &) ; sleep 0.5
cd /home/user/verdict
NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$C/.verdict node packages/cli/dist/bin.js eval -r $V/landing-review-strict.yaml -i page=http://127.0.0.1:8790/index.html --screenshot -i facts=$V/start/facts.json --json 2>$C/.last.err > $C/.last.json
python3 - $C/.last.json "${2:-$(basename $1)}" <<'PY'
import json,sys
e=json.load(open(sys.argv[1])); e=e.get("evaluation",e); a=e["aggregate"]
print(sys.argv[2], a["score"], a.get("grade"), "|", " ".join(f'{c["criterionId"]}={round((c.get("normalized") or 0)*100)}' for c in e["criteria"]))
PY
