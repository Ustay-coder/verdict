#!/usr/bin/env bash
# The whole loop with no model key: a Verdict server, a repository whose CI reports its runs, a promotion, and a
# service that picks the promoted version up. Works on a copy; this directory is not changed.
#
#   bash demo.sh                      # starts a server on this machine; uses npx @verdict-ai/cli
#   VERDICT_CLI="node ../../packages/cli/dist/bin.js" bash demo.sh   # from a checkout of the Verdict repository
#   VERDICT_HUB_URL=https://verdict.example.com VERDICT_HUB_KEY=… bash demo.sh   # against a server that is already
#                                     running: uses a project of its own and deletes it afterwards
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
VERDICT_CLI="${VERDICT_CLI:-npx --yes @verdict-ai/cli@latest}"
PORT="${PORT:-18790}"
WORK="$(mktemp -d)"
REMOTE="${VERDICT_HUB_URL:-}"
created=""
cleanup() {
  if [ -n "$created" ] && [ -n "$REMOTE" ]; then $VERDICT_CLI project delete "$created" --yes > /dev/null 2>&1 || true; fi
  kill "${server:-}" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT
step() { printf '\n== %s\n' "$1"; }

# The repository: rubric, cases, verdict.yaml. The service keeps its own copy of nothing — it reads prod.
cp -R "$HERE/rubrics" "$HERE/cases.jsonl" "$HERE/verdict.yaml" "$WORK/"
cd "$WORK"
export VERDICT_DATA_DIR="$WORK/data"

if [ -n "$REMOTE" ]; then
  step "1. A server that is already running: $REMOTE"
  # A name of its own, so runs do not collide and nothing that was there is touched.
  export VERDICT_PROJECT="${VERDICT_PROJECT:-demo-$(date +%s)-$$}"
else
  step "1. A self-hosted server (one API key, files on disk)"
  VERDICT_API_KEYS="sk_demo:acme" VERDICT_DATA_DIR="$WORK/server" VERDICT_LOG=0 $VERDICT_CLI serve -p "$PORT" > "$WORK/server.log" 2>&1 &
  server=$!
  export VERDICT_HUB_URL="http://127.0.0.1:$PORT" VERDICT_HUB_KEY="sk_demo" NO_PROXY="127.0.0.1" no_proxy="127.0.0.1"
  export VERDICT_PROJECT="${VERDICT_PROJECT:-support-bot}"
  up=""
  for _ in $(seq 1 50); do
    if $VERDICT_CLI project list > /dev/null 2>&1; then up=1; break; fi
    # A server that has already stopped (the port was taken, say) will not answer however long we wait.
    if ! kill -0 "$server" 2>/dev/null; then break; fi
    sleep 0.2
  done
  if [ -z "$up" ]; then
    echo "The server on port $PORT did not come up. Its log:" >&2
    cat "$WORK/server.log" >&2 || true
    exit 1
  fi
fi

step "2. A project with two environments"
$VERDICT_CLI project create "$VERDICT_PROJECT"
created="$VERDICT_PROJECT"
$VERDICT_CLI env create staging
$VERDICT_CLI env create prod

step "3. CI: run the cases and report the numbers (no case, input or answer is sent)"
$VERDICT_CLI version freeze rubrics/intent.yaml
$VERDICT_CLI run -r rubrics/intent.yaml -d cases.jsonl --report

step "4. Promote what was tested to prod"
$VERDICT_CLI promote rubrics/intent.yaml --env prod --yes --note "first release"

step "5. The service reads prod and judges locally"
node "$HERE/service.mjs" "please connect me to an agent" "can I talk to a human about my bill"

step "6. A change: the rubric learns that 'human' means an agent. CI compares both versions and reports"
cp rubrics/intent.yaml "$WORK/main-intent.yaml"
sed -i.bak 's/keywords: \[agent\]/keywords: [agent, human]/' rubrics/intent.yaml && rm rubrics/intent.yaml.bak
$VERDICT_CLI diff --base "$WORK/main-intent.yaml" --head rubrics/intent.yaml -d cases.jsonl --report --fail-on regressed

step "7. Freeze, promote through staging, and the service picks it up"
$VERDICT_CLI version freeze rubrics/intent.yaml
$VERDICT_CLI promote rubrics/intent.yaml --env staging --yes
$VERDICT_CLI promote --from staging --env prod --yes --note "treat 'human' as wanting an agent"
node "$HERE/service.mjs" "can I talk to a human about my bill"

step "8. Something looks wrong in production: roll back, and see who changed what"
$VERDICT_CLI rollback intent --env prod --yes --note "checking a complaint"
node "$HERE/service.mjs" "can I talk to a human about my bill"
$VERDICT_CLI env history --env prod
