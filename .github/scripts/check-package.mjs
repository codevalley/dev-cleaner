/**
 * Asserts that the published tarball contains exactly what it should.
 *
 * Run by `.github/workflows/ci.yml` against the output of `npm pack --dry-run --json`:
 *
 *     npm pack --dry-run --json > pack.json
 *     node .github/scripts/check-package.mjs pack.json
 *
 * Three separate questions, because they fail in different directions:
 *
 * 1. **Nothing private ships.** Sources, tests and `docs/superpowers/` are development
 *    scaffolding. `docs/superpowers/` in particular is the design spec and the
 *    implementation plan — useful to a contributor reading the repository, noise inside a
 *    tarball a user installed to reclaim disk space.
 *
 * 2. **Everything the user needs ships.** `dist/cli.js` is the binary; README, LICENSE,
 *    CHANGELOG and the documents in `docs/` are what someone decides with. npm adds README
 *    and LICENSE to the tarball automatically even when `files` does not mention them —
 *    this check exists so that a missing *file on disk* is caught here rather than
 *    discovered on the npm page. `files` ships `docs/*.md`, which is one level deep and
 *    therefore picks up every user-facing document while never reaching
 *    `docs/superpowers/`.
 *
 * 3. **The `files` globs still match what the build emits.** `files` lists
 *    `dist/**\/*.js` and `dist/**\/*.js.map` rather than `dist`, which keeps the 100 kB of
 *    unused `.d.ts` declarations out of a package that exports no library API — but a glob
 *    is a claim about the build's output, and a build that started emitting anything else
 *    would silently drop it. So every non-declaration file the build actually produced is
 *    required to be in the tarball. This is the check that would notice.
 */

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

const REQUIRED = [
  'dist/cli.js',
  'package.json',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/VERSIONING.md',
];

const FORBIDDEN_PREFIXES = ['src/', 'tests/', 'docs/superpowers/', '.github/'];

const problems = [];
const fail = (message) => problems.push(message);

const packPath = process.argv[2];
if (packPath === undefined) {
  console.error('usage: check-package.mjs <npm-pack-json>');
  process.exit(2);
}

const report = JSON.parse(readFileSync(packPath, 'utf8'));
const entry = Array.isArray(report) ? report[0] : report;
const shipped = entry.files.map((file) => file.path);
const shippedSet = new Set(shipped);

// 1. Nothing private.
for (const file of shipped) {
  if (FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix))) {
    fail(`ships development scaffolding: ${file}`);
  }
  if (file.endsWith('.ts')) {
    fail(`ships a TypeScript file: ${file} (no library API is published, so no .d.ts either)`);
  }
}

// 2. Everything the user needs.
for (const file of REQUIRED) {
  if (!shippedSet.has(file)) {
    fail(`missing ${file} — the file must exist in the repository root`);
  }
}

// 3. The globs still cover the build output. `npm pack` has already run `prepack`, so
//    dist/ on disk is exactly the build this tarball was made from.
const walk = (dir) => {
  const out = [];
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else if (item.isFile()) out.push(full);
  }
  return out;
};

for (const built of walk('dist')) {
  const asPosix = built.split(path.sep).join('/');
  if (asPosix.endsWith('.d.ts')) continue; // deliberately excluded
  if (!shippedSet.has(asPosix)) {
    fail(`the build emitted ${asPosix} but the "files" globs in package.json do not ship it`);
  }
}

console.log(`tarball: ${shipped.length} files, ${entry.size} bytes packed, ${entry.unpackedSize} unpacked`);
for (const file of shipped) console.log(`  ${file}`);

if (problems.length > 0) {
  console.error('\npackaging check failed:');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log('\npackaging check passed');
