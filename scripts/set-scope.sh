#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --input-type=module - "$@" <<'JS'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
const scope = (process.argv[2] ?? '').replace(/^@/, '');
if (process.argv.length !== 3 || !/^[a-z0-9][a-z0-9-]*$/.test(scope)) throw new Error('Usage: scripts/set-scope.sh <scope> (e.g. @verdicthq)');
const names = readdirSync('packages').map(p => JSON.parse(readFileSync(`packages/${p}/package.json`)).name.split('/')[0]);
const scopes = new Set(['@verdict', ...names]);
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    if (['node_modules', 'dist', '.git', 'cache', 'LICENSE'].includes(e.name)) return [];
    const path = `${dir}/${e.name}`;
    return e.isDirectory() ? walk(path) : [path];
  });
}
const paths = [...walk('packages'), ...walk('website'), ...walk('docs'), ...walk('examples'), 'README.md', 'AGENTS.md', 'package.json', 'pnpm-lock.yaml'];
for (const path of paths) {
  if (!/\.(?:json|yaml|md|mts|mjs|ts|js|vue)$/.test(path)) continue;
  const before = readFileSync(path, 'utf8');
  let after = before;
  for (const old of scopes) after = after.replaceAll(`${old}/`, `@${scope}/`);
  if (after !== before) { writeFileSync(path, after); console.log(path); }
}
JS
