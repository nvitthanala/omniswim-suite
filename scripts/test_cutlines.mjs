/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Cutline provenance + lookup regression suite.
 *
 * The spot-check block below is a snapshot of values read off the archived
 * primary-source PDFs. If a governing body revises a standard upstream and
 * someone re-runs scripts/fetch-cutlines.py + extract-cutlines.py, these
 * assertions fail loudly instead of the numbers drifting silently.
 *
 * Every expected value here was verified against the PDF text in
 * data/cutlines/sources/ on 2026-07-26.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  allCutlines,
  cutlineSeasons,
  cutlineSources,
  cutlineTierTimes,
  divisionsWithCutlineData,
  findCutlines,
  getDivingCutlines,
  hasCutlineTable,
  latestSeasonForDivision,
  publishedCutlines,
} from '../packages/core/src/cutlines.ts';
import {
  compareTimeToCutline,
  conversionFactorEventKey,
  courseOfRecordFromEventLabel,
  cutlineEventCategory,
  getCutlinesForSwim,
  isDivingEvent,
  normalizeEventForCutline,
  scyEquivalentForCutline,
} from '../packages/core/src/lib/cutlineUtils.ts';
import { divisionForTeam } from '../packages/core/src/data/teamDivisions.ts';
import { relaySplitQualificationCutEvent } from '../packages/core/src/lib/utils.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  failures += 1;
}

function eq(actual, expected, label) {
  if (actual !== expected) fail(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

function findOne(query, label) {
  const hits = findCutlines(query);
  if (hits.length !== 1) {
    fail(`${label}: expected exactly 1 record, found ${hits.length}`);
    return null;
  }
  return hits[0];
}

/* ------------------------------------------------------------------ */
/* 1. Spot-checks against the published PDFs                           */
/* ------------------------------------------------------------------ */

// --- NCAA D1 2025-26: one STANDARD column for individuals, no A/B split ---
{
  const r = findOne(
    { division: 'D1', season: '2025-2026', gender: 'Men', event: '50 Freestyle', kind: 'individual' },
    'D1 men 50 Free'
  );
  if (r) {
    eq(r.scale, 'single', 'D1 men 50 Free scale');
    eq(r.standard, '19.43', 'D1 men 50 Free standard');
  }
  const w = findOne(
    { division: 'D1', season: '2025-2026', gender: 'Women', event: '50 Freestyle', kind: 'individual' },
    'D1 women 50 Free'
  );
  if (w) eq(w.standard, '22.28', 'D1 women 50 Free standard');

  const mile = findOne(
    { division: 'D1', gender: 'Men', event: '1650 Freestyle', kind: 'individual' },
    'D1 men 1650 Free'
  );
  if (mile) eq(mile.standard, '15:06.60', 'D1 men 1650 Free standard (comma-grouped label)');

  const relay = findOne(
    { division: 'D1', gender: 'Men', event: '200 Medley Relay', kind: 'relay' },
    'D1 men 200 MR'
  );
  if (relay) {
    eq(relay.scale, 'qualifyingProvisional', 'D1 men 200 MR scale');
    eq(relay.qualifying, '1:23.61', 'D1 men 200 MR qualifying');
    eq(relay.provisional, '1:23.85', 'D1 men 200 MR provisional');
  }

  // D1 women publish a 5-dive platform total and no 6-dive platform total.
  const womensPlatform = findCutlines({ division: 'D1', gender: 'Women', kind: 'diving' }).filter(
    d => d.board === 'PLATFORM'
  );
  eq(womensPlatform.length, 1, 'D1 women platform diving variants');
  if (womensPlatform[0]) {
    eq(womensPlatform[0].points, 225, 'D1 women platform points');
    eq(womensPlatform[0].diveCount, 5, 'D1 women platform dive count');
  }
}

// --- NCAA D2 2026-27: A + B individuals, N/A qualifying relay ---
{
  const m = findOne(
    { division: 'D2', season: '2026-2027', gender: 'Men', event: '50 Freestyle', kind: 'individual' },
    'D2 men 50 Free'
  );
  if (m) {
    eq(m.scale, 'ab', 'D2 men 50 Free scale');
    eq(m.aStandard, '19.39', 'D2 men 50 Free A');
    eq(m.bStandard, '20.36', 'D2 men 50 Free B');
  }
  const w = findOne(
    { division: 'D2', season: '2026-2027', gender: 'Women', event: '50 Freestyle', kind: 'individual' },
    'D2 women 50 Free'
  );
  if (w) {
    eq(w.aStandard, '22.48', 'D2 women 50 Free A');
    eq(w.bStandard, '23.60', 'D2 women 50 Free B');
  }
  // 1000 Freestyle exists in D2 but not in D1 — proves the tables are distinct.
  const k = findOne(
    { division: 'D2', gender: 'Men', event: '1000 Freestyle', kind: 'individual' },
    'D2 men 1000 Free'
  );
  if (k) eq(k.aStandard, '8:57.17', 'D2 men 1000 Free A');
  eq(
    findCutlines({ division: 'D1', event: '1000 Freestyle' }).length,
    0,
    'D1 must not publish a 1000 Freestyle'
  );

  const relay = findOne(
    { division: 'D2', gender: 'Men', event: '200 Freestyle Relay', kind: 'relay' },
    'D2 men 200 FR'
  );
  if (relay) {
    eq(relay.scale, 'provisionalOnly', 'D2 men 200 FR scale');
    eq(relay.provisional, '1:19.88', 'D2 men 200 FR provisional');
    eq('qualifying' in relay, false, 'D2 relay must not carry a fabricated qualifying time');
  }

  const dives = getDivingCutlines('Men', 'D2');
  const oneMeterSix = dives.find(d => d.board === '1M' && d.diveCount === 6);
  const oneMeterEleven = dives.find(d => d.board === '1M' && d.diveCount === 11);
  if (!oneMeterSix || !oneMeterEleven) fail('D2 men 1M diving: expected a 6-dive and an 11-dive record');
  else {
    eq(oneMeterSix.points, 285, 'D2 men 1M Dual-6 points');
    eq(oneMeterSix.minimumDegreeOfDifficulty, 14.0, 'D2 men 1M minimum DD');
    eq(oneMeterEleven.points, 440, 'D2 men 1M Championship-11 points');
  }
}

// --- NCAA D3 2026-27: A + B + Invited ---
{
  const m = findOne(
    { division: 'D3', season: '2026-2027', gender: 'Men', event: '50 Freestyle', kind: 'individual' },
    'D3 men 50 Free'
  );
  if (m) {
    eq(m.scale, 'abInvited', 'D3 men 50 Free scale');
    eq(m.aStandard, '19.54', 'D3 men 50 Free A');
    eq(m.bStandard, '20.33', 'D3 men 50 Free B');
    eq(m.invitedStandard, '20.05', 'D3 men 50 Free Invited');
  }
  // Short-form labels in the D3 sheet must normalize to canonical long form.
  const back = findOne(
    { division: 'D3', gender: 'Women', event: '100 Backstroke', kind: 'individual' },
    'D3 women 100 Back'
  );
  if (back) eq(back.aStandard, '53.70', 'D3 women 100 Backstroke A');
  const im = findOne(
    { division: 'D3', gender: 'Men', event: '400 Individual Medley', kind: 'individual' },
    'D3 men 400 IM'
  );
  if (im) eq(im.invitedStandard, '3:54.83', 'D3 men 400 IM Invited');

  const relay = findOne(
    { division: 'D3', gender: 'Men', event: '200 Freestyle Relay', kind: 'relay' },
    'D3 men 200 FR'
  );
  if (relay) {
    eq(relay.scale, 'provisionalInvited', 'D3 men 200 FR scale');
    eq(relay.provisional, '1:21.10', 'D3 men 200 FR provisional');
    eq(relay.invited, '1:20.49', 'D3 men 200 FR invited');
  }
}

// --- NAIA 2026-27: auto + provisional, yards and metres, no relays ---
{
  const scy = findOne(
    { division: 'NAIA', gender: 'Men', event: '50 Freestyle', kind: 'individual', course: 'SCY' },
    'NAIA men 50 Free yards'
  );
  if (scy) {
    eq(scy.aStandard, '19.91', 'NAIA men 50 Free yards automatic');
    eq(scy.bStandard, '21.55', 'NAIA men 50 Free yards provisional');
  }
  const metric = findOne(
    {
      division: 'NAIA',
      gender: 'Men',
      event: '50 Freestyle',
      kind: 'individual',
      course: 'METRIC_UNSPECIFIED',
    },
    'NAIA men 50 Free metres'
  );
  if (metric) {
    eq(metric.aStandard, '22.27', 'NAIA men 50 Free metres automatic');
    eq(metric.bStandard, '24.13', 'NAIA men 50 Free metres provisional');
  }
  // "500/400 FREESTYLE" is 500 yards OR 400 metres — different distances.
  const fiveHundred = findOne(
    { division: 'NAIA', gender: 'Women', event: '500 Freestyle', course: 'SCY' },
    'NAIA women 500 Free yards'
  );
  if (fiveHundred) eq(fiveHundred.aStandard, '5:02.09', 'NAIA women 500 Free yards automatic');
  const fourHundred = findOne(
    { division: 'NAIA', gender: 'Women', event: '400 Freestyle', course: 'METRIC_UNSPECIFIED' },
    'NAIA women 400 Free metres'
  );
  if (fourHundred) eq(fourHundred.aStandard, '4:25.22', 'NAIA women 400 Free metres automatic');
  eq(
    findCutlines({ division: 'NAIA', event: '500 Freestyle', course: 'METRIC_UNSPECIFIED' }).length,
    0,
    'NAIA must not publish a 500 Freestyle in metres'
  );

  // The published file is "...-wo-Relays". Relays are absent, never invented.
  eq(findCutlines({ division: 'NAIA', kind: 'relay' }).length, 0, 'NAIA relay records must be absent');

  const dive = findOne(
    { division: 'NAIA', gender: 'Women', kind: 'diving', event: '1-Meter Diving' },
    'NAIA women 1M diving'
  );
  if (dive) {
    eq(dive.points, 180, 'NAIA women 1M points');
    eq(dive.minimumDegreeOfDifficulty, 10.8, 'NAIA women 1M minimum DD');
    eq(dive.diveCount, 6, 'NAIA women 1M dive count');
  }
}

/* ------------------------------------------------------------------ */
/* 2. Structural invariants                                            */
/* ------------------------------------------------------------------ */

eq(divisionsWithCutlineData().join(','), 'D1,D2,D3,NAIA', 'divisions with data');
eq(cutlineSeasons().join(','), '2026-2027,2025-2026', 'seasons, newest first');
eq(latestSeasonForDivision('D2'), '2026-2027', 'latest D2 season');
eq(latestSeasonForDivision('D1'), '2025-2026', 'latest D1 season');
eq(hasCutlineTable('D2'), true, 'D2 table present');

const entries = publishedCutlines();
if (entries.length < 180) fail(`expected the loaded tables to hold 180+ records, got ${entries.length}`);

for (const e of entries) {
  if (!e.source || !e.source.sha256 || !e.source.url || !e.source.page) {
    fail(`record without full provenance: ${JSON.stringify(e).slice(0, 140)}`);
    break;
  }
  for (const key of Object.keys(e)) {
    if (key.startsWith('proj_') || key === 'time_25_26') {
      fail(`record carries a projection/legacy field ${key}: ${e.division} ${e.event}`);
      break;
    }
  }
}

// Every sha256 referenced by a record must be an archived source in the manifest.
const manifest = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'data/cutlines/sources/manifest.json'), 'utf-8')
);
const archived = new Set(manifest.sources.map(s => s.sha256));
for (const e of entries) {
  if (!archived.has(e.source.sha256)) {
    fail(`record ${e.division} ${e.event} cites sha256 ${e.source.sha256} which is not in the manifest`);
    break;
  }
}
for (const s of cutlineSources()) {
  if (!archived.has(s.sha256)) fail(`data file cites unarchived source ${s.id}`);
}
// The archived bytes must still hash to what the manifest claims, so a swapped
// or truncated PDF cannot quietly back a "verified" number.
for (const s of manifest.sources) {
  const p = path.join(repoRoot, 'data/cutlines/sources', s.filename);
  if (!fs.existsSync(p)) {
    fail(`archived source missing from disk: ${s.filename}`);
    continue;
  }
  const actual = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
  if (actual !== s.sha256) {
    fail(`archived ${s.filename} hashes to ${actual}, manifest claims ${s.sha256}`);
  }
}

// Tier ordering: every published tier list must be strictest-first.
for (const e of entries) {
  if (e.kind === 'diving') continue;
  const tiers = cutlineTierTimes(e);
  if (tiers.length === 0) fail(`${e.division} ${e.gender} ${e.event} publishes no tier at all`);
  for (const t of tiers) {
    if (!/^(?:\d{1,3}:)?\d{1,2}\.\d{2}$/.test(t.time)) {
      fail(`${e.division} ${e.gender} ${e.event} ${t.tier} is not a published time: ${t.time}`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* 3. The live bug: D2 lookups used to return nothing                  */
/* ------------------------------------------------------------------ */

eq(divisionForTeam('Henderson State University'), 'D2', 'HSU resolves to D2');

const hsu = getCutlinesForSwim('Men', '50 Free', 'D2');
eq(hsu.status, 'ok', 'HSU D2 50 Free lookup status');
eq(hsu.season, '2026-2027', 'HSU D2 lookup season');
eq(hsu.aCutSec, 19.39, 'HSU D2 50 Free A seconds');
eq(hsu.bCutSec, 20.36, 'HSU D2 50 Free B seconds');
if (!hsu.aCut || !hsu.bCut) fail('HSU D2 50 Free legacy aCut/bCut rows missing');
if (hsu.aCut) eq(hsu.aCut.time, '19.39', 'HSU D2 legacy aCut.time');
if (hsu.aCut) eq(hsu.aCut.time_25_26, '19.39', 'HSU D2 legacy aCut.time_25_26 compat field');
if (hsu.entry) eq(hsu.entry.source.sourceId, 'ncaa-d2-men-2026-27', 'HSU D2 lookup provenance');

eq(compareTimeToCutline(19.2, 'Men', '50 Free', 'D2').achieved, 'A', 'D2 19.20 is an A cut');
eq(compareTimeToCutline(20.0, 'Men', '50 Free', 'D2').achieved, 'B', 'D2 20.00 is a B cut');
const missed = compareTimeToCutline(25.0, 'Men', '50 Free', 'D2');
eq(missed.achieved, null, 'D2 25.00 achieves nothing');
eq(missed.status, 'ok', 'D2 25.00 status is a real miss, not an absent table');

// A genuine miss must be distinguishable from "we hold no standard".
const noEvent = compareTimeToCutline(300, 'Men', '1000 Freestyle', 'D1');
eq(noEvent.achieved, null, 'D1 1000 Free achieves nothing');
eq(noEvent.status, 'event_not_in_table', 'D1 1000 Free is absent from the table, not a miss');
const noRelay = getCutlinesForSwim('Men', '200 Freestyle Relay', 'NAIA');
eq(noRelay.status, 'event_not_in_table', 'NAIA relays are absent from the source');

/* ------------------------------------------------------------------ */
/* 4. Tier semantics per division                                      */
/* ------------------------------------------------------------------ */

const d1 = getCutlinesForSwim('Men', '50 Freestyle', 'D1');
eq(d1.status, 'ok', 'D1 50 Free status');
eq(d1.aCutSec, 19.43, 'D1 50 Free standard seconds');
eq(d1.bCutSec, 0, 'D1 publishes no individual B cut — absent reads as 0');
eq(d1.tiers.map(t => t.tier).join(','), 'Standard', 'D1 individual tier labels');
eq(compareTimeToCutline(19.4, 'Men', '50 Freestyle', 'D1').tier, 'Standard', 'D1 honest tier label');

const d3 = getCutlinesForSwim('Men', '50 Free', 'D3');
eq(d3.tiers.map(t => t.tier).join(','), 'A,Invited,B', 'D3 tier order is strictest first');
eq(d3.invitedCutSec, 20.05, 'D3 Invited seconds');
eq(compareTimeToCutline(20.02, 'Men', '50 Free', 'D3').tier, 'Invited', 'D3 20.02 makes the Invited cut');
eq(compareTimeToCutline(20.02, 'Men', '50 Free', 'D3').achieved, 'B', 'D3 Invited maps to legacy B slot');
eq(compareTimeToCutline(20.2, 'Men', '50 Free', 'D3').tier, 'B', 'D3 20.20 only makes the B cut');

const naiaMetric = getCutlinesForSwim('Men', '50 Freestyle', 'NAIA', undefined, 'METRIC_UNSPECIFIED');
eq(naiaMetric.aCutSec, 22.27, 'NAIA metric lookup uses the metric column');
eq(getCutlinesForSwim('Men', '50 Freestyle', 'NAIA').aCutSec, 19.91, 'NAIA default lookup is yards');

/* ------------------------------------------------------------------ */
/* 5. Event-name normalization                                         */
/* ------------------------------------------------------------------ */

const normalizations = [
  // --- published-sheet spellings (must keep working) ---
  ['100 Back', '100 Backstroke'],
  ['200 IM', '200 Individual Medley'],
  ['1,650 Freestyle', '1650 Freestyle'],
  ['200 FR', '200 Freestyle Relay'],
  ['400 MR', '400 Medley Relay'],
  ['200 Medley Relay', '200 Medley Relay'],
  ['100 Fly SCY', '100 Butterfly'],
  ['50 Free', '50 Freestyle'],

  // --- HyTek meet-result labels, verbatim from data/meets.json ---
  // The live bug: none of these matched the table, so every badge rendered
  // "unknown" with "does not publish a standard for Event 8 Me...".
  ['Event 8 Men 50 Yard Freestyle', '50 Freestyle'],
  ['Event 15 Men 400 Yard IM', '400 Individual Medley'],
  ['Event 32 Women 1650 Yard Freestyle', '1650 Freestyle'],
  ['Event 3 Women 1000 Yard Freestyle', '1000 Freestyle'],
  ['Event 21 Women 500 Yard Freestyle', '500 Freestyle'],
  // A 3-digit entry number must not be read as the distance.
  ['Event 100 Men 100 Yard Breaststroke Time Trial', '100 Breaststroke'],
  ['Event 201 Men 100 Yard Freestyle Time Trial', '100 Freestyle'],
  // Non-Men/Women gender tokens really occur in the archived meets.
  ['Event 403 Mixed 50 Yard Freestyle Time Trial', '50 Freestyle'],
  ['Event 939 Boys 100 Yard Breaststroke', '100 Breaststroke'],
  ['Event 12 Women 100 Yard Butterfly', '100 Butterfly'],

  // --- relays: meets label by leg, the tables by total distance ---
  ['Event 31 Men 4x50 Yard Freestyle Relay', '200 Freestyle Relay'],
  ['Event 42 Men 4x100 Yard Freestyle Relay', '400 Freestyle Relay'],
  ['Event 1 Women 4x200 Yard Freestyle Relay', '800 Freestyle Relay'],
  ['Event 2 Men 4x200 Yard Freestyle Relay', '800 Freestyle Relay'],
  ['Event 10 Women 4x50 Yard Medley Relay', '200 Medley Relay'],
  ['Event 20 Men 4x100 Yard Medley Relay', '400 Medley Relay'],
  ['Event 202 Women 4x200 Yard Freestyle Relay Time Trial', '800 Freestyle Relay'],
  // Derived (legs x distance), not a lookup table of five known strings.
  ['4 x 50 Meter Medley Relay', '200 Medley Relay'],
  ['4x50 Free', '200 Freestyle Relay'],

  // --- diving keeps its board and never becomes a distance ---
  ['Event 18 Women 3 mtr Diving', '3-Meter Diving'],
  ['Event 40 Women 1 mtr Diving', '1-Meter Diving'],
  ['Event 9 Men 1 mtr Diving', '1-Meter Diving'],
  ['1-Meter Diving', '1-Meter Diving'],
  ['Men Platform Diving', 'Platform Diving'],
];
for (const [input, expected] of normalizations) {
  eq(normalizeEventForCutline(input), expected, `normalizeEventForCutline(${input})`);
}

// Course words are stripped, not just the ones HyTek happens to print.
for (const course of ['Yard', 'Yards', 'Meter', 'Meters', 'Metre', 'Metres']) {
  eq(normalizeEventForCutline(`Men 200 ${course} Backstroke`), '200 Backstroke', `course word ${course}`);
}

/* ------------------------------------------------------------------ */
/* 5b. Diving is points, not seconds — never a swim verdict            */
/* ------------------------------------------------------------------ */

eq(isDivingEvent('Event 18 Women 3 mtr Diving'), true, 'HyTek diving label detected');
eq(isDivingEvent('3-Meter Diving'), true, 'canonical diving label detected');
eq(isDivingEvent('200 Freestyle'), false, 'a swim is not diving');
eq(cutlineEventCategory('Event 40 Women 1 mtr Diving'), 'diving', 'diving category');
eq(cutlineEventCategory('Event 8 Men 50 Yard Freestyle'), 'swim', 'swim category');

{
  const dive = getCutlinesForSwim('Women', 'Event 18 Women 3 mtr Diving', 'D2');
  eq(dive.status, 'not_a_timed_event', 'diving is not judged on a clock');
  eq(dive.eventCategory, 'diving', 'diving lookup carries its category');
  eq(dive.event, '3-Meter Diving', 'diving lookup keeps the board');
  eq(dive.tiers.length, 0, 'diving publishes no time tier');
  eq(dive.aCutSec, 0, 'diving carries no strict seconds');

  // 285.60 is a plausible 6-dive point total. It must not be read as 4:45.60.
  const judged = compareTimeToCutline(285.6, 'Women', 'Event 18 Women 3 mtr Diving', 'D2');
  eq(judged.achieved, null, 'a diving point total achieves no swim cut');
  eq(judged.status, 'not_a_timed_event', 'diving comparison status');
  eq(judged.eventCategory, 'diving', 'diving comparison category');

  // ...and this is emphatically not "D2 publishes nothing for diving".
  if (getDivingCutlines('Women', 'D2').length === 0) {
    fail('D2 women diving standards must still be reachable via getDivingCutlines');
  }
}

/* ------------------------------------------------------------------ */
/* 5c. Every event string in data/meets.json is accounted for          */
/* ------------------------------------------------------------------ */

/**
 * Labels that legitimately have no published D2 standard. Relay-split
 * pseudo-events (25s, 50 stroke splits, 375) and distances D2 does not contest.
 * Force-mapping any of these onto a nearby event would invent a standard.
 */
const D2_EVENTS_WITHOUT_A_PUBLISHED_STANDARD = new Set([
  '25 Backstroke',
  '25 Breaststroke',
  '25 Butterfly',
  '25 Freestyle',
  '50 Backstroke',
  '50 Breaststroke',
  '50 Butterfly',
  '100 Individual Medley',
  '375 Freestyle',
  '400 Freestyle',
  '800 Freestyle',
  '1500 Freestyle',
]);

{
  const meets = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/meets.json'), 'utf-8'));
  const rawEvents = new Set();
  const collect = node => {
    if (Array.isArray(node)) return node.forEach(collect);
    if (!node || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'event' && typeof value === 'string') rawEvents.add(value);
      else collect(value);
    }
  };
  collect(meets);

  if (rawEvents.size < 60) {
    fail(`expected data/meets.json to carry 60+ distinct event labels, got ${rawEvents.size}`);
  }

  const tally = { ok: 0, not_a_timed_event: 0, expected_no_standard: 0 };
  const unaccounted = [];
  for (const raw of [...rawEvents].sort()) {
    const clean = normalizeEventForCutline(raw);
    const status = getCutlinesForSwim('Men', clean, 'D2').status;
    if (status === 'ok') tally.ok += 1;
    else if (status === 'not_a_timed_event') tally.not_a_timed_event += 1;
    else if (D2_EVENTS_WITHOUT_A_PUBLISHED_STANDARD.has(clean)) tally.expected_no_standard += 1;
    else unaccounted.push(`${raw} -> ${clean} (${status})`);
  }
  for (const miss of unaccounted) {
    fail(`meets.json event resolves to no D2 row and is not on the expected-absent list: ${miss}`);
  }
  // The parser must not quietly regress: 'ok' is the count the HyTek fix bought.
  if (tally.ok < 67) fail(`expected 67+ meets.json labels to resolve to a D2 row, got ${tally.ok}`);
  eq(tally.not_a_timed_event, 4, 'meets.json diving labels (1M/3M, both genders)');
  console.log(
    `cutlines: meets.json labels ${rawEvents.size} = ${tally.ok} published, ` +
      `${tally.expected_no_standard} no published standard, ${tally.not_a_timed_event} diving`
  );
}

/* ------------------------------------------------------------------ */
/* 5d. A HyTek label reaches the real D2 numbers end to end            */
/* ------------------------------------------------------------------ */

{
  const live = getCutlinesForSwim('Men', 'Event 8 Men 50 Yard Freestyle', 'D2');
  eq(live.status, 'ok', 'HyTek D2 50 Free lookup status');
  eq(live.event, '50 Freestyle', 'HyTek D2 50 Free normalized event');
  eq(live.eventCategory, 'swim', 'HyTek D2 50 Free category');
  eq(live.aCutSec, 19.39, 'HyTek D2 50 Free A seconds');
  eq(live.bCutSec, 20.36, 'HyTek D2 50 Free B seconds');
  eq(
    compareTimeToCutline(19.2, 'Men', 'Event 8 Men 50 Yard Freestyle', 'D2').achieved,
    'A',
    'HyTek label reaches an A verdict'
  );

  const relay = getCutlinesForSwim('Men', 'Event 2 Men 4x200 Yard Freestyle Relay', 'D2');
  eq(relay.status, 'ok', 'HyTek D2 4x200 FR lookup status');
  eq(relay.event, '800 Freestyle Relay', 'HyTek D2 4x200 FR normalized event');
  if (relay.entry) eq(relay.entry.kind, 'relay', 'HyTek D2 4x200 FR resolves to a relay record');
  // D2 men 800 FR provisional is 6:32.68 = 392.68s; the leg->total mapping has
  // to land on that row, not on the 200 FR row a naive "4x200 -> 200" would hit.
  eq(relay.bCutSec, 392.68, 'HyTek D2 4x200 FR provisional seconds');
  eq(
    compareTimeToCutline(392, 'Men', 'Event 2 Men 4x200 Yard Freestyle Relay', 'D2').tier,
    'Provisional',
    'HyTek relay label reaches a Provisional verdict'
  );

  // Task 3: these stay absent. A near-miss map would be a fabricated standard.
  for (const absent of ['25 Backstroke', '375 Freestyle', '50 Butterfly', '100 Individual Medley']) {
    eq(
      getCutlinesForSwim('Men', absent, 'D2').status,
      'event_not_in_table',
      `${absent} has no published D2 standard and must stay absent`
    );
  }
}

/* ------------------------------------------------------------------ */
/* 6. No competition-time literal may live in TypeScript source        */
/* ------------------------------------------------------------------ */

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}
{
  const target = path.join(repoRoot, 'packages/core/src/cutlines.ts');
  const src = fs.readFileSync(target, 'utf-8');
  const clockLiterals = src.match(/['"]\d{1,3}:\d{2}\.\d{2}['"]/g);
  if (clockLiterals) fail(`cutlines.ts contains competition-time literals: ${clockLiterals.join(', ')}`);
  if (/proj_2[6-9]_2[7-9]/.test(src)) fail('cutlines.ts still references projection columns');
  if (/D1_CUTLINE_ROWS/.test(src)) fail('cutlines.ts still declares the hardcoded D1_CUTLINE_ROWS array');
}
for (const file of walk(path.join(repoRoot, 'packages/core/src'))) {
  const src = fs.readFileSync(file, 'utf-8');
  if (/proj_2[6-9]_2[7-9]/.test(src)) {
    fail(`${path.relative(repoRoot, file)} references a fabricated projection column`);
  }
}

/* ------------------------------------------------------------------ */

eq(
  allCutlines().some(r => r.division === 'D2'),
  true,
  'allCutlines() includes D2 rows (the old D1-only view was the silent-empty bug)'
);

/* ------------------------------------------------------------------ */
/* 11. Course of record is read off a label, never assumed             */
/* ------------------------------------------------------------------ */

for (const [label, expected] of [
  ['Event 8 Men 50 Yard Freestyle', 'SCY'],
  ['200 Yards Backstroke', 'SCY'],
  // "meters" proves it was not yards, but not which pool. LCM and SCM factors
  // differ materially, so the ambiguity is reported, never resolved by guess.
  ['50 Meter Freestyle', 'METRIC_UNSPECIFIED'],
  ['4 x 50 Meter Medley Relay', 'METRIC_UNSPECIFIED'],
  ['200 Backstroke LCM', 'LCM'],
  ['100 Butterfly SCM', 'SCM'],
  // Silent label: the caller decides. `SwimmerResult` has no course field.
  ['50 Freestyle', null],
  // A board height in metres is not a course.
  ['Event 18 Women 3 mtr Diving', null],
]) {
  eq(courseOfRecordFromEventLabel(label), expected, `courseOfRecordFromEventLabel(${label})`);
}

/* ------------------------------------------------------------------ */
/* 12. Conversion refuses where no factor is published                 */
/* ------------------------------------------------------------------ */

// The factor table spells IM short; the cutline tables spell it long.
eq(conversionFactorEventKey('400 Individual Medley'), '400 IM', 'IM long form maps to the factor key');
eq(conversionFactorEventKey('50 Freestyle'), '50 Freestyle', 'published sprint factor');
// convertToSCY resolves a missing 50 stroke onto the published 100 factor.
eq(conversionFactorEventKey('50 Backstroke'), '50 Backstroke', '50 stroke rides the 100 factor');
// Absent, never approximated: convertToSCY would otherwise silently apply the
// 50-Freestyle factor to a 3-minute relay.
eq(conversionFactorEventKey('400 Medley Relay'), null, 'no published relay conversion factor');
eq(conversionFactorEventKey('3-Meter Diving'), null, 'diving has no conversion factor');
eq(conversionFactorEventKey('75 Underwater Freestyle'), null, 'unknown event has no factor');

eq(
  scyEquivalentForCutline('400 Medley Relay', 200, 'Men', 'LCM'),
  null,
  'a metric relay cannot be converted'
);
{
  // Metric distance freestyle changes event identity, not just time.
  const conv = scyEquivalentForCutline('400 Freestyle', 240, 'Men', 'LCM');
  eq(conv?.event, '500 Freestyle', 'LCM 400 Free is judged in the 500 Free yards slot');
  eq(conv?.factorEvent, '400 Freestyle', 'conversion provenance names the factor used');
  eq(conv?.swimCourse, 'LCM', 'converted swim keeps its course of record');
  const same = scyEquivalentForCutline('50 Free', 19.2, 'Men', 'SCY');
  eq(same?.seconds, 19.2, 'an SCY swim converts to itself');
  eq(same?.event, '50 Freestyle', 'an SCY swim still normalizes its event');
}

/* ------------------------------------------------------------------ */
/* 13. relaySplitQualificationCutEvent fires on real HyTek labels      */
/* ------------------------------------------------------------------ */

const backLeg = event => ({ isRelay: true, relayLegStroke: 'back', event });

// The regression: HyTek writes the 400 medley relay as "4x100", which contains
// 100 and no literal 400, so the raw-label test never fired on meet data.
eq(
  relaySplitQualificationCutEvent(backLeg('Event 20 Men 4x100 Yard Medley Relay')),
  '100 Backstroke',
  'HyTek 4x100 medley relay backstroke leadoff qualifies for 100 Backstroke'
);
// The documented fallback: an already-normalized label must keep working.
eq(
  relaySplitQualificationCutEvent(backLeg('400 Medley Relay')),
  '100 Backstroke',
  'already-normalized 400 Medley Relay still qualifies'
);
eq(
  relaySplitQualificationCutEvent(backLeg('Event 20 Men 400 Yard Medley Relay')),
  '100 Backstroke',
  'raw 400 label still qualifies (pre-fix behaviour is a subset)'
);
// 200 medley relay is deliberately not mapped — no table held here publishes a
// 50 Backstroke standard, so there would be nothing to compare against.
eq(
  relaySplitQualificationCutEvent(backLeg('Event 10 Women 4x50 Yard Medley Relay')),
  null,
  '200 medley relay leadoff is not mapped'
);
eq(
  getCutlinesForSwim('Men', '50 Backstroke', 'D2').status,
  'event_not_in_table',
  'D2 publishes no 50 Backstroke standard (why the 200 MR leadoff is unmapped)'
);
eq(
  relaySplitQualificationCutEvent(backLeg('Event 42 Men 4x100 Yard Freestyle Relay')),
  null,
  'a freestyle relay leadoff is not a medley leadoff'
);
eq(
  relaySplitQualificationCutEvent({
    isRelay: true,
    relayLegStroke: 'fly',
    event: 'Event 20 Men 4x100 Yard Medley Relay',
  }),
  null,
  'only the backstroke leg leads off'
);
eq(
  relaySplitQualificationCutEvent({
    isRelay: false,
    relayLegStroke: 'back',
    event: '100 Backstroke',
  }),
  null,
  'an individual swim is not a relay split'
);

if (failures) {
  console.error(`\n${failures} cutline check(s) failed`);
  process.exit(1);
}
console.log('cutlines: all checks passed');
