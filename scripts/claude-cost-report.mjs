#!/usr/bin/env node
/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Price one Claude Code session from its own transcripts, per model.
 *
 * Why this exists: a cloud agent's final result reports one total token count. It cannot be priced
 * from that, because input, output, cache write and cache read cost different amounts and each
 * model has its own rates. Every request in a transcript carries its own `usage` block. This script
 * sums those blocks per model and prices them, so a budget can be enforced against real cost.
 *
 * Usage:
 *   node scripts/claude-cost-report.mjs --since 2026-10-05T14:00:00Z [--until ISO] [--root DIR] [--json]
 *
 * Reads every `*.jsonl` under `--root` (default `~/.claude/projects`), subagent transcripts
 * included. Read-only, no network.
 *
 * Rates are USD per million tokens, from the Claude API model table cached 2026-09-25 (the
 * `claude-api` skill). Cache writes are priced at 1.25x input (5-minute TTL) and 2x input (1-hour
 * TTL); cache reads at the listed read rate. If the transcript gives only a combined cache-write
 * count, it is priced at the 5-minute rate. Treat the total as an estimate to within a few percent:
 * the rates are the published list prices, not an invoice. A model with no rate is listed as
 * UNPRICED and is not added to the total, so the total is a floor in that case.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** USD per million tokens. `read` is the cache-read rate. */
export const RATES = {
  'claude-fable-5-1': { input: 10, output: 50, read: 0.25 },
  'claude-fable-5': { input: 10, output: 50, read: 0.25 },
  'claude-opus-5-5': { input: 4, output: 20, read: 0.2 },
  'claude-opus-5': { input: 5, output: 25, read: 0.5 },
  'claude-opus-4-8': { input: 5, output: 25, read: 0.5 },
  'claude-sonnet-5-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-5': { input: 2, output: 10, read: 0.2 },
  'claude-sonnet-4-6': { input: 3, output: 15, read: 0.3 },
  'claude-haiku-4-5': { input: 1, output: 5, read: 0.1 },
};

export function rateFor(model) {
  if (RATES[model]) return RATES[model];
  // Dated snapshot ids such as claude-haiku-4-5-20251001.
  const hit = Object.keys(RATES)
    .sort((a, b) => b.length - a.length)
    .find((key) => model.startsWith(`${key}-`));
  return hit ? RATES[hit] : undefined;
}

const M = 1_000_000;

/** USD for one usage block. */
export function priceUsage(rate, u) {
  const create5m = u.cacheCreate5m ?? u.cacheCreate ?? 0;
  const create1h = u.cacheCreate1h ?? 0;
  return (
    (u.input * rate.input +
      u.output * rate.output +
      u.cacheRead * rate.read +
      create5m * rate.input * 1.25 +
      create1h * rate.input * 2) /
    M
  );
}

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) yield path;
  }
}

/** Every priced-or-not usage block in the window, deduplicated by request id. */
function* usageEntries({ root, since, until }) {
  const seen = new Set();
  for (const file of walk(root)) {
    if (statSync(file).mtimeMs < since - 3_600_000) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.includes('"usage"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = entry?.message?.usage;
      const stamp = Date.parse(entry?.timestamp ?? '');
      if (!usage || Number.isNaN(stamp) || stamp < since || stamp > until) continue;
      const model = entry.message.model ?? 'unknown';
      if (model === '<synthetic>') continue;
      // A resumed or forked transcript can repeat a request. Count each request id once.
      const id = entry.requestId ?? entry.message?.id;
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      yield { model, usage };
    }
  }
}

function addUsage(row, usage) {
  const cc = usage.cache_creation;
  row.requests += 1;
  row.input += usage.input_tokens ?? 0;
  row.output += usage.output_tokens ?? 0;
  row.cacheRead += usage.cache_read_input_tokens ?? 0;
  if (cc && typeof cc === 'object') {
    row.cacheCreate5m += cc.ephemeral_5m_input_tokens ?? 0;
    row.cacheCreate1h += cc.ephemeral_1h_input_tokens ?? 0;
  } else {
    row.cacheCreate5m += usage.cache_creation_input_tokens ?? 0;
  }
}

export function summarize(window) {
  const byModel = new Map();
  for (const { model, usage } of usageEntries(window)) {
    const row = byModel.get(model) ?? { requests: 0, input: 0, output: 0, cacheCreate5m: 0, cacheCreate1h: 0, cacheRead: 0 };
    addUsage(row, usage);
    byModel.set(model, row);
  }
  let total = 0;
  const models = [];
  for (const [model, row] of byModel) {
    const rate = rateFor(model);
    const usd = rate ? priceUsage(rate, row) : undefined;
    if (usd !== undefined) total += usd;
    models.push({ model, ...row, usd, priced: usd !== undefined });
  }
  models.sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0));
  return { totalUsd: total, models, unpriced: models.filter((m) => !m.priced).map((m) => m.model) };
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const since = Date.parse(get('--since') ?? '');
  if (Number.isNaN(since)) {
    console.error('claude-cost-report: pass --since <ISO time>, e.g. --since 2026-10-05T14:00:00Z');
    process.exit(2);
  }
  const until = get('--until') ? Date.parse(get('--until')) : Date.now();
  const root = get('--root') ?? join(homedir(), '.claude', 'projects');
  const result = { since: new Date(since).toISOString(), until: new Date(until).toISOString(), ...summarize({ root, since, until }) };
  if (args.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Session cost ${result.since} to ${result.until} (list-price estimate, USD)`);
  for (const m of result.models) {
    const cost = m.priced ? `$${m.usd.toFixed(2)}` : 'UNPRICED';
    console.log(
      `  ${m.model}: ${m.requests} req | in ${m.input.toLocaleString()} | out ${m.output.toLocaleString()} | ` +
        `cache write ${(m.cacheCreate5m + m.cacheCreate1h).toLocaleString()} | cache read ${m.cacheRead.toLocaleString()} | ${cost}`,
    );
  }
  console.log(`TOTAL: $${result.totalUsd.toFixed(2)}${result.unpriced.length ? ` (floor: unpriced ${result.unpriced.join(', ')})` : ''}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
