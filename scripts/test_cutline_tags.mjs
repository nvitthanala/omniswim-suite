/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Division resolution + derived cut-tag regression suite.
 *
 * Three failure modes are pinned here, all of which are silent in production:
 *
 *  1. An unmapped team resolving to D1 and being scored against the wrong
 *     qualifying table.
 *  2. "We could not judge this swim" rendering identically to "this swim missed
 *     the cut".
 *  3. An anachronistic tag: a swim from a program that was discontinued years
 *     before the only seasons we hold tables for, badged with confidence anyway.
 *     Lindenwood last swam 2023-24 and was D1 by then, yet the map said D2.
 *  4. A tag for a team the school does not field. UWF sponsors women's swimming
 *     & diving only, but school-level `status: 'active'` answered "yes" for a
 *     men's swim too, so it was judged against the D2 men's table.
 *
 * The only competition values referenced are the two 50-Freestyle D2 standards
 * already snapshotted in scripts/test_cutlines.mjs; the swim times used as
 * inputs are synthetic probes, not published data.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  divisionForTeam,
  divisionForTeamInSeason,
  divisionForTeamOrDefault,
  divisionForTeamOrNull,
  knownTeamDivisions,
  programCompetedInSeason,
  programSponsorsGender,
  resolveMeetDivisions,
  resolveTeamDivision,
  teamSeasonStartYear,
} from '../packages/core/src/data/teamDivisions.ts';
import {
  buildCutlineTag,
  buildCutlineTagForTeam,
  buildRelaySwimTags,
  buildRelaySwimTagsForTeam,
  cutlineTagRenderMode,
  isCutlineTagConclusive,
} from '../packages/core/src/lib/cutlineTags.ts';
import { relaySplitQualificationCutEvent } from '../packages/core/src/lib/utils.ts';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function fail(msg) {
  console.error(`FAIL ${msg}`);
  failures += 1;
}

function eq(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
  }
}

/** Float-tolerant equality for derived margins (published times are hundredths). */
function near(actual, expected, label, tolerance = 0.005) {
  if (typeof actual !== 'number' || !Number.isFinite(actual)) {
    fail(`${label}: got ${JSON.stringify(actual)}, expected ~${expected}`);
    return;
  }
  if (Math.abs(actual - expected) > tolerance) {
    fail(`${label}: got ${actual}, expected ~${expected} (±${tolerance})`);
  }
}

/* ------------------------------------------------------------------ */
/* 1. The meet field resolves, including the team that used to be D1   */
/* ------------------------------------------------------------------ */

const MEET_TEAMS = [
  'Henderson State University',
  'Ouachita Baptist University',
  'Delta State University',
  'University of West Florida',
];

// The live bug: UWF was absent from the map and fell through to the D1 default.
eq(divisionForTeamOrNull('University of West Florida'), 'D2', 'UWF resolves to D2');
eq(resolveTeamDivision('University of West Florida').match, 'canonical', 'UWF match kind');
eq(divisionForTeamOrNull('UWF'), 'D2', 'UWF abbreviation resolves to D2');
eq(divisionForTeamOrNull('Henderson State University'), 'D2', 'HSU resolves to D2');
eq(divisionForTeamOrNull('HSU'), 'D2', 'HSU abbreviation resolves to D2');

// Every team in data/meets.json must be mapped — an unmapped one is a silent bug.
const meets = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data/meets.json'), 'utf-8'));
const meetTeams = new Set();
(function walk(node) {
  if (Array.isArray(node)) {
    node.forEach(walk);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    if (k === 'team' && typeof v === 'string') meetTeams.add(v);
    if (k === 'teams' && Array.isArray(v)) v.forEach(t => typeof t === 'string' && meetTeams.add(t));
    walk(v);
  }
})(meets);
for (const t of meetTeams) {
  if (divisionForTeamOrNull(t) === null) fail(`team in data/meets.json is unmapped: ${t}`);
  const status = resolveTeamDivision(t).status;
  if (status !== 'active') {
    fail(`team in data/meets.json no longer has an active program (${status}): ${t}`);
  }
}

/* ------------------------------------------------------------------ */
/* 2. Unknown must not read as D1                                      */
/* ------------------------------------------------------------------ */

const unmapped = resolveTeamDivision('Cascadia Polytechnic College');
eq(unmapped.division, null, 'unmapped team resolves to null, not D1');
eq(unmapped.match, 'none', 'unmapped team match kind');
eq(unmapped.canonicalTeam, null, 'unmapped team has no canonical name');
eq(divisionForTeamOrNull(''), null, 'empty team name resolves to null');
eq(divisionForTeamOrNull('   '), null, 'whitespace team name resolves to null');

// The named fallback is opt-in and takes the division from the caller.
eq(
  divisionForTeamOrDefault('Cascadia Polytechnic College', 'D3'),
  'D3',
  'divisionForTeamOrDefault honours the caller-supplied fallback'
);
eq(
  divisionForTeamOrDefault('Henderson State University', 'D3'),
  'D2',
  'divisionForTeamOrDefault does not override a known team'
);

/* ------------------------------------------------------------------ */
/* 3. The substring landmine is gone                                   */
/* ------------------------------------------------------------------ */

// "Pitt" is a registered alias of Pittsburgh. Under the old fuzzy fallback,
// "Pittsburg State University" (a D2 program) matched it and scored as D1.
eq(divisionForTeamOrNull('Pitt'), 'D1', 'Pitt alias still resolves');
eq(divisionForTeamOrNull('University of Pittsburgh'), 'D1', 'Pittsburgh canonical resolves');
const pittsburg = resolveTeamDivision('Pittsburg State University');
eq(pittsburg.match, 'none', 'Pittsburg State must not match anything');
eq(pittsburg.division, null, 'Pittsburg State must not resolve to D1 via the "Pitt" substring');
eq(pittsburg.canonicalTeam, null, 'Pittsburg State must not be canonicalized to Pittsburgh');

// Other substring victims of the old loop.
for (const name of ['State University', 'University', 'Delta State University Center']) {
  const r = resolveTeamDivision(name);
  if (r.match !== 'none' && name !== 'Delta State University') {
    fail(`substring match resurfaced: "${name}" matched ${r.canonicalTeam}`);
  }
}

// Legacy call sites keep their old signature and their old fallback, but the
// fallback is now the only route to D1 for an unknown team.
eq(divisionForTeam('Cascadia Polytechnic College'), 'D1', 'legacy divisionForTeam still defaults');
eq(divisionForTeam('University of West Florida'), 'D2', 'legacy divisionForTeam sees UWF');
eq(
  divisionForTeam('Cascadia Polytechnic College', { 'Cascadia Polytechnic College': 'NAIA' }),
  'NAIA',
  'legacy overrides still apply'
);
eq(
  divisionForTeamOrNull('cascadia polytechnic college', {
    overrides: { 'Cascadia Polytechnic College': 'NAIA' },
  }),
  'NAIA',
  'overrides match on the normalized key too'
);

// Every registry entry carries a provenance note.
for (const entry of knownTeamDivisions()) {
  if (!entry.note || !entry.provenance) fail(`registry entry without provenance: ${entry.team}`);
}

/* ------------------------------------------------------------------ */
/* 4. Meet-level resolution                                            */
/* ------------------------------------------------------------------ */

const uniform = resolveMeetDivisions(MEET_TEAMS);
eq(uniform.status, 'uniform', 'the NSISC meet field is a uniform division');
eq(uniform.division, 'D2', 'uniform meet exposes a meet-wide division');
eq(uniform.divisions.join(','), 'D2', 'uniform meet divisions');
eq(uniform.unresolvedTeams.length, 0, 'uniform meet has no unresolved teams');
eq(uniform.byTeam['University of West Florida'], 'D2', 'per-team mapping includes UWF');

const mixed = resolveMeetDivisions(['Henderson State University', 'University of Pittsburgh']);
eq(mixed.status, 'mixed', 'a mixed field is reported as mixed');
eq(mixed.division, null, 'a mixed field must not be forced to one meet-wide division');
eq(mixed.divisions.join(','), 'D1,D2', 'mixed field divisions');
eq(mixed.byTeam['Henderson State University'], 'D2', 'mixed field per-team: HSU');
eq(mixed.byTeam['University of Pittsburgh'], 'D1', 'mixed field per-team: Pittsburgh');

const partial = resolveMeetDivisions(['Henderson State University', 'Cascadia Polytechnic College']);
eq(partial.status, 'partial', 'a partly-unresolved field is reported as partial');
eq(partial.division, null, 'partial field must not promote the agreed division');
eq(partial.divisions.join(','), 'D2', 'partial field exposes what did resolve');
eq(partial.byTeam['Cascadia Polytechnic College'], null, 'partial field per-team unknown is null');
eq(partial.unresolvedTeams.join(','), 'Cascadia Polytechnic College', 'partial unresolved list');

const allUnknown = resolveMeetDivisions(['Cascadia Polytechnic College', 'Rimrock A&M']);
eq(allUnknown.status, 'unknown', 'an all-unknown field is reported as unknown');
eq(allUnknown.division, null, 'all-unknown field has no division');
eq(allUnknown.divisions.length, 0, 'all-unknown field resolved nothing');

eq(resolveMeetDivisions([]).status, 'unknown', 'an empty field is unknown');
eq(
  resolveMeetDivisions(['Henderson State University', 'henderson  state university']).teams.length,
  1,
  'meet teams are deduplicated on the normalized key'
);

/* ------------------------------------------------------------------ */
/* 5. Cut tags — tagged / no_cut / unknown are three distinct states   */
/* ------------------------------------------------------------------ */

// D2 men 50 Freestyle: A 19.39, B 20.36 (snapshotted in test_cutlines.mjs).
const aCut = buildCutlineTag({ timeSec: 19.2, gender: 'Men', event: '50 Free', division: 'D2' });
eq(aCut.state, 'tagged', 'D2 19.20 produces a tag');
eq(cutlineTagRenderMode(aCut), 'tag', 'D2 19.20 render mode');
eq(aCut.tag?.tier, 'A', 'D2 19.20 tier');
eq(aCut.tag?.label, 'D2 A CUT', 'D2 19.20 label');
eq(aCut.tag?.standardTime, '19.39', 'D2 19.20 standard time is the published value');
eq(aCut.tag?.season, '2026-2027', 'D2 tag season');
eq(aCut.tag?.course, 'SCY', 'D2 tag course');
eq(aCut.tag?.event, '50 Freestyle', 'D2 tag normalizes the event name');
eq(aCut.tag?.title, 'NCAA D2 2026-2027 A standard — 19.39', 'D2 19.20 tooltip');
eq(aCut.lookupStatus, 'ok', 'D2 19.20 lookup status');
if (!aCut.tag?.sourceUrl?.startsWith('http')) fail('D2 tag is missing its provenance URL');
if (!aCut.tag?.source?.sha256) fail('D2 tag is missing its source sha256');
if (aCut.tag && aCut.tag.marginSeconds <= 0) fail('D2 19.20 margin should be positive');

const bCut = buildCutlineTag({ time: '20.00', gender: 'Men', event: '50 Free', division: 'D2' });
eq(bCut.state, 'tagged', 'D2 20.00 produces a tag from a time string');
eq(bCut.tag?.tier, 'B', 'D2 20.00 tier');
eq(bCut.tag?.label, 'D2 B CUT', 'D2 20.00 label');

// A real, judged miss.
const miss = buildCutlineTag({ timeSec: 21.0, gender: 'Men', event: '50 Free', division: 'D2' });
eq(miss.state, 'no_cut', 'D2 21.00 is a genuine miss');
eq(miss.tag, null, 'D2 21.00 carries no tag');
eq(miss.lookupStatus, 'ok', 'D2 21.00 was judged against a real table');
eq(cutlineTagRenderMode(miss), 'no_cut', 'D2 21.00 render mode');
eq(isCutlineTagConclusive(miss), true, 'D2 21.00 is a conclusive result');

// Not a miss: the table does not publish this event.
const bogus = buildCutlineTag({
  timeSec: 21.0,
  gender: 'Men',
  event: '75 Underwater Freestyle',
  division: 'D2',
});
eq(bogus.state, 'event_not_in_table', 'an unpublished event is not a miss');
eq(bogus.tag, null, 'unpublished event carries no tag');
eq(bogus.lookupStatus, 'event_not_in_table', 'unpublished event lookup status');
eq(cutlineTagRenderMode(bogus), 'unknown', 'unpublished event render mode');
eq(isCutlineTagConclusive(bogus), false, 'unpublished event is inconclusive');
if (!bogus.reason) fail('unpublished event result has no reason string');

// Not a miss: we do not know the team's division.
const noDivision = buildCutlineTag({
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Free',
  division: null,
});
eq(noDivision.state, 'division_unknown', 'a null division is its own state');
eq(noDivision.lookupStatus, null, 'a null division attempts no lookup');
eq(cutlineTagRenderMode(noDivision), 'unknown', 'null division render mode');

// Not a miss: there is no time to judge.
for (const bad of [{ timeSec: 0 }, { timeSec: -1 }, { time: 'NT' }, { time: 'DQ' }, { time: '' }]) {
  const r = buildCutlineTag({ gender: 'Men', event: '50 Free', division: 'D2', ...bad });
  eq(r.state, 'no_time', `unusable time ${JSON.stringify(bad)} is not a miss`);
  eq(cutlineTagRenderMode(r), 'unknown', `unusable time ${JSON.stringify(bad)} render mode`);
}

// Tags never carry a tier the source does not publish.
const d1 = buildCutlineTag({ timeSec: 19.2, gender: 'Men', event: '50 Free', division: 'D1' });
eq(d1.tag?.tier, 'Standard', 'D1 publishes one Standard, not an A cut');
eq(d1.tag?.label, 'D1 STANDARD', 'D1 label must not say A CUT');
eq(d1.tag?.title, 'NCAA D1 2025-2026 qualifying standard — 19.43', 'D1 tooltip');

const d3 = buildCutlineTag({ timeSec: 20.02, gender: 'Men', event: '50 Free', division: 'D3' });
eq(d3.tag?.tier, 'Invited', 'D3 publishes an Invited tier');
eq(d3.tag?.label, 'D3 INVITED', 'D3 Invited label');

const naia = buildCutlineTag({ timeSec: 19.5, gender: 'Men', event: '50 Free', division: 'NAIA' });
eq(naia.tag?.tier, 'A', 'NAIA automatic maps to the A slot');
eq(naia.tag?.label, 'NAIA AUTO', 'NAIA label uses the sheet vocabulary, not NCAA A/B');
eq(naia.tag?.title, 'NAIA 2026-2027 automatic standard — 19.91', 'NAIA tooltip');

const naiaMetric = buildCutlineTag({
  timeSec: 22.0,
  gender: 'Men',
  event: '50 Free',
  division: 'NAIA',
  course: 'METRIC_UNSPECIFIED',
});
eq(naiaMetric.tag?.course, 'METRIC_UNSPECIFIED', 'NAIA metric course is preserved');
if (naiaMetric.tag && !naiaMetric.tag.title.includes('metres')) {
  fail('a non-yards tag must name its course in the tooltip');
}

/* ------------------------------------------------------------------ */
/* 6. Team-driven tags                                                 */
/* ------------------------------------------------------------------ */

const hsuTag = buildCutlineTagForTeam({
  team: 'Henderson State University',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Free',
});
eq(hsuTag.state, 'tagged', 'HSU swimmer gets a tag (the primary-workspace symptom)');
eq(hsuTag.tag?.label, 'D2 A CUT', 'HSU tag label');

const unknownTeamTag = buildCutlineTagForTeam({
  team: 'Cascadia Polytechnic College',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Free',
});
eq(unknownTeamTag.state, 'division_unknown', 'an unmapped team yields division_unknown, not a D1 tag');

const overridden = buildCutlineTagForTeam({
  team: 'Cascadia Polytechnic College',
  division: 'D2',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Free',
});
eq(overridden.state, 'tagged', 'an explicit division overrides the team lookup');
eq(overridden.tag?.division, 'D2', 'explicit division is used');

/* ------------------------------------------------------------------ */
/* 7. Program lifecycle — a cut program is not a missed cut            */
/* ------------------------------------------------------------------ */

// Lindenwood was wrong twice in the original map: the swimming & diving program
// was cut after 2023-24, and the inherited D2 label was already stale (the
// school completed its move to D1 in July 2022). Neither error may resurface as
// a confident badge.
const lindenwood = resolveTeamDivision('Lindenwood University');
eq(lindenwood.match, 'canonical', 'Lindenwood is still a school we hold');
eq(lindenwood.division, null, 'Lindenwood must not resolve to a bare confident D2');
eq(lindenwood.status, 'discontinued', 'Lindenwood program status');
eq(lindenwood.lastActiveSeason, '2023-2024', 'Lindenwood last active season');
eq(divisionForTeamOrNull('Lindenwood University'), null, 'Lindenwood has no current division');

// Its division changed, so it is only answerable per season.
eq(divisionForTeamInSeason('Lindenwood University', '2021-2022'), 'D2', 'Lindenwood pre-2022 was D2');
eq(
  divisionForTeamInSeason('Lindenwood University', '2023-2024'),
  'D1',
  'Lindenwood final season was D1, not D2'
);
eq(
  divisionForTeamInSeason('Lindenwood University', '2026-2027'),
  null,
  'Lindenwood has no division in a season it did not swim'
);

// Oklahoma Baptist cut swimming & diving after 2020-21.
const okBaptist = resolveTeamDivision('Oklahoma Baptist University');
eq(okBaptist.division, null, 'Oklahoma Baptist has no current swimming division');
eq(okBaptist.status, 'discontinued', 'Oklahoma Baptist program status');
eq(okBaptist.lastActiveSeason, '2020-2021', 'Oklahoma Baptist last active season');
eq(
  divisionForTeamInSeason('Oklahoma Baptist University', '2019-2020'),
  'D2',
  'Oklahoma Baptist was D2 while it still swam'
);
eq(
  divisionForTeamInSeason('Oklahoma Baptist University', '2026-2027'),
  null,
  'Oklahoma Baptist has no division after the program was cut'
);

// Season arithmetic: absent, never a guessed year.
eq(teamSeasonStartYear('2023-2024'), 2023, 'season start year');
eq(teamSeasonStartYear('2023-24'), 2023, 'short season label start year');
eq(teamSeasonStartYear('sometime'), null, 'unparseable season is null, not a guessed year');
eq(
  programCompetedInSeason({ status: 'active' }, '2026-2027'),
  true,
  'an active program competes in the current season'
);
eq(
  programCompetedInSeason({ status: 'discontinued', lastActiveSeason: '2023-2024' }, '2026-2027'),
  false,
  'a program cut in 2024 did not swim 2026-2027'
);
eq(
  programCompetedInSeason({ status: 'discontinued', lastActiveSeason: '2023-2024' }, '2023-2024'),
  true,
  'its own final season still counts'
);
eq(
  programCompetedInSeason({ status: 'discontinued' }, '2026-2027'),
  false,
  'an unrecorded final season cannot prove overlap'
);

// The tag path refuses, and renders unknown — never "no cut".
const lindenwoodTag = buildCutlineTagForTeam({
  team: 'Lindenwood University',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
});
eq(lindenwoodTag.state, 'program_discontinued', 'a cut program is its own state');
eq(lindenwoodTag.tag, null, 'a cut program carries no tag');
eq(cutlineTagRenderMode(lindenwoodTag), 'unknown', 'a cut program renders unknown, not no_cut');
eq(isCutlineTagConclusive(lindenwoodTag), false, 'a cut program is inconclusive');
eq(lindenwoodTag.lookupStatus, null, 'a cut program attempts no table lookup');
for (const needle of ['Lindenwood University', '2023-2024']) {
  if (!lindenwoodTag.reason.includes(needle)) {
    fail(`program_discontinued reason must name ${needle}: ${lindenwoodTag.reason}`);
  }
}

// An explicit division must not resurrect a program that no longer exists.
const lindenwoodForced = buildCutlineTagForTeam({
  team: 'Lindenwood University',
  division: 'D1',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
});
eq(
  lindenwoodForced.state,
  'program_discontinued',
  'an explicit division does not make a 2026-2027 standard apply to a cut program'
);

const okBaptistTag = buildCutlineTagForTeam({
  team: 'Oklahoma Baptist University',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
});
eq(okBaptistTag.state, 'program_discontinued', 'Oklahoma Baptist swims are unjudgeable now');
eq(cutlineTagRenderMode(okBaptistTag), 'unknown', 'Oklahoma Baptist render mode');

// The guard is season-aware, not a blanket ban: a program that was still
// competing in the season under comparison is judged normally.
const stillCompeting = buildCutlineTag({
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
  division: 'D2',
  program: { team: 'Somewhere College', status: 'discontinued', lastActiveSeason: '2026-2027' },
});
eq(
  stillCompeting.state,
  'tagged',
  'a program that swam the season under comparison is still judged'
);

// An active program is untouched by the guard.
const activeProgramTag = buildCutlineTag({
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
  division: 'D2',
  program: { team: 'Henderson State University', status: 'active' },
});
eq(activeProgramTag.state, 'tagged', 'an active program still tags');

/* ------------------------------------------------------------------ */
/* 8. Per-gender sponsorship — an active school is not two teams       */
/* ------------------------------------------------------------------ */

// The live bug. UWF fields women's swimming & diving and no men's program, but
// the school is unambiguously active and unambiguously D2, so every school-level
// signal said "judge this against the D2 men's table".
const uwf = resolveTeamDivision('University of West Florida');
eq(uwf.division, 'D2', 'UWF is still a D2 school');
eq(uwf.status, 'active', 'UWF is still an active athletics program');
eq(uwf.sponsoredGenders?.join(','), 'Women', 'UWF sponsors women only');

const uwfMen = buildCutlineTagForTeam({
  team: 'University of West Florida',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
});
eq(uwfMen.state, 'gender_not_sponsored', 'a UWF men’s swim has no program to judge');
eq(uwfMen.tag, null, 'a gender the school does not sponsor carries no tag');
eq(cutlineTagRenderMode(uwfMen), 'unknown', 'gender_not_sponsored renders unknown, not no_cut');
eq(isCutlineTagConclusive(uwfMen), false, 'gender_not_sponsored is inconclusive');
eq(uwfMen.lookupStatus, null, 'gender_not_sponsored attempts no table lookup');
eq(uwfMen.division, 'D2', 'the refusal still reports the school’s division');
for (const needle of ['University of West Florida', 'men']) {
  if (!uwfMen.reason.includes(needle)) {
    fail(`gender_not_sponsored reason must name ${needle}: ${uwfMen.reason}`);
  }
}

// The gender it does sponsor is judged exactly as before.
const uwfWomen = buildCutlineTagForTeam({
  team: 'University of West Florida',
  timeSec: 19.2,
  gender: 'Women',
  event: '50 Freestyle',
});
eq(uwfWomen.state, 'tagged', 'a UWF women’s swim is still judged normally');
eq(uwfWomen.tag?.gender, 'Women', 'UWF women’s tag gender');
eq(uwfWomen.tag?.division, 'D2', 'UWF women’s tag division');

// An explicit division names the table that would apply; it does not conjure a
// men's team at a school that has none.
const uwfMenForced = buildCutlineTagForTeam({
  team: 'University of West Florida',
  division: 'D2',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
});
eq(
  uwfMenForced.state,
  'gender_not_sponsored',
  'an explicit division does not create a men’s program at UWF'
);

// The abbreviation path carries sponsorship too — it resolves the same entry.
const uwfAbbrev = buildCutlineTagForTeam({
  team: 'UWF',
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
});
eq(uwfAbbrev.state, 'gender_not_sponsored', 'the UWF abbreviation refuses a men’s swim too');

// Schools that sponsor both are untouched by the guard, in both genders.
for (const team of ['Henderson State University', 'Delta State University']) {
  for (const gender of ['Men', 'Women']) {
    const tag = buildCutlineTagForTeam({ team, gender, timeSec: 19.2, event: '50 Freestyle' });
    eq(tag.state, 'tagged', `${team} ${gender} still tags`);
  }
}

// programSponsorsGender is asymmetric on purpose: only a recorded list says no.
eq(
  programSponsorsGender({ sponsoredGenders: ['Women'] }, 'Men'),
  false,
  'a recorded list that omits a gender answers no'
);
eq(
  programSponsorsGender({ sponsoredGenders: ['Women'] }, 'Women'),
  true,
  'a recorded list that includes a gender answers yes'
);
eq(
  programSponsorsGender({}, 'Men'),
  true,
  'unrecorded sponsorship must not refuse — absent is an open question, not a no'
);
eq(
  programSponsorsGender({ sponsoredGenders: [] }, 'Women'),
  false,
  'an explicitly empty list sponsors nothing'
);

// A caller supplying its own program gets the same guard.
const manualProgram = buildCutlineTag({
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
  division: 'D2',
  program: { team: 'Somewhere College', status: 'active', sponsoredGenders: ['Women'] },
});
eq(manualProgram.state, 'gender_not_sponsored', 'a caller-supplied program is guarded too');
eq(cutlineTagRenderMode(manualProgram), 'unknown', 'caller-supplied refusal renders unknown');

// A discontinued program is still reported as discontinued: the season guard
// runs first, because "this school stopped swimming" is the more basic fact.
const cutAndUnsponsored = buildCutlineTag({
  timeSec: 19.2,
  gender: 'Men',
  event: '50 Freestyle',
  division: 'D2',
  program: {
    team: 'Somewhere College',
    status: 'discontinued',
    lastActiveSeason: '2020-2021',
    sponsoredGenders: ['Women'],
  },
});
eq(
  cutAndUnsponsored.state,
  'program_discontinued',
  'a discontinued program reports discontinuation, not unsponsored gender'
);

/* ------------------------------------------------------------------ */
/* 9. The registry itself: no unverified rows, no confident guesses    */
/* ------------------------------------------------------------------ */

for (const entry of knownTeamDivisions()) {
  if (entry.provenance === 'legacy') {
    fail(`unverified legacy entry survived the audit: ${entry.team}`);
  }
  if (!entry.status) fail(`registry entry without a program status: ${entry.team}`);
  if (!entry.sources?.length) fail(`registry entry without a source URL: ${entry.team}`);
  for (const url of entry.sources ?? []) {
    if (!url.startsWith('http')) fail(`registry source is not a URL: ${entry.team} → ${url}`);
  }
  if (entry.status === 'active' && !entry.division) {
    fail(`active program without a division: ${entry.team}`);
  }
  // Sponsorship is only meaningful for a program that still exists, but where it
  // exists it must be recorded — an unrecorded active school is exactly the UWF
  // hole, and it reopens silently.
  if (entry.status === 'active') {
    if (!entry.sponsoredGenders?.length) {
      fail(`active program without recorded sponsored genders: ${entry.team}`);
    }
    for (const g of entry.sponsoredGenders ?? []) {
      if (g !== 'Men' && g !== 'Women') {
        fail(`unrecognized sponsored gender on ${entry.team}: ${JSON.stringify(g)}`);
      }
    }
  }
  if (entry.status === 'discontinued') {
    if (entry.division !== null) {
      fail(`discontinued program still claims a current division: ${entry.team}`);
    }
    if (!entry.lastActiveSeason) {
      fail(`discontinued program without a last active season: ${entry.team}`);
    }
  }
}

// Every meets.json team still resolves uniform D2 and still tags correctly, in
// each gender it actually sponsors. 19.20 clears the published D2 50 Freestyle A
// standard on both sides. Iterating sponsorship rather than hardcoding "Men" is
// the point: this loop used to assert a men's tag for UWF, which has no men's
// team, and it passed.
for (const team of MEET_TEAMS) {
  const resolution = resolveTeamDivision(team);
  eq(resolution.division, 'D2', `${team} resolves to D2`);
  eq(resolution.status, 'active', `${team} program is active`);
  const sponsored = resolution.sponsoredGenders ?? [];
  if (!sponsored.length) fail(`meets.json team has no recorded sponsorship: ${team}`);
  for (const gender of sponsored) {
    const tag = buildCutlineTagForTeam({ timeSec: 19.2, gender, event: '50 Freestyle', team });
    eq(tag.state, 'tagged', `${team} ${gender} 19.20 still produces a tag`);
    eq(tag.tag?.label, 'D2 A CUT', `${team} ${gender} 19.20 label`);
  }
  for (const gender of ['Men', 'Women']) {
    if (sponsored.includes(gender)) continue;
    const tag = buildCutlineTagForTeam({ timeSec: 19.2, gender, event: '50 Freestyle', team });
    eq(tag.state, 'gender_not_sponsored', `${team} ${gender} is not sponsored and must refuse`);
    eq(cutlineTagRenderMode(tag), 'unknown', `${team} ${gender} renders unknown`);
  }
}

// The audited schools keep the divisions their own athletics sites report.
for (const [team, division] of [
  ['University of Pittsburgh', 'D1'],
  ['University of Louisville', 'D1'],
  ['Florida State University', 'D1'],
  ['McKendree University', 'D2'],
  ['Drury University', 'D2'],
]) {
  const r = resolveTeamDivision(team);
  eq(r.division, division, `${team} verified division`);
  eq(r.status, 'active', `${team} verified as an active program`);
  eq(r.entry?.provenance, 'verified', `${team} provenance is verified`);
}

/* ------------------------------------------------------------------ */
/* 9b. Course eligibility — only a yards swim can earn a yards cut     */
/* ------------------------------------------------------------------ */

/**
 * User ruling (2026-07-25): "no LCM data for NCAA qualifications. Converted
 * times are good for a 'loose' fit but you need to record a yards swim under
 * qualifying time to qualify or gain a cutline."
 *
 * Every standard referenced below is the D2 men's 50 Freestyle pair already
 * snapshotted in test_cutlines.mjs (A 19.39 / B 20.36). The metric swim times
 * are synthetic probes.
 */
{
  const base = { gender: 'Men', event: '50 Free', division: 'D2' };

  // A yards swim under the standard is a cut, as before.
  const scy = buildCutlineTag({ ...base, timeSec: 19.2, swimCourse: 'SCY' });
  eq(scy.state, 'tagged', 'an explicit SCY swim under the standard is tagged');
  eq(scy.tag?.tier, 'A', 'SCY swim tier');
  eq(cutlineTagRenderMode(scy), 'tag', 'SCY swim render mode');
  eq(scy.swimCourse, 'SCY', 'SCY swim course of record');
  eq(scy.tableCourse, 'SCY', 'SCY swim table course');

  // Missing timeType is SCY: SwimmerResult carries no course field and every
  // meet result in this repo is short-course yards.
  const noCourse = buildCutlineTag({ ...base, timeSec: 19.2 });
  eq(noCourse.state, 'tagged', 'a swim with no recorded course is treated as SCY and tagged');
  eq(noCourse.swimCourse, 'SCY', 'absent course of record defaults to SCY');
  eq(noCourse.tableCourse, noCourse.course, 'legacy `course` mirrors `tableCourse`');

  // 22.00 LCM converts to 19.14 yards, inside the 19.39 A standard.
  const lcm = buildCutlineTag({ ...base, time: '22.00', swimCourse: 'LCM' });
  eq(lcm.state, 'converted_estimate', 'an LCM swim under the converted standard is never tagged');
  eq(lcm.tag, null, 'a converted estimate carries no tag');
  eq(cutlineTagRenderMode(lcm), 'indicative', 'converted estimate renders as indicative');
  eq(isCutlineTagConclusive(lcm), false, 'a converted estimate is not conclusive');
  eq(lcm.swimCourse, 'LCM', 'converted estimate reports the course of record');
  eq(lcm.tableCourse, 'SCY', 'converted estimate reports the table course');
  eq(lcm.indicative?.tier, 'A', 'converted estimate names the tier it would have cleared');
  eq(lcm.indicative?.tierLabel, 'D2 A CUT', 'converted estimate tier label');
  eq(lcm.indicative?.label, 'D2 A CUT (CONVERTED)', 'converted estimate label must not read as a cut');
  eq(lcm.indicative?.standardTime, '19.39', 'converted estimate quotes the published standard');
  eq(lcm.indicative?.swimCourse, 'LCM', 'indicative block carries the course of record');
  eq(lcm.indicative?.factorEvent, '50 Freestyle', 'indicative block names the conversion factor used');
  if (!(lcm.indicative?.convertedSeconds < lcm.swimSeconds)) {
    fail('LCM conversion should produce a faster yards-equivalent for a 50');
  }
  if (!/yards/i.test(lcm.reason) || !/recorded in short-course yards/i.test(lcm.reason)) {
    fail(`converted-estimate reason must state a yards swim is required: ${lcm.reason}`);
  }
  if (!lcm.indicative?.sourceUrl?.startsWith('http')) {
    fail('converted estimate is missing its provenance URL');
  }

  // 21.00 SCM converts to 19.03 yards — same refusal.
  const scm = buildCutlineTag({ ...base, time: '21.00', swimCourse: 'SCM' });
  eq(scm.state, 'converted_estimate', 'an SCM swim under the converted standard is never tagged');
  eq(cutlineTagRenderMode(scm), 'indicative', 'SCM converted estimate render mode');
  eq(scm.indicative?.swimCourse, 'SCM', 'SCM indicative course of record');

  // A metric swim that misses even converted is an ordinary, judged miss.
  const lcmMiss = buildCutlineTag({ ...base, time: '30.00', swimCourse: 'LCM' });
  eq(lcmMiss.state, 'no_cut', 'a metric swim slower than the converted standard is a genuine miss');
  eq(cutlineTagRenderMode(lcmMiss), 'no_cut', 'metric miss render mode');
  eq(isCutlineTagConclusive(lcmMiss), true, 'metric miss is conclusive');
  if (!/converted/i.test(lcmMiss.reason)) {
    fail(`metric miss should say it was judged on a converted time: ${lcmMiss.reason}`);
  }

  // The metric-label trap: "50 Meter Freestyle" normalizes to "50 Freestyle" and
  // would previously have been judged as a yards swim.
  const metricLabel = buildCutlineTag({ gender: 'Men', event: '50 Meter Freestyle', division: 'D2', time: '22.00' });
  eq(metricLabel.state, 'conversion_unavailable', 'a metric label is never tagged as a yards swim');
  eq(metricLabel.swimCourse, 'METRIC_UNSPECIFIED', 'a metric label without a pool length is unspecified');
  eq(cutlineTagRenderMode(metricLabel), 'unknown', 'unconvertible metric label renders unknown');
  eq(isCutlineTagConclusive(metricLabel), false, 'unconvertible metric label is inconclusive');

  // No published relay conversion factor: refuse rather than approximate.
  const lcmRelay = buildCutlineTag({
    gender: 'Men',
    event: '4x100 Medley Relay',
    division: 'D2',
    time: '3:20.00',
    swimCourse: 'LCM',
  });
  eq(lcmRelay.state, 'conversion_unavailable', 'a metric relay has no published conversion factor');
  eq(cutlineTagRenderMode(lcmRelay), 'unknown', 'unconvertible metric relay renders unknown');

  // Diving still answers "not applicable", not a conversion complaint.
  const lcmDive = buildCutlineTag({
    gender: 'Women',
    event: 'Event 18 Women 3 mtr Diving',
    division: 'D2',
    timeSec: 285.6,
    swimCourse: 'LCM',
  });
  eq(lcmDive.state, 'not_applicable', 'diving is a category error before it is a course question');

  // Metric distance freestyle changes event identity as well as time.
  const lcm400 = buildCutlineTag({
    gender: 'Men',
    event: '400 Freestyle',
    division: 'D2',
    time: '4:00.00',
    swimCourse: 'LCM',
  });
  eq(lcm400.state, 'converted_estimate', 'LCM 400 Free reaches the yards 500 Free table');
  eq(lcm400.event, '500 Freestyle', 'LCM 400 Free is judged in the 500 Free slot');
  eq(lcm400.indicative?.event, '500 Freestyle', 'indicative block names the yards event judged');

  // `tableCourse` is the new name for the old `course` input; both must work.
  const legacyCourse = buildCutlineTag({ ...base, timeSec: 19.2, course: 'SCY' });
  const namedCourse = buildCutlineTag({ ...base, timeSec: 19.2, tableCourse: 'SCY' });
  eq(legacyCourse.state, namedCourse.state, 'legacy `course` and `tableCourse` agree');
  eq(namedCourse.tableCourse, 'SCY', '`tableCourse` is reported back');
}

/* ------------------------------------------------------------------ */
/* 9c. Near-miss margins — absent, never zero                          */
/* ------------------------------------------------------------------ */

/**
 * In the real HSU meet nothing qualified, so every badge is absent and the
 * margins are the useful signal. `nextTier` is pure arithmetic over one
 * published standard and one real swim time — derived, never fabricated — and it
 * carries the published `standardTime` verbatim so the basis is visible.
 *
 * Standards referenced (all snapshotted in test_cutlines.mjs): D2 men 50
 * Freestyle A 19.39 / B 20.36; D2 men 200 Freestyle Relay provisional 1:19.88.
 */
{
  const base = { gender: 'Men', event: '50 Free', division: 'D2' };

  // River Paulk's real swim: 19.42 holds a B tag AND is 0.03 off the A standard.
  const paulk = buildCutlineTag({ ...base, time: '19.42' });
  eq(paulk.state, 'tagged', '19.42 is still a tag');
  eq(paulk.tag?.tier, 'B', '19.42 tier');
  eq(paulk.nextTier?.tier, 'A', '19.42 reports the next tier up, not the one it earned');
  eq(paulk.nextTier?.label, 'D2 A CUT', '19.42 next-tier label');
  eq(paulk.nextTier?.standardTime, '19.39', 'next tier quotes the published standard verbatim');
  eq(paulk.nextTier?.event, '50 Freestyle', 'next tier names the event compared');
  near(paulk.nextTier?.shortBySeconds, 0.03, '19.42 is 0.03 off the A standard');
  near(paulk.nextTier?.judgedSeconds, 19.42, 'next tier reports the seconds compared');
  if (!paulk.nextTier?.sourceUrl?.startsWith('http')) {
    fail('a near-miss margin must carry the provenance of the standard it used');
  }

  // Clearing the strictest published tier reports absent — NOT zero. A zero would
  // read as "exactly on the standard", a much stronger claim than "no tier left".
  const clearedStrictest = buildCutlineTag({ ...base, timeSec: 19.2 });
  eq(clearedStrictest.state, 'tagged', '19.20 is an A cut');
  eq(clearedStrictest.nextTier, null, 'a swim past the strictest tier has no margin to report');

  // A genuine miss reports the easiest published tier — the one it came closest to.
  const missed = buildCutlineTag({ ...base, timeSec: 21.0 });
  eq(missed.state, 'no_cut', '21.00 is a genuine miss');
  eq(missed.nextTier?.tier, 'B', 'a total miss reports the easiest tier published');
  eq(missed.nextTier?.standardTime, '20.36', 'total miss quotes the B standard');
  near(missed.nextTier?.shortBySeconds, 0.64, '21.00 is 0.64 off the B standard');

  // Absent everywhere there is nothing honest to measure against.
  eq(
    buildCutlineTag({ ...base, timeSec: 21.0, event: '75 Underwater Freestyle' }).nextTier,
    null,
    'an unpublished event has no margin'
  );
  eq(
    buildCutlineTag({ ...base, timeSec: 19.2, division: null }).nextTier,
    null,
    'an unknown division has no margin'
  );
  eq(
    buildCutlineTag({ ...base, time: 'NT' }).nextTier,
    null,
    'an unusable time has no margin'
  );
  eq(
    buildCutlineTag({
      gender: 'Women',
      event: 'Event 18 Women 3 mtr Diving',
      division: 'D2',
      timeSec: 285.6,
    }).nextTier,
    null,
    'diving points have no margin against a swim standard'
  );

  // The indicative path falls out of the same arithmetic, measured on the
  // converted yards time rather than the recorded metric one.
  const lcmMiss = buildCutlineTag({ ...base, time: '30.00', swimCourse: 'LCM' });
  eq(lcmMiss.state, 'no_cut', 'a slow metric swim is a judged miss');
  eq(lcmMiss.nextTier?.tier, 'B', 'a converted miss still reports the easiest tier');
  if (!(lcmMiss.nextTier?.judgedSeconds < lcmMiss.swimSeconds)) {
    fail('a converted 50 must be judged on its yards equivalent, not the raw LCM time');
  }

  // ...and on the indicative path, measured on the converted time too. 22.00 LCM
  // converts inside the A standard, so the next tier up is absent.
  const lcmIndicative = buildCutlineTag({ ...base, time: '22.00', swimCourse: 'LCM' });
  eq(lcmIndicative.state, 'converted_estimate', 'an LCM swim under the converted A standard');
  eq(lcmIndicative.nextTier, null, 'a converted time past the strictest tier has no margin');
  near(
    lcmIndicative.indicative?.convertedSeconds ?? -1,
    19.14,
    'the published conversion factor result is unchanged',
    0.05
  );
}

/* ------------------------------------------------------------------ */
/* 9d. A relay leg row carries TWO verdicts, and neither may eat the   */
/*     other                                                           */
/* ------------------------------------------------------------------ */

/**
 * The bug: a caller that had to pick one event name for a relay leg row picked
 * the leg's individual event on the backstroke leadoff, so the leadoff
 * swimmer's row silently lost the fact that the relay itself made the cut.
 *
 * Standards referenced (snapshotted in test_cutlines.mjs / the archived PDFs):
 * D2 men 400 Medley Relay provisional 3:12.45, 200 Medley Relay provisional
 * 1:27.34, 200 Freestyle Relay provisional 1:19.88, 100 Backstroke A 46.29 /
 * B 48.60. The relay and split times below are synthetic probes except where
 * noted.
 */
{
  const HSU = 'Henderson State University';
  const MEDLEY_400 = 'Event 20 Men 4x100 Yard Medley Relay';

  // A hypothetical qualifying relay, with the backstroke leadoff's split.
  const leadoff = buildRelaySwimTagsForTeam({
    team: HSU,
    gender: 'Men',
    relayEvent: MEDLEY_400,
    relayTeamTime: '3:10.00',
    legQualificationEvent: relaySplitQualificationCutEvent({
      isRelay: true,
      relayLegStroke: 'back',
      event: MEDLEY_400,
    }),
    legSplit: '48.50',
  });

  // Verdict 1: the relay TEAM time against the relay standard.
  eq(leadoff.relay.state, 'tagged', 'the relay verdict survives on the leadoff row');
  eq(leadoff.relay.tag?.event, '400 Medley Relay', 'relay verdict uses the relay event');
  eq(leadoff.relay.tag?.tier, 'Provisional', 'D2 relays publish provisional only');
  eq(leadoff.relay.tag?.label, 'D2 PROVISIONAL', 'relay verdict label');
  eq(leadoff.relay.tag?.standardTime, '3:12.45', 'relay verdict quotes the published relay standard');
  eq(
    leadoff.relay.nextTier,
    null,
    'a D2 relay that makes provisional has no stricter tier — no A cut may be synthesized'
  );

  // Verdict 2: this leg's split against the individual standard. Independent.
  eq(leadoff.legQualification?.state, 'tagged', 'the leg verdict survives too');
  eq(leadoff.legQualification?.tag?.event, '100 Backstroke', 'leg verdict uses the individual event');
  eq(leadoff.legQualification?.tag?.tier, 'B', 'leg verdict tier');
  eq(leadoff.legQualification?.swimSeconds, 48.5, 'leg verdict is judged on the split, not the team time');
  eq(leadoff.legQualification?.nextTier?.tier, 'A', 'the leg verdict carries its own margin');

  // Neither overwrote the other.
  if (leadoff.relay.tag?.event === leadoff.legQualification?.tag?.event) {
    fail('the relay and leg verdicts collapsed onto one event');
  }
  if (leadoff.relay.swimSeconds === leadoff.legQualification?.swimSeconds) {
    fail('the relay and leg verdicts were judged on the same time');
  }

  // A non-leadoff leg: the relay verdict stands, the leg question does not apply.
  const flyLeg = buildRelaySwimTagsForTeam({
    team: HSU,
    gender: 'Men',
    relayEvent: MEDLEY_400,
    relayTeamTime: '3:10.00',
    legQualificationEvent: relaySplitQualificationCutEvent({
      isRelay: true,
      relayLegStroke: 'fly',
      event: MEDLEY_400,
    }),
    legSplit: '48.50',
  });
  eq(flyLeg.relay.state, 'tagged', 'a non-leadoff leg still reports the relay verdict');
  eq(flyLeg.relay.tag?.tier, 'Provisional', 'non-leadoff relay verdict tier');
  eq(flyLeg.legQualification, null, 'a non-leadoff leg has no individual verdict');

  // The 200 medley relay leadoff: no 50 Backstroke standard is published, so the
  // eligibility rule returns null and the leg question does not apply. The real
  // HSU 4x50 medley time is 1:28.08 against a 1:27.34 provisional — 0.74 short.
  const medley200 = buildRelaySwimTagsForTeam({
    team: HSU,
    gender: 'Men',
    relayEvent: 'Event 10 Men 4x50 Yard Medley Relay',
    relayTeamTime: '1:28.08',
    legQualificationEvent: relaySplitQualificationCutEvent({
      isRelay: true,
      relayLegStroke: 'back',
      event: 'Event 10 Men 4x50 Yard Medley Relay',
    }),
    legSplit: '22.50',
  });
  eq(medley200.legQualification, null, '200 medley relay leadoff has no published individual standard');
  eq(medley200.relay.state, 'no_cut', 'the real 4x50 medley missed');
  eq(medley200.relay.event, '200 Medley Relay', '4x50 medley normalizes to the published total');
  eq(medley200.relay.nextTier?.tier, 'Provisional', '200 MR near-miss tier');
  eq(medley200.relay.nextTier?.standardTime, '1:27.34', '200 MR published provisional');
  near(medley200.relay.nextTier?.shortBySeconds, 0.74, 'HSU 4x50 medley is 0.74 short');

  // The real HSU 4x50 freestyle: 1:20.21 against a 1:19.88 provisional.
  const free200 = buildRelaySwimTagsForTeam({
    team: HSU,
    gender: 'Men',
    relayEvent: 'Event 31 Men 4x50 Yard Freestyle Relay',
    relayTeamTime: '1:20.21',
  });
  eq(free200.relay.state, 'no_cut', 'the real 4x50 free missed');
  eq(free200.relay.event, '200 Freestyle Relay', '4x50 free normalizes to the published total');
  eq(free200.legQualification, null, 'a freestyle relay has no eligible leg split');
  eq(free200.relay.nextTier?.standardTime, '1:19.88', '200 FR published provisional');
  near(free200.relay.nextTier?.shortBySeconds, 0.33, 'HSU 4x50 free is 0.33 short');

  // An eligible leg with no split recorded: absent, not a miss.
  const noSplit = buildRelaySwimTagsForTeam({
    team: HSU,
    gender: 'Men',
    relayEvent: MEDLEY_400,
    relayTeamTime: '3:10.00',
    legQualificationEvent: '100 Backstroke',
  });
  eq(noSplit.relay.state, 'tagged', 'a missing split does not disturb the relay verdict');
  eq(noSplit.legQualification, null, 'an eligible leg with no split has no individual verdict');

  // No team time: the relay verdict is `no_time`, never a zero-second relay, and
  // the leg verdict is unaffected.
  const noTeamTime = buildRelaySwimTagsForTeam({
    team: HSU,
    gender: 'Men',
    relayEvent: MEDLEY_400,
    legQualificationEvent: '100 Backstroke',
    legSplit: '48.50',
  });
  eq(noTeamTime.relay.state, 'no_time', 'an absent relay team time is no_time, not a zero');
  eq(noTeamTime.relay.nextTier, null, 'no_time carries no margin');
  eq(noTeamTime.legQualification?.state, 'tagged', 'the leg verdict stands without a team time');

  // Program guards apply to both verdicts on the same terms.
  const discontinued = buildRelaySwimTagsForTeam({
    team: 'Lindenwood University',
    gender: 'Men',
    relayEvent: MEDLEY_400,
    relayTeamTime: '3:10.00',
    legQualificationEvent: '100 Backstroke',
    legSplit: '48.50',
  });
  eq(discontinued.relay.state, 'program_discontinued', 'a cut program refuses the relay verdict');
  eq(discontinued.legQualification?.state, 'program_discontinued', 'and the leg verdict too');

  // The division-explicit form works without a team registry entry.
  const direct = buildRelaySwimTags({
    gender: 'Men',
    division: 'D2',
    relayEvent: MEDLEY_400,
    relayTeamTimeSec: 190,
    legQualificationEvent: '100 Backstroke',
    legSplitSec: 48.5,
  });
  eq(direct.relay.state, 'tagged', 'buildRelaySwimTags accepts a direct division');
  eq(direct.legQualification?.state, 'tagged', 'and still returns both verdicts');
  eq(direct.relay.swimSeconds, 190, 'seconds inputs are used directly');
}

// Acceptance: the primary workspace still tags.
{
  const hsu = buildCutlineTagForTeam({
    timeSec: 19.2,
    gender: 'Men',
    event: '50 Free',
    team: 'Henderson State University',
  });
  eq(hsu.state, 'tagged', 'HSU 19.20 SCY 50 Free is still tagged');
  eq(hsu.tag?.label, 'D2 A CUT', 'HSU 19.20 SCY 50 Free is still D2 A CUT');
}

/* ------------------------------------------------------------------ */
/* 10. No competition-time literal may live in the new source          */
/* ------------------------------------------------------------------ */

for (const rel of ['packages/core/src/lib/cutlineTags.ts', 'packages/core/src/data/teamDivisions.ts']) {
  const src = fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
  const clock = src.match(/['"]\d{1,3}:\d{2}\.\d{2}['"]/g);
  if (clock) fail(`${rel} contains competition-time literals: ${clock.join(', ')}`);
  const sprint = src.match(/['"]\d{1,2}\.\d{2}['"]/g);
  if (sprint) fail(`${rel} contains competition-time literals: ${sprint.join(', ')}`);
}

/* ------------------------------------------------------------------ */

if (failures) {
  console.error(`\n${failures} division/tag check(s) failed`);
  process.exit(1);
}
console.log('cutline tags + division resolution: all checks passed');
