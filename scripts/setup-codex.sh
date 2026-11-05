#!/usr/bin/env bash
# Set up OpenAI Codex CLI for this repo using ChatGPT subscription (OAuth) auth — no API key.
# Usage: scripts/setup-codex.sh            (interactive browser login)
#        scripts/setup-codex.sh --device   (device-code login for headless / remote machines)
set -euo pipefail

CODEX_VERSION="${CODEX_VERSION:-latest}"
CONFIG="$HOME/.codex/config.toml"
REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v codex >/dev/null 2>&1; then
  echo "▶ installing @openai/codex@$CODEX_VERSION"
  npm install -g "@openai/codex@$CODEX_VERSION"
fi
echo "▶ codex $(codex --version)"

mkdir -p "$HOME/.codex"
touch "$CONFIG"

# Force ChatGPT (OAuth) auth so usage is billed to the subscription, never to an API key.
if grep -q '^preferred_auth_method' "$CONFIG"; then
  sed -i.bak 's/^preferred_auth_method.*/preferred_auth_method = "chatgpt"/' "$CONFIG" && rm -f "$CONFIG.bak"
else
  printf '\n# Use the ChatGPT subscription (OAuth) rather than an API key\npreferred_auth_method = "chatgpt"\n' >> "$CONFIG"
fi
grep -q '^model *=' "$CONFIG" || printf 'model = "gpt-5-codex"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n' >> "$CONFIG"
if ! grep -q "projects.\"$REPO_DIR\"" "$CONFIG"; then
  printf '\n[projects."%s"]\ntrust_level = "trusted"\n' "$REPO_DIR" >> "$CONFIG"
fi
echo "▶ wrote $CONFIG (preferred_auth_method = chatgpt)"

if [ -n "${OPENAI_API_KEY:-}" ]; then
  echo "⚠ OPENAI_API_KEY is set in this shell. Codex will still prefer ChatGPT auth, but unset it to be safe:  unset OPENAI_API_KEY"
fi

if codex login status 2>/dev/null | grep -qi "logged in"; then
  echo "▶ already logged in:"; codex login status
else
  if [ "${1:-}" = "--device" ]; then
    echo "▶ device-code login: open the printed URL on any device and enter the code"
    codex login --device-auth
  else
    echo "▶ opening the ChatGPT login in your browser (fallback: scripts/setup-codex.sh --device)"
    codex login
  fi
fi

echo
echo "✔ Codex is ready. From $REPO_DIR run:  codex"
echo "   (project instructions are in AGENTS.md; verify auth any time with: codex login status)"
