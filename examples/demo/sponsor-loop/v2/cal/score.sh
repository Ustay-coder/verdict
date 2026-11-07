#!/bin/bash
# score.sh <script.md> [label]: evaluate one script against the brief and notes; prints the score and every criterion.
C=$(cd "$(dirname "$0")" && pwd); V=$C/..; S=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
cd /home/user/verdict
NODE_USE_ENV_PROXY=1 VERDICT_DATA_DIR=$C/.verdict node packages/cli/dist/bin.js eval -r $V/sponsor-review-strict.yaml \
  -i script=$S -i brief=$V/start/brief.json -i notes=$V/start/notes.json -n "Small Desk Studio script" --json 2>>$C/.last.err | python3 $C/show.py "${2:-$(basename $1)}"
