#!/bin/bash
# take.sh <work-dir> <take-out-dir> <prompt.txt> <done-marker> <watch-port>
# Records one unattended Claude Code run (Read/Edit/Write + the verdict MCP) while `verdict watch` serves the
# work folder's store and snapshot.py keeps every version of every evaluation.
set -e
W=$1; OUT=$2; PROMPT=$3; DONE=$4; PORT=$5
HERE=$(cd "$(dirname "$0")" && pwd); REPO=$(cd "$HERE/../../.." && pwd)
mkdir -p "$OUT"; rm -f "$OUT/.stop"
python3 "$HERE/snapshot.py" "$W/.verdict/evaluations" "$OUT/snapshots" "$OUT/.stop" & SNAP=$!
(cd "$W" && VERDICT_DATA_DIR="$W/.verdict" node "$REPO/packages/cli/dist/bin.js" watch -p "$PORT" > "$OUT/watch.log" 2>&1) & WATCH=$!
REC_DONE="$DONE" REC_TOOLS="Read,Edit,Write" REC_ALLOWED="Read Edit Write mcp__verdict" REC_MODE=dontAsk \
  python3 "$REPO/examples/demo/landing-loop/recording/record.py" "$W" "$OUT/run.cast" "$PROMPT" 100 30 > "$OUT/record.log" 2>&1 || true
sleep 1; touch "$OUT/.stop"; wait $SNAP 2>/dev/null || true; kill $WATCH 2>/dev/null || true
P=$(ls -t "$CLAUDE_CONFIG_DIR"/projects/*$(basename "$W")*/*.jsonl | head -1); cp "$P" "$OUT/session.jsonl"
tail -1 "$OUT/record.log"; ls "$OUT/snapshots" | wc -l
