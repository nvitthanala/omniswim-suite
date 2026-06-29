/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verifies app source does not import ResponsiveContainer and production
 * bundles do not embed the SizedChart wrapper pattern (stale-chart guard).
 */
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..');
const sourceRoots = ['packages', 'apps'];

const forbiddenInSource = [
  /from\s+['"]recharts['"].*ResponsiveContainer/,
  /ResponsiveContainer\s*[,}]/,
  /SizedChart/,
];

let failures = 0;

for (const root of sourceRoots) {
  const dir = join(repoRoot, root);
  if (!existsSync(dir)) continue;
  const files = execSync(`git ls-files "${root}"`, { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(f => /\.(tsx?|jsx?)$/.test(f));
  for (const rel of files) {
    const text = readFileSync(join(repoRoot, rel), 'utf8');
    if (rel.includes('node_modules')) continue;
    for (const pattern of forbiddenInSource) {
      if (pattern.test(text) && !rel.includes('test_') && !rel.includes('.spec.')) {
        // Allow comments/docs mentioning ResponsiveContainer
        const codeLines = text.split('\n').filter(l => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
        const code = codeLines.join('\n');
        if (pattern.test(code)) {
          console.error(`FAIL  ${rel}: matches forbidden pattern ${pattern}`);
          failures += 1;
        }
      }
    }
  }
}

// Single recharts version across workspaces
const ls = execSync('npm ls recharts --all', { cwd: repoRoot, encoding: 'utf8' });
const versions = [...ls.matchAll(/recharts@(\d+\.\d+\.\d+)/g)].map(m => m[1]);
const unique = [...new Set(versions)];
if (unique.length !== 1) {
  console.error(`FAIL  expected one recharts version, got: ${unique.join(', ')}`);
  failures += 1;
} else {
  console.log(`OK    recharts@${unique[0]} (single version)`);
}

const distDir = join(repoRoot, 'dist', 'assets');
if (existsSync(distDir)) {
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(join(distDir, file), 'utf8');
    if (file.includes('applet-matrix') && text.includes('SizedChart')) {
      console.error(`FAIL  dist/${file} still references SizedChart`);
      failures += 1;
    }
  }
  console.log('OK    dist/ bundle scan (SizedChart absent from applet-matrix)');
} else {
  console.log('SKIP  dist/ not built — run npm run build for full bundle scan');
}

if (failures > 0) {
  console.error(`\nchart bundle guard FAILED (${failures} issues)`);
  process.exit(1);
}

console.log('\nchart bundle guard passed');
