import { describe, it, expect } from 'vitest';
import {
  extractSwimmerNameFromPaste,
  parseSwimCloudPasteDetailed,
  splitMultiProfileBlocks,
} from '../packages/core/src/lib/athleteHistory';
import { parseSwimCloudMultiProfile } from '../packages/core/src/lib/swimCloudMultiProfile';
import { Gender } from '../packages/core/src/types';

const TEAM = 'Ouachita Baptist University';
const HDR = 'Event\tTime\t\tMeet\tDate\tStamp Link';

/** The junk SwimCloud prints between a profile header and its personal-bests table. */
const CHROME = ['PERSONAL BESTS', 'EVENT PROGRESSION', 'Course', 'Season', 'Sort by'];

describe('athleteHistory', () => {
  it('parses tab-separated SwimCloud paste, pairing each swimmer with their own row', () => {
    // This used to assert only `swims.length > 0` and that swims[0].event matched
    // /Freestyle|Breaststroke/ — an alternation that cannot tell the two rows
    // apart, so a parser that swapped the events or dropped the second swimmer
    // still passed. Every field is pinned exactly.
    const text = 'Landon Dehn\t200 Freestyle\t1:56.47\nJane Doe\t100 Breaststroke\t1:05.00';
    const result = parseSwimCloudPasteDetailed(text, {
      team: 'Test U',
      gender: Gender.MEN,
    });

    expect(result.swims).toHaveLength(2);
    expect(result.warnings).toEqual([]);

    expect(result.swims[0]).toMatchObject({
      name: 'Landon Dehn',
      event: '200 Freestyle',
      time: '1:56.47',
      team: 'Test U',
      gender: Gender.MEN,
      source: 'paste',
    });
    expect(result.swims[1]).toMatchObject({
      name: 'Jane Doe',
      event: '100 Breaststroke',
      time: '1:05.00',
      team: 'Test U',
      gender: Gender.MEN,
      source: 'paste',
    });

    // No swim invents a cut verdict: 'Test U' has no known division, and an
    // unresolved division must stay absent rather than defaulting to a table.
    for (const swim of result.swims) {
      expect(swim.computedCut).toBeNull();
    }
  });
});

/**
 * Regression: a three-line profile header (name / hometown / club) used to be split
 * into two or three "athletes", because a foreign hometown and a club name both pass
 * a word-count person-name test. Real swims then filed themselves under a club.
 *
 * Every header line below is copied from `oburoster202627.txt`, which is the export
 * that exposed this.
 */
describe('multi-profile block splitting', () => {
  it('keeps one athlete whose header carries a 3-letter country code and a club line', () => {
    const paste = [
      'Mikhail Lymar',
      'Volgograd, RUS', // 3-letter country code — the old LOCATION_RE wanted exactly 2
      'Bison Aquatic Club', // club line, shaped exactly like a person name
      'Mikhail Lymar on Instagram', // social-handle line, also name-shaped
      ...CHROME,
      HDR,
      '50 Free SCY\t22.77\tX\tNT LAC Fall Classic\tNov 9, 2025\t',
      '100 Free SCY\t49.46\t\tNT COR Senior CUP\tMar 2, 2025\t',
      '200 Free SCY\t1:44.51\t\tNT LAC Fall Classic\tNov 7, 2025\t',
    ].join('\n');

    const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });

    expect(res.athletes).toHaveLength(1);
    expect(res.athletes[0].name).toBe('Mikhail Lymar');
    expect(res.athletes[0].swims).toHaveLength(3);
    // No phantom zero-swim athlete, and therefore no "No swims parsed" warning.
    expect(res.warnings.filter(w => /No swims parsed/.test(w))).toEqual([]);
    // The swims belong to the swimmer, not to the club.
    expect(res.athletes.map(a => a.name)).not.toContain('Bison Aquatic Club');
  });

  it('does not split on a club named only for a mascot', () => {
    // "Arkansas Dolphins" carries no club/aquatics/university keyword at all, so no
    // vocabulary list can reject it. Only the block structure can.
    const paste = [
      'Owen Green',
      'Benton, AR',
      'Arkansas Dolphins',
      ...CHROME,
      HDR,
      '500 Free SCY\t4:39.75\t\tSpeedo Sectionals - Justin\tMar 6, 2026\t',
      '200 Fly SCY\t1:52.34\t\tSpeedo Sectionals - Justin\tMar 9, 2025\t',
    ].join('\n');

    const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });

    expect(res.athletes).toHaveLength(1);
    expect(res.athletes[0].name).toBe('Owen Green');
    expect(res.athletes[0].swims).toHaveLength(2);
    expect(res.warnings.filter(w => /No swims parsed/.test(w))).toEqual([]);
  });

  it('still separates consecutive athletes and attaches each swim to the right one', () => {
    const paste = [
      'AJ Alfeo',
      'Nevada, TX',
      'Metroplex Aquatics',
      'AJ Alfeo on Instagram',
      ...CHROME,
      HDR,
      '1000 Free SCY\t9:49.90\tX\tNT LAC Fall Classic\tNov 9, 2025\t',
      '1650 Free SCY\t16:19.60\t\tNT LAC Fall Classic\tNov 9, 2025\t',
      '',
      'Stefan DUCA-MIRCEA',
      'HUN', // hometown reduced to a bare country code
      'Ouachita Baptist University',
      ...CHROME,
      HDR,
      '100 Breast SCY\t1:03.21\t\tNT COR Classic\tDec 1, 2023\t',
      '',
      'Máté Hosszú',
      'Tárnok, HUN',
      'Razorback Aquatic Club Aquahawgs',
      ...CHROME,
      HDR,
      '200 IM SCY\t1:56.42\t\tSpeedo Sectionals - Justin\tMar 8, 2026\t',
      '400 IM SCY\t4:06.48\t\tSpeedo Sectionals - Justin\tMar 8, 2025\t',
    ].join('\n');

    const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });

    expect(res.athletes.map(a => a.name)).toEqual([
      'AJ Alfeo',
      'Stefan DUCA-MIRCEA',
      'Máté Hosszú',
    ]);
    expect(res.athletes.map(a => a.swims.length)).toEqual([2, 1, 2]);
    expect(res.warnings.filter(w => /No swims parsed/.test(w))).toEqual([]);
    // Each swim is under its own swimmer.
    expect(res.athletes[0].swims.every(s => s.name === 'AJ Alfeo')).toBe(true);
    expect(res.athletes[2].swims.map(s => s.event).sort()).toEqual([
      '200 Individual Medley',
      '400 Individual Medley',
    ]);
  });

  it('records folded header lines instead of dropping them silently', () => {
    // Two layers, and this asserts which one caught what.
    // "Mansfield Aquatic Club" is rejected lexically (club vocabulary), so it never
    // reaches the splitter as a name candidate and is never "absorbed".
    // "Arkansas Dolphins" passes every word test, so only the block structure stops
    // it — and it is recorded, not silently swallowed.
    const paste = [
      'Carston Silva',
      'Mansfield, TX',
      'Mansfield Aquatic Club',
      'Arkansas Dolphins',
      ...CHROME,
      HDR,
      '50 Free SCY\t22.79\tX\tNT LAC Season Opener\tApr 14, 2024\t',
    ].join('\n');

    const { blocks, orphanLines } = splitMultiProfileBlocks(paste);
    expect(blocks).toHaveLength(1);
    expect(orphanLines).toEqual([]);
    expect(blocks[0].name).toBe('Carston Silva');
    expect(blocks[0].absorbed).toEqual(['Arkansas Dolphins']);
    expect(blocks[0].hasDataRow).toBe(true);
    // Nothing vanishes: every folded line is still in the block's raw lines.
    expect(blocks[0].lines).toContain('Mansfield Aquatic Club');
    expect(blocks[0].lines).toContain('Arkansas Dolphins');
  });

  it('does not read a club or hometown line as the swimmer name', () => {
    // A paste whose first line is the club must still find the person below it.
    const paste = ['Metroplex Aquatics', 'Nevada, TX', 'AJ Alfeo', HDR].join('\n');
    expect(extractSwimmerNameFromPaste(paste)).toBe('AJ Alfeo');
  });

  it('still detects real athlete name lines', () => {
    // True-positive guard: none of the new exclusions may swallow an actual name.
    for (const name of [
      'Tyler Bell',
      'Stefan DUCA-MIRCEA',
      'Máté Hosszú',
      'Ruben Rivera Ayala',
      'Alan Alejan Gonzalez Mujica',
      'Sparky Sparks',
      'Owen McCall',
      'Coi Call',
    ]) {
      const paste = [name, HDR, '50 Free SCY\t21.00\t\tMeet\tFeb 1, 2026\t'].join('\n');
      const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });
      expect(res.athletes.map(a => a.name)).toEqual([name]);
      expect(res.athletes[0].swims).toHaveLength(1);
    }
  });

  it('reports a profile that genuinely has no swim rows', () => {
    // Carson Powers on the OBU roster is a diver: five diving SCORES, zero times.
    // "Absent" must stay loud and distinguishable from a parse failure — a diving
    // score is not a time and must never be imported as one.
    const paste = [
      'Carson Powers',
      'Oviedo, FL',
      'Ouachita Baptist University',
      ...CHROME,
      HDR,
      '1 M Diving 6 Dives\t469.55\t\tOBU vs.DSU\tNov 8, 2025\t',
      '3 M Diving 11 Dives\t484.05\t\tNew South Championships\tFeb 23, 2024\t',
    ].join('\n');

    const res = parseSwimCloudMultiProfile(paste, { team: TEAM, gender: Gender.MEN });
    expect(res.athletes).toHaveLength(0);
    expect(res.warnings.some(w => /No swims parsed for "Carson Powers"/.test(w))).toBe(true);
    // The diving scores are not smuggled in as times anywhere.
    expect(JSON.stringify(res.athletes)).not.toContain('469.55');
  });
});
