#!/bin/bash
# board.sh <tidewatch.md> [label]: compare the four rivals and the given Tidewatch write-up; prints the leaderboard.
C=$(cd "$(dirname "$0")" && pwd); V=$C/..; E=$V/start/entries; T=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
s() { echo "$1=entry=$2,facts=$E/$3.facts.json"; }
cd /home/user/verdict
NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$C/.verdict node packages/cli/dist/bin.js compare -r $V/hackathon-judging-strict.yaml \
  -s "$(s Tidewatch $T tidewatch)" -s "$(s 'Receipt Run' $E/receipt-run.md receipt-run)" -s "$(s 'Common Room' $E/common-room.md common-room)" \
  -s "$(s 'Menu Match' $E/menu-match.md menu-match)" -s "$(s 'Plant Pal' $E/plant-pal.md plant-pal)" --json 2>$C/.last.err >/dev/null
python3 - "$C/.verdict/evaluations" "${2:-$(basename $1)}" <<'PY'
import json,os,sys
d=sys.argv[1]; evs=[json.load(open(os.path.join(d,f))) for f in os.listdir(d)]
b=max(evs,key=lambda e:e['createdAt'])['batchId']; evs=sorted([e for e in evs if e.get('batchId')==b],key=lambda e:-(e['aggregate']['score'] or 0))
print("==", sys.argv[2])
for i,e in enumerate(evs):
    a=e['aggregate']; print(f"{i+1}. {e['subject']['name']:12} {a['score']:>4} {a.get('grade'):10} | "+" ".join(f"{c['criterionId']}={round((c.get('normalized') or 0)*100)}" for c in e['criteria']))
PY
