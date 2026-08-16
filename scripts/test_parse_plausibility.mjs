/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guards the SwimCloud paste boundary against events that are not swimming events.
 *
 * The defect: both live workspaces held a `375 Freestyle` personal best, parsed
 * from the real SwimCloud row
 *
 *     375 Free SCY\t3:47.04\tR\t61st Annual Hendrix Relays\tOct 25, 2024
 *
 * 375 yards is not swum at any level of the sport. The parser accepted it because
 * the event column merely had to begin with a number and a stroke, so a
 * novelty-relay artefact entered history looking like a real personal best — the
 * "plausible fabrication" failure mode, which never throws.
 *
 * The far more expensive way to fix that is to over-reject. `50 Butterfly` (126
 * rows), `100 Individual Medley` (44) and the 25s (22) are all real races that the
 * NSISC simply does not contest, and every one of them is in these athletes'
 * age-group history. So the bulk of this file is the anti-over-rejection proof:
 * the full distinct-event census of the live DB, minus the one artefact, must
 * survive the gate untouched.
 *
 * Test: npx tsx scripts/test_parse_plausibility.mjs
 */
import assert from 'node:assert/strict';
import {
  implausibleSwimRowWarning,
  isPlausibleSwimEvent,
  normalizeEventLabel,
  parseSwimCloudPasteDetailed,
  parseSwimCloudPersonalBests,
  parseSwimCloudPersonalBestsDetailed,
  parseSwimCloudRosterPaste,
  parseSwimCloudRosterPasteDetailed,
  swimEventDistance,
  SANCTIONED_SWIM_DISTANCES,
} from '../packages/core/src/lib/athleteHistory.ts';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile.ts';
import { Gender } from '../packages/core/src/types.ts';

const TEAM = 'Henderson State University';
const HDR = 'Event\tTime\t\tMeet\tDate\tStamp Link';
const MEN = Gender.MEN;

/**
 * The exact raw row that produced the phantom event, lifted from
 * `hsuroster26-27.txt` line 112. Kept verbatim so upstream drift is visible.
 */
const BAD_ROW = '375 Free SCY\t3:47.04\tR\t61st Annual Hendrix Relays\tOct 25, 2024';

/**
 * Snapshot of every distinct `athleteHistory` event in the two live workspaces
 * (Blank Workspace 1, HSU 2026-27 Roster Plan) as of 2026-08-15, EXCLUDING the
 * `375 Freestyle` artefact. Counts are the live totals across both workspaces.
 * Every one of these must keep parsing; if this list stops matching what the
 * workspaces hold, that is a finding, not a test to relax.
 */
const LEGITIMATE_LIVE_EVENTS = [
  ['50 Freestyle', 132],
  ['100 Freestyle', 130],
  ['200 Freestyle', 126],
  ['50 Butterfly', 126],
  ['100 Butterfly', 110],
  ['200 Individual Medley', 106],
  ['50 Backstroke', 104],
  ['100 Breaststroke', 102],
  ['50 Breaststroke', 102],
  ['100 Backstroke', 100],
  ['400 Individual Medley', 84],
  ['200 Breaststroke', 82],
  ['200 Backstroke', 74],
  ['200 Butterfly', 70],
  ['400 Freestyle', 52],
  ['100 Individual Medley', 44],
  ['500 Freestyle', 42],
  ['1500 Freestyle', 36],
  ['800 Freestyle', 36],
  ['1000 Freestyle', 30],
  ['1650 Freestyle', 28],
  ['25 Freestyle', 10],
  ['25 Backstroke', 6],
  ['25 Butterfly', 6],
  ['25 Breaststroke', 2],
];

/** SwimCloud-shaped raw labels for the same events, as they appear in the paste. */
const LEGITIMATE_RAW_LABELS = [
  '50 Free SCY', '100 Free SCY', '200 Free SCY', '500 Free SCY', '1000 Free SCY', '1650 Free SCY',
  '50 Fly SCY', '100 Fly SCY', '200 Fly SCY',
  '50 Back SCY', '100 Back SCY', '200 Back SCY',
  '50 Breast SCY', '100 Breast SCY', '200 Breast SCY',
  '100 IM SCY', '200 IM SCY', '400 IM SCY',
  '400 Free LCM', '800 Free LCM', '1500 Free LCM',
  '25 Free SCY', '25 Back SCY', '25 Fly SCY', '25 Breast SCY',
];

const isPlausibilityWarning = w => /is not a swimming event/.test(w);

// --- 1. The predicate itself: narrow, and diving-exempt ----------------------
{
  // The one artefact.
  assert.equal(isPlausibleSwimEvent('375 Freestyle'), false, '375 is not a swimming distance');
  assert.equal(swimEventDistance('375 Freestyle'), 375);

  // Every sanctioned distance is accepted, in every stroke spelling.
  assert.deepEqual(
    [...SANCTIONED_SWIM_DISTANCES].sort((a, b) => a - b),
    [25, 50, 100, 200, 400, 500, 800, 1000, 1500, 1650],
    'the sanctioned distance list is the published one, not a familiar-events list'
  );
  for (const d of SANCTIONED_SWIM_DISTANCES) {
    assert.ok(isPlausibleSwimEvent(`${d} Freestyle`), `${d} Freestyle must pass`);
  }

  // Other impossible distances, for contrast — the gate is not a 375 special case.
  for (const bad of ['375 Freestyle', '75 Freestyle', '150 Butterfly', '3 Freestyle', '1275 Freestyle']) {
    assert.equal(isPlausibleSwimEvent(bad), false, `${bad} must be rejected`);
  }

  // Diving is exempt outright: its leading number is a BOARD HEIGHT, not a distance.
  // A leading-integer distance test would read 1 and 3, find neither sanctioned,
  // and throw out every dive on the board.
  for (const dive of ['1 mtr Diving', '3 mtr Diving', 'Platform Diving', '1 Meter Diving', '3 Meter Diving', '1 Diving']) {
    assert.ok(isPlausibleSwimEvent(dive), `${dive} must never be rejected by a DISTANCE filter`);
  }
  assert.equal(swimEventDistance('1 mtr Diving'), 1, 'the board height IS read as a leading integer…');
  assert.equal(isPlausibleSwimEvent('1 mtr Diving'), true, '…and is precisely why diving is checked first');
  assert.equal(swimEventDistance('Platform Diving'), null, 'no leading number at all');

  // A label with no readable distance is not provably impossible, so it passes.
  assert.ok(isPlausibleSwimEvent('Freestyle'), 'unreadable label is not a rejection');
  assert.ok(isPlausibleSwimEvent(''), 'empty label is not a rejection');

  // Relays: sanctioned relay distances pass, an impossible one does not.
  for (const relay of ['200 Freestyle Relay', '400 Freestyle Relay', '800 Freestyle Relay', '200 Medley Relay', '400 Medley Relay']) {
    assert.ok(isPlausibleSwimEvent(relay), `${relay} must pass`);
  }
  assert.equal(isPlausibleSwimEvent('375 Freestyle Relay'), false);
}

// --- 2. Anti-over-rejection: the whole live census still parses --------------
{
  for (const [event] of LEGITIMATE_LIVE_EVENTS) {
    assert.ok(
      isPlausibleSwimEvent(event),
      `${event} is a real event in the live DB and must not be rejected`
    );
  }

  // …and end-to-end through the real parser, from SwimCloud-shaped raw labels.
  const rows = LEGITIMATE_RAW_LABELS.map((label, i) => `${label}\t1:0${i % 10}.11\t\tMeet\tFeb 1, 2026\t`);
  const paste = ['Colton Bennett', HDR, ...rows].join('\n');
  const parsed = parseSwimCloudPersonalBestsDetailed(paste, 'Colton Bennett', TEAM, MEN);

  assert.equal(parsed.rejected.length, 0, 'no legitimate row may be rejected');
  assert.equal(parsed.swims.length, LEGITIMATE_RAW_LABELS.length, 'every legitimate row survives');

  const parsedEvents = new Set(parsed.swims.map(s => s.event));
  for (const [event] of LEGITIMATE_LIVE_EVENTS) {
    assert.ok(parsedEvents.has(event), `${event} must still parse out of a paste`);
  }
  // Specifically the events the brief flags as easy to over-reject.
  for (const event of [
    '50 Butterfly', '50 Backstroke', '50 Breaststroke',
    '400 Freestyle', '800 Freestyle', '1500 Freestyle',
    '100 Individual Medley',
    '25 Freestyle', '25 Backstroke', '25 Butterfly', '25 Breaststroke',
  ]) {
    assert.ok(parsedEvents.has(event), `${event} is legitimate and must survive the gate`);
  }
}

// --- 3. The bug: 375 Freestyle is dropped, and says so ----------------------
{
  const paste = [
    'Colton Bennett',
    HDR,
    BAD_ROW,
    '500 Free SCY\t4:33.41\t\tNew South Championships\tFeb 20, 2026\t',
  ].join('\n');

  const result = parseSwimCloudPasteDetailed(paste, {
    team: TEAM,
    gender: MEN,
    swimmerName: 'Colton Bennett',
  });

  assert.ok(
    !result.swims.some(s => s.event === '375 Freestyle'),
    'no 375 Freestyle may reach the store'
  );
  assert.ok(!result.swims.some(s => swimEventDistance(s.event) === 375));
  assert.ok(result.swims.some(s => s.event === '500 Freestyle'), 'the good row on the same paste survives');

  // Rejection is REPORTED, not silent — and the warning names the raw row so an
  // operator can find it in the source rather than discovering a phantom event
  // weeks later.
  const hits = result.warnings.filter(isPlausibilityWarning);
  assert.equal(hits.length, 1, 'exactly one warning for one rejected row');
  assert.ok(hits[0].includes(BAD_ROW), 'the warning quotes the offending raw row verbatim');
  assert.ok(hits[0].includes('375 Freestyle'), 'the warning names the event');
  assert.ok(hits[0].includes('375 is not a swimming distance'), 'the warning states why');

  // Warning shape is unchanged: still a flat string[] the panels can render.
  assert.ok(Array.isArray(result.warnings));
  assert.ok(result.warnings.every(w => typeof w === 'string'));

  // The non-detailed export filters identically; it just cannot report.
  const plain = parseSwimCloudPersonalBests(paste, 'Colton Bennett', TEAM, MEN);
  assert.ok(!plain.some(s => s.event === '375 Freestyle'));
  assert.equal(plain.length, 1);
}

// --- 4. One bad row does not discard the good ones -------------------------
{
  const good = LEGITIMATE_RAW_LABELS.map((label, i) => `${label}\t1:0${i % 10}.11\t\tMeet\tFeb 1, 2026\t`);
  const rows = [
    good[0],
    BAD_ROW,
    ...good.slice(1, 12),
    '150 Fly SCY\t1:22.00\t\tMeet\tFeb 1, 2026\t', // second impossible distance
    ...good.slice(12),
  ];
  const paste = ['Colton Bennett', HDR, ...rows].join('\n');
  const parsed = parseSwimCloudPersonalBestsDetailed(paste, 'Colton Bennett', TEAM, MEN);

  assert.equal(parsed.swims.length, good.length, 'all good rows survive');
  assert.equal(parsed.rejected.length, 2, 'both bad rows dropped');
  assert.deepEqual(
    parsed.rejected.map(r => r.event).sort(),
    ['150 Butterfly', '375 Freestyle']
  );
  assert.deepEqual(parsed.rejected.map(r => r.distance).sort((a, b) => a - b), [150, 375]);
  assert.ok(!parsed.swims.some(s => s.event === '375 Freestyle'));
  assert.ok(!parsed.swims.some(s => s.event === '150 Butterfly'));

  // --- 5. Warning count == rejected row count ------------------------------
  const result = parseSwimCloudPasteDetailed(paste, {
    team: TEAM,
    gender: MEN,
    swimmerName: 'Colton Bennett',
  });
  const hits = result.warnings.filter(isPlausibilityWarning);
  assert.equal(hits.length, parsed.rejected.length, 'one warning per rejected row, no aggregation');
  assert.ok(hits.some(w => w.includes(BAD_ROW)));
  assert.ok(hits.some(w => w.includes('150 Fly SCY')));
  // A malformed row must not be fatal to the paste.
  assert.equal(result.swims.length, good.length);
}

// --- 6. Diving rows are untouched by the distance gate ---------------------
{
  // `1 Diving` is the diving label the personal-bests event tokenizer actually
  // accepts, so it is the one that reaches the gate. Its distance reads as 1,
  // which is NOT sanctioned — it survives only because diving is checked first.
  const paste = [
    'Diver Dan',
    HDR,
    '1 Diving\t99.99\t\tDual Meet\tOct 25, 2024\t',
    '500 Free SCY\t4:33.41\t\tNew South Championships\tFeb 20, 2026\t',
  ].join('\n');
  const parsed = parseSwimCloudPersonalBestsDetailed(paste, 'Diver Dan', TEAM, MEN);
  assert.equal(parsed.rejected.length, 0, 'a diving row is never a distance rejection');
  assert.ok(parsed.swims.some(s => s.event === '1 Diving'), 'the diving row still parses');

  // The board-height and platform labels do not tokenize as events at all (they
  // never did) — the point here is that the gate adds no rejection for them.
  const boards = [
    'Diver Dan',
    HDR,
    '1 mtr Diving\t245.60\t\tDual Meet\tOct 25, 2024',
    '3 mtr Diving\t312.05\t\tDual Meet\tOct 25, 2024',
    'Platform Diving\t280.10\t\tDual Meet\tOct 25, 2024',
    // Real row from hsuroster26-27.txt line 628 — a Hendrix Relays novelty label.
    '75 M Diving SCY\t1:03.81\tR\t61st Annual Hendrix Relays\tOct 25, 2024',
    '500 Free SCY\t4:33.41\t\tNew South Championships\tFeb 20, 2026\t',
  ].join('\n');
  const boardParsed = parseSwimCloudPersonalBestsDetailed(boards, 'Diver Dan', TEAM, MEN);
  assert.equal(boardParsed.rejected.length, 0, 'no diving label is rejected on distance');
  assert.ok(boardParsed.swims.some(s => s.event === '500 Freestyle'));

  const detailed = parseSwimCloudPasteDetailed(boards, { team: TEAM, gender: MEN, swimmerName: 'Diver Dan' });
  assert.equal(detailed.warnings.filter(isPlausibilityWarning).length, 0, 'no diving warning');
}

// --- 7. The roster-paste funnel is gated the same way ----------------------
{
  const rows = [
    'Colton Bennett\t375 Freestyle\t3:47.04',
    'Colton Bennett\t500 Freestyle\t4:33.41',
    'Ava Reed\t50 Butterfly\t26.10',
    'Ava Reed\t25 Breaststroke\t16.44',
    'Ava Reed\t100 Individual Medley\t1:01.20',
  ];
  const parsed = parseSwimCloudRosterPasteDetailed(rows.join('\n'), TEAM, MEN);
  assert.equal(parsed.rejected.length, 1);
  assert.equal(parsed.rejected[0].event, '375 Freestyle');
  assert.ok(parsed.rejected[0].raw.includes('375 Freestyle'), 'names the raw row');
  assert.equal(parsed.swims.length, 4, 'every legitimate roster row survives');
  assert.ok(!parsed.swims.some(s => s.event === '375 Freestyle'));
  for (const event of ['500 Freestyle', '50 Butterfly', '25 Breaststroke', '100 Individual Medley']) {
    assert.ok(parsed.swims.some(s => s.event === event), `${event} must survive`);
  }

  assert.equal(parseSwimCloudRosterPaste(rows.join('\n'), TEAM, MEN).length, 4);

  const detailed = parseSwimCloudPasteDetailed(rows.join('\n'), { team: TEAM, gender: MEN, format: 'roster' });
  assert.equal(detailed.warnings.filter(isPlausibilityWarning).length, 1);
  assert.ok(detailed.warnings.some(w => w.includes('375 Freestyle')));
}

// --- 8. The multi-profile funnel is gated, and reports per block -----------
{
  const paste = [
    'Colton Bennett',
    HDR,
    BAD_ROW,
    '500 Free SCY\t4:33.41\t\tNew South Championships\tFeb 20, 2026\t',
    '1650 Free SCY\t16:01.49\t\tNew South Championships\tFeb 24, 2024\t',
    '',
    'Mate Hosszu',
    HDR,
    '50 Fly SCY\t23.14\t\tLittle Rock Fall Invite\tOct 10, 2025\t',
    '100 IM SCY\t52.00\t\tMeet A\tFeb 1, 2026\t',
    '',
    'Ghost Relay',
    HDR,
    // A block whose ONLY row is implausible must still say why, not just
    // "no swims parsed".
    '375 Free SCY\t3:59.99\tR\t61st Annual Hendrix Relays\tOct 25, 2024',
  ].join('\n');

  const multi = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: MEN });
  assert.equal(multi.rejected.length, 2, 'both blocks report their rejected row');
  assert.ok(multi.rejected.every(r => r.event === '375 Freestyle'));
  assert.equal(multi.warnings.filter(isPlausibilityWarning).length, 2);
  assert.ok(multi.warnings.some(w => /Ghost Relay/.test(w)), 'the emptied block is still reported');

  const bennett = multi.athletes.find(a => a.name === 'Colton Bennett');
  assert.ok(bennett, 'Colton Bennett still parses');
  assert.equal(bennett.swims.length, 2, 'his two real swims survive');
  assert.ok(!bennett.swims.some(s => s.event === '375 Freestyle'));

  const mate = multi.athletes.find(a => a.name === 'Mate Hosszu');
  assert.ok(mate && mate.swims.length === 2, '50 Butterfly and 100 IM both survive');
  assert.ok(mate.swims.some(s => s.event === '50 Butterfly'));
  assert.ok(mate.swims.some(s => s.event === '100 Individual Medley'));

  const detailed = parseSwimCloudPasteDetailed(paste, { team: TEAM, gender: MEN });
  assert.equal(detailed.format, 'multi_profile');
  assert.equal(detailed.warnings.filter(isPlausibilityWarning).length, 2, 'warnings survive the routing');
  assert.ok(detailed.warnings.some(w => w.includes(BAD_ROW)));
  assert.ok(!detailed.swims.some(s => s.event === '375 Freestyle'));
  assert.equal(detailed.swims.length, 4);
}

// --- 9. Warning text is stable and self-explaining --------------------------
{
  const text = implausibleSwimRowWarning({ raw: BAD_ROW, event: '375 Freestyle', distance: 375 });
  assert.ok(text.includes('375 Freestyle'));
  assert.ok(text.includes('375 is not a swimming distance'));
  assert.ok(text.includes('25/50/100/200/400/500/800/1000/1500/1650'));
  assert.ok(text.includes(BAD_ROW), 'always names the raw row');
  assert.equal(typeof text, 'string');

  assert.ok(normalizeEventLabel('375 Free SCY') === '375 Freestyle', 'gate reads the STORED label');
}

console.log('parse plausibility: all assertions passed');
