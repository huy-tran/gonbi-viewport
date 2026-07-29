/**
 * Lightweight lint for the shipped source. Deliberately not ESLint: the whole
 * point of this extension is that it has no build step, and the handful of
 * mistakes worth catching here need no type system.
 *
 *   - every file parses
 *   - every relative import resolves to a file that exists
 *   - nothing imports across a boundary that would break at runtime
 *   - no leftover debugging statements
 *   - Prettier would not reformat anything
 *
 * Run: node tools/lint.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const sources = walk(path.join(ROOT, 'src'));

for (const file of sources) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');

  // Parses at all.
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    problems.push(`${rel}: does not parse - ${String(err.stderr).split('\n')[0]}`);
    continue;
  }

  // Relative imports resolve.
  for (const m of text.matchAll(/^\s*import\s[^'"]*['"](\.[^'"]+)['"]/gm)) {
    const target = path.resolve(path.dirname(file), m[1]);
    if (!fs.existsSync(target)) {
      problems.push(`${rel}: imports "${m[1]}" which does not exist`);
    }
  }

  /*
   * Debug leftovers. The lookbehind matters: chrome.debugger is a real API this
   * extension uses, and console.warn/error are legitimate reporting.
   */
  for (const m of text.matchAll(/(?<![.\w])(debugger|console\.log)\b/g)) {
    const line = text.slice(0, m.index).split('\n').length;
    problems.push(`${rel}:${line}: leftover ${m[1]}`);
  }
}

/**
 * The injected script is serialised across a process boundary by
 * chrome.scripting, so anything it closes over is gone by the time it runs.
 */
const inject = fs.readFileSync(path.join(ROOT, 'src/inject/emulate.js'), 'utf8');
const body = inject.slice(inject.indexOf('export function emulateInFrame'));
if (/^\s*import\s/m.test(body)) {
  problems.push(
    'src/inject/emulate.js: the injected function must not import anything',
  );
}

/*
 * Prettier agrees with the checked-in formatting.
 *
 * Invoked as a script through node rather than through npx: on Windows the npx
 * shim hands the globs to cmd, which mangles them, and prettier then exits
 * non-zero having matched nothing.
 */
const prettierBin = path.join(ROOT, 'tools/node_modules/prettier/bin/prettier.cjs');
if (!fs.existsSync(prettierBin)) {
  console.log('prettier not installed, skipping the format check');
} else {
  try {
    execFileSync(
      process.execPath,
      [prettierBin, '--check', 'src/**/*.js', 'src/**/*.css'],
      { cwd: ROOT, stdio: 'pipe' },
    );
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    const files = output
      .split('\n')
      .map((l) => l.replace(/^\[warn\]\s*/, '').trim())
      .filter((l) => l.endsWith('.js') || l.endsWith('.css'));
    problems.push(
      files.length
        ? `prettier would reformat: ${files.slice(0, 8).join(', ')} - run "npm run fix"`
        : `prettier failed: ${output.trim().split('\n').slice(0, 3).join(' / ')}`,
    );
  }
}

console.log(`linted ${sources.length} source file(s)`);
if (problems.length) {
  console.log(`\n${problems.length} problem(s):`);
  for (const p of problems) console.log(`  x ${p}`);
  process.exit(1);
}
console.log('no lint problems');
