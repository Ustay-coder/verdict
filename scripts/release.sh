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
for package in packages/*; do cp "$package/package.json" "$backup/$(basename "$package").json"; done
restore() {
  for package in packages/*; do cp "$backup/$(basename "$package").json" "$package/package.json"; done
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
JS
export NODE_USE_ENV_PROXY=1
pnpm build && pnpm test
if [[ $mode == --dry-run ]]; then
  pnpm -r publish --dry-run --no-git-checks
  scripts/verify-packages.sh
elif [[ $mode == --tag-only ]]; then
  git add packages/*/package.json
  git commit -m "Release v$version"
  # Tags are created by the release workflow after publishing: a push of main with an
  # unpublished version is the trigger, so this also works where tag pushes are refused.
  git push origin HEAD
  trap - EXIT
  rm -rf "$backup"
else
  pnpm -r --filter './packages/*' publish --access public --no-git-checks
  # The local release owns publication; the tag workflow detects already-published versions.
  git add packages/*/package.json
  git commit -m "Release v$version"
  git tag "v$version"
  git push origin "v$version"
  trap - EXIT
  rm -rf "$backup"
fi
