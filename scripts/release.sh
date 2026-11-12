#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=${1:-}
mode=${2:-}
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || [[ $# -gt 2 ]] || [[ $mode != "" && $mode != --dry-run && $mode != --tag-only ]]; then
  echo 'Usage: scripts/release.sh <version> [--dry-run | --tag-only]' >&2
  echo '  --dry-run   bump, build, test, pnpm publish --dry-run and tarball checks; leaves the tree untouched' >&2
  echo '  --tag-only  bump, build, test, commit "Release v<version>" and push main; the release workflow publishes (NPM_TOKEN) and tags' >&2
  exit 1
fi
[[ -z $(git status --porcelain) ]] || { echo 'Release requires a clean tree.' >&2; exit 1; }
git rev-parse "v$version" >/dev/null 2>&1 && { echo "Tag v$version already exists." >&2; exit 1; }
backup=$(mktemp -d)
# The API runs on Workers and cannot read its package.json, so its version is also a constant in the source.
api_version=packages/api/src/version.ts
for package in packages/*; do cp "$package/package.json" "$backup/$(basename "$package").json"; done
cp "$api_version" "$backup/api-version.ts"
cp CHANGELOG.md "$backup/CHANGELOG.md"
# The MCP registry reads the server's version from this file, and checks that npm has that version.
mcp_server=packages/mcp/server.json
cp "$mcp_server" "$backup/mcp-server.json"
restore() {
  for package in packages/*; do cp "$backup/$(basename "$package").json" "$package/package.json"; done
  cp "$backup/api-version.ts" "$api_version"
  cp "$backup/CHANGELOG.md" CHANGELOG.md
  cp "$backup/mcp-server.json" "$mcp_server"
  rm -rf "$backup"
}
# A preview (or failure) must not leave version bumps behind.
trap restore EXIT
node --input-type=module - "$version" <<'JS'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
for (const dir of readdirSync('packages')) {
  const path = `packages/${dir}/package.json`, pkg = JSON.parse(readFileSync(path));
  if (!pkg.private) { pkg.version = process.argv[2]; writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n'); }
}
const constant = 'packages/api/src/version.ts';
writeFileSync(constant, readFileSync(constant, 'utf8').replace(/VERSION = "[^"]*"/, `VERSION = "${process.argv[2]}"`));
const server = JSON.parse(readFileSync('packages/mcp/server.json', 'utf8'));
server.version = process.argv[2];
for (const pkg of server.packages) pkg.version = process.argv[2];
writeFileSync('packages/mcp/server.json', JSON.stringify(server, null, 2) + '\n');
// What was written under "Unreleased" is what this release carries.
writeFileSync('CHANGELOG.md', readFileSync('CHANGELOG.md', 'utf8').replace(/^## Unreleased$/m, `## ${process.argv[2]}`));
JS
export NODE_USE_ENV_PROXY=1
pnpm build && pnpm test
if [[ $mode == --dry-run ]]; then
  pnpm -r publish --dry-run --no-git-checks
  scripts/verify-packages.sh
elif [[ $mode == --tag-only ]]; then
  git add packages/*/package.json "$api_version" CHANGELOG.md "$mcp_server"
  git commit -m "Release v$version"
  # Tags are created by the release workflow after publishing: a push of main with an
  # unpublished version is the trigger, so this also works where tag pushes are refused.
  git push origin HEAD
  trap - EXIT
  rm -rf "$backup"
else
  pnpm -r --filter './packages/*' publish --access public --no-git-checks
  # The local release owns publication; the tag workflow detects already-published versions.
  git add packages/*/package.json "$api_version" CHANGELOG.md "$mcp_server"
  git commit -m "Release v$version"
  git tag "v$version"
  git push origin "v$version"
  trap - EXIT
  rm -rf "$backup"
fi
