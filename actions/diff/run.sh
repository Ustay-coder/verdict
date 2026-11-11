#!/usr/bin/env bash
# Verdict diff action: the base branch's rubric vs. the pull request's rubric on the same gold cases.
# Inputs come from the environment (see action.yml). Runs outside GitHub too: leave PR_NUMBER unset or COMMENT=false.
set -euo pipefail

: "${RUBRIC:?rubric is required}" "${DATA:?data is required}" "${BASE_REF:?base-ref is required (or run on pull_request)}"
VERDICT_CLI="${VERDICT_CLI:-npx --yes @verdict-ai/cli@latest}"
TMP="${RUNNER_TEMP:-$(mktemp -d)}"
SAFE_NAME="$(printf '%s' "$RUBRIC" | tr -c 'A-Za-z0-9._-' '_')"
OUT="$TMP/verdict-diff-$SAFE_NAME.md"
BODY="$OUT.body"
MARKER="<!-- verdict-diff:$RUBRIC -->"
# A fresh data directory per job: stored runs never leak between pull requests.
export VERDICT_DATA_DIR="$TMP/verdict-data-$SAFE_NAME"

common=(-d "$DATA")
if [ "${MOCK:-false}" = "true" ]; then common+=(--mock); fi
gate=()
if [ -n "${FAIL_ON:-}" ]; then gate+=(--fail-on "$FAIL_ON"); fi

# Reporting to a Verdict server is opt-in. Only non-empty inputs override what the environment already says.
report=(--report)
if [ -n "${PROJECT:-}" ]; then report+=(--project "$PROJECT"); fi
if [ -n "${RUBRIC_NAME:-}" ]; then report+=(--name "$RUBRIC_NAME"); fi
if [ -n "${HEAD_SHA:-}" ]; then report+=(--commit "$HEAD_SHA"); fi
if [ -n "${SERVER:-}" ]; then export VERDICT_HUB_URL="$SERVER"; fi
if [ -n "${SERVER_KEY:-}" ]; then export VERDICT_HUB_KEY="$SERVER_KEY"; fi

set_output() { if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi; }

# actions/checkout fetches one commit by default; fetch the base commit when it is missing.
if ! git cat-file -e "$BASE_REF^{commit}" 2>/dev/null; then git fetch --quiet --depth=1 origin "$BASE_REF" || true; fi

status=0
base_file="$TMP/verdict-base-$SAFE_NAME"
case "$RUBRIC" in *.json) base_file="$base_file.json" ;; *) base_file="$base_file.yaml" ;; esac
if git cat-file -e "$BASE_REF:$RUBRIC" 2>/dev/null; then
  git show "$BASE_REF:$RUBRIC" > "$base_file"
  # First pass runs both versions and stores the runs; the second reuses them (no judge calls) for the JSON outputs.
  set +e
  $VERDICT_CLI diff --base "$base_file" --head "$RUBRIC" "${common[@]}" ${gate[@]+"${gate[@]}"} --markdown --title "Verdict diff \`$RUBRIC\`" > "$BODY" 2> "$BODY.err"
  status=$?
  set -e
  cat "$BODY.err" >&2
  # An empty comparison means the CLI failed before comparing; show why instead of a bare "gate failed".
  # Prefer the CLI's own error lines; runtime warnings (e.g. from Node) do not belong in a PR comment.
  if [ ! -s "$BODY" ]; then
    reason="$(grep -E '^error:' "$BODY.err" || tail -n 20 "$BODY.err")"
    printf '### Verdict diff `%s`\n\nCould not compare:\n\n```\n%s\n```\n' "$RUBRIC" "$reason" > "$BODY"
  fi
  if $VERDICT_CLI diff --base "$base_file" --head "$RUBRIC" "${common[@]}" --json > "$TMP/verdict-diff.json" 2>/dev/null; then
    set_output kind "$(node -p 'require(process.argv[1]).kind' "$TMP/verdict-diff.json")"
    set_output regressed "$(node -p 'require(process.argv[1]).criteria.reduce((s, c) => s + c.counts.regressed, 0)' "$TMP/verdict-diff.json")"
  fi
  # Reporting reuses the stored runs. It never decides the job: the gate is about the rubric, not about the server.
  if [ "${REPORT:-false}" = "true" ] && [ -s "$TMP/verdict-diff.json" ]; then
    if [ "${MOCK:-false}" = "true" ]; then
      printf '\nNot reported: mock runs are never reported.\n' >> "$BODY"
    elif reported="$($VERDICT_CLI diff --base "$base_file" --head "$RUBRIC" "${common[@]}" "${report[@]}" --json 2>&1 > /dev/null)"; then
      # The comment may be public: name the comparison, not the server.
      printf '\nReported to the Verdict project%s.\n' "$(printf '%s\n' "$reported" | grep -oE 'comparison cmp_[0-9a-f]+' | head -n 1 | sed 's/^/ (/; s/$/)/')" >> "$BODY"
    else
      reason="$(printf '%s\n' "$reported" | grep -E '^error:' || printf '%s\n' "$reported" | tail -n 5)"
      printf '\n> Could not report to the Verdict server: %s\n' "$reason" >> "$BODY"
      echo "::warning::Verdict report failed: $reason"
    fi
  fi
else
  printf '### Verdict diff `%s`\n\nNew rubric: there is no base version at `%s` to compare with.\n' "$RUBRIC" "$BASE_REF" > "$BODY"
  set_output kind new
  set_output regressed 0
fi

if [ "${VERIFY_LOCK:-false}" = "true" ]; then
  set +e
  verify="$($VERDICT_CLI version verify 2>&1)"
  verify_status=$?
  set -e
  printf '\n<details><summary>verdict.lock</summary>\n\n```\n%s\n```\n</details>\n' "$verify" >> "$BODY"
  if [ "$verify_status" -ne 0 ]; then status=$verify_status; fi
fi

{
  echo "$MARKER"
  cat "$BODY"
  if [ "$status" -ne 0 ]; then printf '\n**Failed** (exit %s; fail-on: `%s`%s).\n' "$status" "${FAIL_ON:-}" "$([ "${VERIFY_LOCK:-false}" = "true" ] && echo ', verify-lock')"; fi
} > "$OUT"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$OUT" >> "$GITHUB_STEP_SUMMARY"; fi
cat "$OUT"

# One comment per rubric, updated in place on every push.
if [ "${COMMENT:-true}" = "true" ] && [ -n "${PR_NUMBER:-}" ]; then
  existing="$(gh api "repos/$REPOSITORY/issues/$PR_NUMBER/comments" --paginate --jq ".[] | select(.body | startswith(\"$MARKER\")) | .id" | tail -n 1)"
  if [ -n "$existing" ]; then gh api -X PATCH "repos/$REPOSITORY/issues/comments/$existing" -F body=@"$OUT" > /dev/null
  else gh api -X POST "repos/$REPOSITORY/issues/$PR_NUMBER/comments" -F body=@"$OUT" > /dev/null; fi
fi

exit "$status"
