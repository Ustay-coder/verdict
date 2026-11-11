#!/usr/bin/env bash
# Build the VitePress site and deploy it as a Cloudflare Worker with static assets (website/wrangler.toml).
# Needs CLOUDFLARE_API_TOKEN (Workers Scripts: Edit) and CLOUDFLARE_ACCOUNT_ID. No Pages permission required.
set -euo pipefail
cd "$(dirname "$0")/.."
export NODE_USE_ENV_PROXY=1
pnpm --filter verdict-website build
(cd website && wrangler deploy)
