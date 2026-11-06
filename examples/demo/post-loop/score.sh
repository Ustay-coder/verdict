#!/bin/bash
# score.sh <c|e> <round>: compare the three drafts of one post with post-review.yaml (brief swapped per video)
P=$(cd "$(dirname "$0")" && pwd); V=$1
cd /home/user/verdict
NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$P/$V/.verdict node packages/cli/dist/bin.js compare -r $P/post-review.yaml \
  -s "Draft A=post=$P/$V/drafts/a.md,brief=$P/$V/brief.md" -s "Draft B=post=$P/$V/drafts/b.md,brief=$P/$V/brief.md" -s "Draft C=post=$P/$V/drafts/c.md,brief=$P/$V/brief.md" --json 2>/dev/null > /dev/null
python3 - "$P/$V/.verdict/evaluations" "$2" <<'PY'
import json,os,sys
d=sys.argv[1]; evs=[json.load(open(os.path.join(d,f))) for f in os.listdir(d)]
b=max(evs,key=lambda e:e['createdAt'])['batchId']; evs=sorted([e for e in evs if e.get('batchId')==b],key=lambda e:e['subject']['name'])
for e in evs:
    a=e['aggregate']; print(f"round {sys.argv[2]} {e['subject']['name']}: {a['score']} {a.get('grade')} {'PASS' if a.get('passed') else 'FAIL'} | "+" ".join(f"{c['criterionId']}={round((c.get('normalized') or 0)*100)}" for c in e['criteria']))
PY
