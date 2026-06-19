#!/usr/bin/env node
/**
 * Copy legacy matrix data into omniswim-suite (idempotent).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const suiteRoot = path.join(__dirname, '..');
const legacyRoot = path.join(suiteRoot, '..', 'omniswim_-matrix');

const copies = [
  ['data/meets.json', 'data/meets.json'],
  ['data/scoring_settings.json', 'data/scoring_settings.json'],
  ['data/scoring_presets', 'data/scoring_presets'],
  ['public/OMNISWIMLOGO.png', 'public/OMNISWIMLOGO.png'],
];

let ok = true;
for (const [fromRel, toRel] of copies) {
  const from = path.join(legacyRoot, fromRel);
  const to = path.join(suiteRoot, toRel);
  if (!fs.existsSync(from)) {
    console.warn(`Skip (missing): ${fromRel}`);
    continue;
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.statSync(from).isDirectory()) {
    fs.cpSync(from, to, { recursive: true });
  } else {
    fs.copyFileSync(from, to);
  }
  console.log(`Copied ${fromRel}`);
}

const meetsPath = path.join(suiteRoot, 'data/meets.json');
if (fs.existsSync(meetsPath)) {
  const workspaces = JSON.parse(fs.readFileSync(meetsPath, 'utf-8'));
  if (!Array.isArray(workspaces)) {
    console.error('meets.json is not an array');
    ok = false;
  } else {
    console.log(`Validated ${workspaces.length} workspace(s)`);
  }
} else {
  console.warn('No meets.json after migration');
}

process.exit(ok ? 0 : 1);
