import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const directory = process.argv[2];
if (!directory) throw new Error('Run scripts/verify-packages.sh to generate and verify publish artifacts');
for (const name of readdirSync(directory)) {
  const path = join(directory, name);
  const result = JSON.parse(readFileSync(join(path, 'files.json')))[0];
  const pkg = JSON.parse(readFileSync(join(path, 'manifest.json')));
  const source = JSON.parse(readFileSync(`packages/${name}/package.json`));
  const files = result.files.map(f => f.path);
  console.log(`\n${pkg.name}@${pkg.version} (${files.length} files)\n${files.join('\n')}`);
  if (files.some(f => /(^|\/)(tests?|node_modules|\.verdict[^/]*|\.env[^/]*)(\/|$)|\.sqlite(?:$|[.-])/.test(f))) throw new Error(`Forbidden file in ${pkg.name}`);
  for (const field of ['LICENSE', 'README.md', 'package.json']) if (!files.includes(field)) throw new Error(`Missing ${field}`);
  for (const entry of Object.values(pkg.exports)) {
    if (!entry.types) throw new Error(`Missing export types in ${pkg.name}`);
    for (const target of Object.values(entry)) if (!files.includes(target.replace(/^\.\//, ''))) throw new Error(`Missing export target ${target}`);
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dep, version] of Object.entries(pkg[section] ?? {})) {
      if (version.startsWith('workspace:')) throw new Error(`Unresolved workspace dependency: ${dep}`);
      if (source[section]?.[dep]?.startsWith('workspace:')) console.log(`  publish dependency: ${dep} -> ${version}`);
    }
  }
}
