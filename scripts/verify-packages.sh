#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
pack_dir=$(mktemp -d)
trap 'rm -rf "$pack_dir"' EXIT
for package in packages/*; do
  name=$(basename "$package")
  mkdir "$pack_dir/$name"
  (
    cd "$package"
    npm pack --dry-run --json > "$pack_dir/$name/files.json"
    pnpm pack --pack-destination "$pack_dir/$name"
  )
  tar -xOf "$pack_dir/$name/"*.tgz package/package.json > "$pack_dir/$name/manifest.json"
done
node scripts/verify-packages.mjs "$pack_dir"
