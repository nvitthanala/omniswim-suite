/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Team name → NCAA/NAIA division resolution.
 *
 * Two rules govern this file, both from `CLAUDE.md` § Data provenance:
 *
 * 1. **Unknown division ≠ D1.** An unmapped team must surface as unknown, never
 *    quietly score against the wrong division's qualifying table. The strict
 *    API ({@link resolveTeamDivision}, {@link divisionForTeamOrNull}) returns
 *    `null` for a team we do not hold. The legacy D1 fallback still exists for
 *    older call sites but it is now named and opt-in
 *    ({@link divisionForTeamOrDefault}).
 * 2. **No fuzzy matching.** The previous implementation fell back to
 *    `key.includes(known) || known.includes(key)` over a map that registered
 *    `'pitt'` as a key, so "Pittsburg State University" (D2) resolved to D1 via
 *    "Pitt". Matching is now normalized-exact against a canonical name or an
 *    explicit alias — nothing else.
 *
 * A division is only recorded here when it is known from a real source. A team
 * we cannot verify stays absent; absent is the honest answer and a guess is not.
 *
 * 3. **A program is not timeless.** Schools reclassify, and schools drop
 *    swimming & diving outright. Lindenwood was D2, then D1 from 2022-2023, then
 *    cut the sport after 2023-2024 — a single `division: 'D2'` field asserted a
 *    confident answer that was wrong twice over. Lifecycle now lives in
 *    {@link TeamDivisionEntry.status}, {@link TeamDivisionEntry.lastActiveSeason}
 *    and {@link TeamDivisionEntry.divisionHistory}, and a discontinued program
 *    resolves to `division: null` rather than to its final division.
 *
 * 4. **A program is not one program.** Sponsorship is per gender. The University
 *    of West Florida fields women's swimming & diving and no men's team at all,
 *    but a school-level `status: 'active'` said "yes" to both, so a men's UWF
 *    swim was judged against the D2 men's table as though the program existed.
 *    {@link TeamDivisionEntry.sponsoredGenders} records which genders a school
 *    actually sponsors, and {@link programSponsorsGender} is the question the
 *    tag path asks before judging a swim.
 */

import { NcaaDivision } from '../types';
import { expandTeamAbbrev, normalizeTeamKey } from './teamAliases';

/* -------------------------------------------------------------------------- */
/* Program lifecycle                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A season label in `YYYY-YYYY` form, e.g. `2023-2024`.
 *
 * Deliberately **not** `CutlineSeason`. The qualifying tables we hold cover only
 * 2025-2026 and 2026-2027, but a program's history reaches further back, and a
 * program whose last season predates every table we hold cannot be judged at all
 * — that is a distinct fact from "missed the cut", and it needs a type that can
 * express seasons the cutline tables never will.
 */
export type TeamSeasonLabel = `${number}-${number}`;

/**
 * Whether the school still fields swimming & diving.
 *
 * - `active` — verified as competing in the most recent season we checked.
 * - `discontinued` — the school has dropped the sport. See
 *   {@link TeamDivisionEntry.lastActiveSeason}.
 * - `unknown` — we could not confirm either way. It is **not** a synonym for
 *   `active`; it means the question is open.
 */
export type TeamProgramStatus = 'active' | 'discontinued' | 'unknown';

/**
 * A gender a school can sponsor swimming & diving in.
 *
 * Value-identical to `CutlineGender` in `cutlines.ts` on purpose, so the tag
 * path compares a swim's gender to a school's sponsorship without a translation
 * table in between — a mapping layer here is one more place to get it backwards.
 */
export type SponsoredGender = 'Men' | 'Women';

/** Both genders, for the ordinary school that sponsors each. */
export const BOTH_GENDERS: readonly SponsoredGender[] = ['Men', 'Women'];

/**
 * How an entry came to be believed.
 *
 * - `meet` — the team appears in `data/meets.json`; division and program status
 *   confirmed against the school's own athletics site.
 * - `verified` — confirmed against a primary source recorded in
 *   {@link TeamDivisionEntry.sources}.
 * - `legacy` — inherited from the original map and never re-verified. Retained
 *   as a valid value so the type stays additive, but no entry should carry it:
 *   the 2026-07-26 audit either promoted every legacy row to `verified` or
 *   stripped its division. `legacy` is a defect, not a state to rest in.
 */
export type TeamDivisionProvenance = 'meet' | 'verified' | 'legacy';

/**
 * One division held over a span of seasons.
 *
 * This is deliberately not a general temporal database — it is a short, ordered
 * list of closed or open-ended spans, enough to answer "what division was this
 * school in during season X" without pretending a reclassifying school has one
 * timeless division. Omit `from` for "as far back as we care", omit `through`
 * for "still current".
 */
export type TeamDivisionPeriod = {
  division: NcaaDivision;
  /** First season in this division. Absent = unbounded in the past. */
  from?: TeamSeasonLabel;
  /** Last season in this division. Absent = still current. */
  through?: TeamSeasonLabel;
  note?: string;
};

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One school's division, with a note and sources recording why we believe it.
 */
export type TeamDivisionEntry = {
  /** Canonical school name, as it should be displayed. */
  team: string;
  /**
   * The division to judge a *current* swim against, or `null` when there is no
   * honest single answer — a discontinued program, or one we could not verify.
   *
   * `null` here is the same `null` {@link resolveTeamDivision} returns for an
   * unknown school: not D1, not the school's last-known division. Use
   * {@link divisionForTeamInSeason} when you need the division as of a
   * particular season.
   */
  division: NcaaDivision | null;
  /** Alternate spellings and abbreviations that resolve to this school. */
  aliases?: readonly string[];
  provenance: TeamDivisionProvenance;
  status: TeamProgramStatus;
  /**
   * Final season the swimming & diving program competed. Required in practice
   * for `status: 'discontinued'` — without it we cannot tell whether a given
   * season falls inside the program's life, so tagging refuses.
   */
  lastActiveSeason?: TeamSeasonLabel;
  /**
   * Which genders this school sponsors swimming & diving in.
   *
   * Absent means **not recorded** — the same open question `status: 'unknown'`
   * describes, and emphatically not a shorthand for "both". Absence therefore
   * never refuses a tag; only a recorded list that omits the gender does.
   * Refusing every school we have not audited per gender would be a far larger
   * lie than the one this field exists to stop.
   *
   * Recorded for every `status: 'active'` entry, which
   * `scripts/test_cutline_tags.mjs` enforces. Omitted for a discontinued
   * program, where `status` already answers the question for both genders.
   */
  sponsoredGenders?: readonly SponsoredGender[];
  /**
   * Division over time, oldest first. Present only when the division actually
   * changed; a school that has always been one division just has `division`.
   */
  divisionHistory?: readonly TeamDivisionPeriod[];
  /** Primary-source URLs backing this entry. */
  sources?: readonly string[];
  /** ISO date the sources were last checked. */
  verifiedOn?: string;
  note: string;
};

/** Date the 2026-07-26 audit checked every source URL below. */
const AUDIT_DATE = '2026-07-26';

const TEAM_DIVISION_ENTRIES: readonly TeamDivisionEntry[] = [
  // --- Teams present in data/meets.json (the NSISC meet field) ---
  {
    team: 'Henderson State University',
    division: 'D2',
    aliases: ['HSU', 'Henderson State'],
    provenance: 'meet',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://hsusports.com/sports/mens-swimming-and-diving/roster',
      'https://hsusports.com/sports/womens-swimming-and-diving/roster',
    ],
    note:
      'Primary workspace. NCAA D2, Great American Conference; appears in ' +
      'data/meets.json. Athletics site publishes a current men’s and ' +
      'women’s roster, so the program is active. Its sports navigation lists ' +
      '"Swim" under both Men’s Sports and Women’s Sports.',
  },
  {
    team: 'Ouachita Baptist University',
    division: 'D2',
    aliases: ['OBU', 'OUAC', 'Ouachita Baptist'],
    provenance: 'meet',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://obutigers.com/sports/mens-swimming-and-diving/roster',
      'https://obutigers.com/sports/womens-swimming-and-diving/roster',
    ],
    note:
      'NCAA D2, Great American Conference; swims in the NSISC. Appears in ' +
      'data/meets.json. Current men’s and women’s rosters published, and the ' +
      'sports navigation carries a separate "Swimming & Diving" entry for each.',
  },
  {
    team: 'Delta State University',
    division: 'D2',
    aliases: ['DSU', 'Delta State'],
    provenance: 'meet',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://gostatesmen.com/sports/mens-swimming-and-diving/roster',
      'https://gostatesmen.com/sports/womens-swimming-and-diving/roster',
    ],
    note:
      'NCAA D2, Gulf South Conference; appears in data/meets.json. Current ' +
      'men’s and women’s rosters published, each with its own navigation entry.',
  },
  {
    team: 'University of West Florida',
    division: 'D2',
    aliases: ['UWF', 'West Florida'],
    provenance: 'meet',
    status: 'active',
    sponsoredGenders: ['Women'],
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://goargos.com/sports/womens-swimming-and-diving/roster',
      'https://goargos.com/staff-directory',
    ],
    note:
      'NCAA D2, Gulf South Conference. Added 2026-07-26: it was absent from the ' +
      'map and the old D1 fallback silently scored it against the D1 table. ' +
      'UWF sponsors women’s swimming & diving only. Both sources agree: the ' +
      'sports navigation lists "Swimming & Diving" under women’s sports and ' +
      'has no men’s counterpart, and every swimming & diving coach in the ' +
      'staff directory sits under the women’s program. `status: \'active\'` is ' +
      'true of the school and was the whole problem — it answered "yes" for a ' +
      'men’s swim too, so `sponsoredGenders` is what makes the men’s side ' +
      'refuse instead of scoring against the D2 men’s table.',
  },

  // --- Re-verified 2026-07-26 (was provenance: 'legacy') ---
  {
    team: 'University of Pittsburgh',
    division: 'D1',
    aliases: ['Pitt'],
    provenance: 'verified',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: ['https://pittsburghpanthers.com/sports/swimming-and-diving/roster'],
    note:
      'NCAA D1, ACC. Current combined swimming & diving roster published. ' +
      'Pitt uses one sport slug for both genders, so sponsorship comes from ' +
      'the sport navigation on that page, which carries separate "Men’s ' +
      'Roster" and "Women’s Roster" links. "Pitt" is an explicit alias, not a ' +
      'substring rule.',
  },
  {
    team: 'University of Louisville',
    division: 'D1',
    aliases: ['Louisville'],
    provenance: 'verified',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: ['https://gocards.com/sports/swimming-and-diving/roster'],
    note:
      'NCAA D1, ACC. Current swimming & diving roster published. Louisville ' +
      'also uses one sport slug for both genders; the 2025-26 roster page ' +
      'splits into "Women’s" and "Men’s" tabs, each populated.',
  },
  {
    team: 'Florida State University',
    division: 'D1',
    aliases: ['Florida State'],
    provenance: 'verified',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://seminoles.com/sports/mens-swimming-and-diving/roster',
      'https://seminoles.com/sports/womens-swimming-and-diving/roster',
    ],
    note:
      'NCAA D1, ACC. Separate men’s and women’s sport slugs, both resolving to ' +
      'a populated 2025-26 roster.',
  },
  {
    team: 'McKendree University',
    division: 'D2',
    aliases: ['MKU'],
    provenance: 'verified',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://mckbearcats.com/sports/mens-swimming-and-diving/roster',
      'https://mckbearcats.com/sports/womens-swimming-and-diving/roster',
      'https://www.mckendree.edu/home/glvc.php',
    ],
    note:
      'NCAA D2, Great Lakes Valley Conference. Current roster published and the ' +
      'program competed at the NCAA D2 championships in March 2026. Sport ' +
      'navigation carries a full men’s and women’s set (schedule, roster, news).',
  },
  {
    team: 'Drury University',
    division: 'D2',
    aliases: ['DRURY', 'DRUR'],
    provenance: 'verified',
    status: 'active',
    sponsoredGenders: BOTH_GENDERS,
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://drurypanthers.com/sports/mens-swimming-and-diving/roster',
      'https://drurypanthers.com/sports/womens-swimming-and-diving/roster',
    ],
    note:
      'NCAA D2, Great Lakes Valley Conference. Current men’s and ' +
      'women’s rosters published, each with its own navigation entry.',
  },

  // --- Discontinued programs. `division: null` on purpose. ---
  {
    team: 'Lindenwood University',
    division: null,
    provenance: 'verified',
    status: 'discontinued',
    lastActiveSeason: '2023-2024',
    divisionHistory: [
      {
        division: 'D2',
        through: '2021-2022',
        note: 'MIAA era, before the Division I reclassification.',
      },
      {
        division: 'D1',
        from: '2022-2023',
        through: '2023-2024',
        note: 'Ohio Valley Conference; swimming & diving competed in the Summit League.',
      },
    ],
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://lindenwoodlions.com/sports/mens-swimming-and-diving',
      'https://swimswam.com/division-i-lindenwood-university-to-cut-swimming-diving-programs-eight-others/',
    ],
    note:
      'Wrong twice in the original map. (1) Lindenwood cut men’s and ' +
      'women’s swimming & diving after the 2023-2024 season, as part of a ' +
      'ten-program cut; its athletics site now labels both sports ' +
      '"(Discontinued)" and the newest roster in the season selector is ' +
      '2023-2024. (2) The inherited D2 label was already stale: Lindenwood ' +
      'completed its move to NCAA Division I in July 2022, so its final two ' +
      'seasons were D1. D2 was only correct pre-2022. No current division ' +
      'exists, so `division` is null and the tag path refuses rather than ' +
      'judging a 2023-2024 program against a 2026-2027 table.',
  },
  {
    team: 'Oklahoma Baptist University',
    division: null,
    provenance: 'verified',
    status: 'discontinued',
    lastActiveSeason: '2020-2021',
    divisionHistory: [
      {
        division: 'D2',
        from: '2017-2018',
        through: '2020-2021',
        note: 'Great American Conference, after the NAIA-to-NCAA D2 transition.',
      },
    ],
    verifiedOn: AUDIT_DATE,
    sources: [
      'https://www.okbu.edu/news/2020/11/obu-athletics-announces-reduction-in-sports',
      'https://obubison.com/sports/mens-swimming-and-diving/roster',
    ],
    note:
      'OBU announced in November 2020 that seven varsity programs, including ' +
      'men’s and women’s swimming & diving, would end after the ' +
      '2020-2021 academic year. The athletics site’s season selector stops ' +
      'at 2020-2021, confirming it. The school itself remains NCAA D2 (Great ' +
      'American Conference), but it no longer swims, so `division` is null.',
  },
];

/** Normalized lookup key → entry. Built once; exact match only. */
const BY_KEY: ReadonlyMap<string, TeamDivisionEntry> = (() => {
  const map = new Map<string, TeamDivisionEntry>();
  for (const entry of TEAM_DIVISION_ENTRIES) {
    const keys = [entry.team, ...(entry.aliases ?? [])];
    for (const k of keys) {
      const norm = normalizeTeamKey(k);
      if (!norm) continue;
      if (map.has(norm) && map.get(norm) !== entry) {
        // Two schools claiming one key would make resolution order-dependent.
        // Fail at module load rather than resolve a coin-flip at runtime.
        throw new Error(
          `teamDivisions: duplicate key "${norm}" claimed by "${map.get(norm)?.team}" and "${entry.team}"`
        );
      }
      map.set(norm, entry);
    }
  }
  return map;
})();

/** Every school whose division is recorded, with its provenance note. */
export function knownTeamDivisions(): readonly TeamDivisionEntry[] {
  return TEAM_DIVISION_ENTRIES;
}

/* -------------------------------------------------------------------------- */
/* Single-team resolution                                                      */
/* -------------------------------------------------------------------------- */

/** How a team's division was determined. `none` means it was not. */
export type TeamDivisionMatch = 'override' | 'canonical' | 'alias' | 'abbreviation' | 'none';

export type TeamDivisionResolution = {
  /** The name as supplied, trimmed. */
  team: string;
  /**
   * `null` means unknown. It does **not** mean D1, and for a school we *do*
   * hold it does not mean "unmapped" either — a discontinued program is a known
   * school with no current division. Check {@link TeamDivisionResolution.status}
   * to tell those apart.
   */
  division: NcaaDivision | null;
  /** Canonical school name we matched, or `null` when nothing matched. */
  canonicalTeam: string | null;
  match: TeamDivisionMatch;
  /** The registry entry, when the match came from the registry. */
  entry?: TeamDivisionEntry;
  /**
   * Lifecycle of the matched school's swimming & diving program. `'unknown'`
   * when nothing matched — we cannot claim a school we do not hold is active.
   */
  status: TeamProgramStatus;
  /** Final season the program competed, when it is discontinued. */
  lastActiveSeason?: TeamSeasonLabel;
  /**
   * Genders the matched school sponsors, when recorded. Absent means the
   * question is open — never read absence as "both". See
   * {@link programSponsorsGender}.
   */
  sponsoredGenders?: readonly SponsoredGender[];
};

export type TeamDivisionOptions = {
  /**
   * Caller-supplied divisions that win over the registry. Keys are matched
   * verbatim first, then normalized, so `'HSU'` and `'Henderson State
   * University'` both work.
   */
  overrides?: Record<string, NcaaDivision>;
};

function resolveOverride(
  team: string,
  overrides: Record<string, NcaaDivision> | undefined
): NcaaDivision | null {
  if (!overrides) return null;
  if (overrides[team]) return overrides[team];
  const norm = normalizeTeamKey(team);
  if (!norm) return null;
  for (const [k, v] of Object.entries(overrides)) {
    if (normalizeTeamKey(k) === norm) return v;
  }
  return null;
}

/**
 * Resolve one team to a division, reporting how (or whether) it was matched.
 *
 * Resolution order — all exact, none fuzzy:
 *   1. caller `overrides`
 *   2. normalized exact match on a canonical name
 *   3. normalized exact match on a registered alias
 *   4. abbreviation expansion via `teamAliases.expandTeamAbbrev`, then (2)
 *
 * A name that matches none of those resolves to `division: null`.
 */
export function resolveTeamDivision(
  teamName: string,
  options?: TeamDivisionOptions
): TeamDivisionResolution {
  const team = String(teamName ?? '').trim();
  const miss: TeamDivisionResolution = {
    team,
    division: null,
    canonicalTeam: null,
    match: 'none',
    status: 'unknown',
  };
  if (!team) return miss;

  const lifecycle = (entry: TeamDivisionEntry) => ({
    status: entry.status,
    ...(entry.lastActiveSeason ? { lastActiveSeason: entry.lastActiveSeason } : {}),
    ...(entry.sponsoredGenders ? { sponsoredGenders: entry.sponsoredGenders } : {}),
  });

  const override = resolveOverride(team, options?.overrides);
  if (override) {
    const known = BY_KEY.get(normalizeTeamKey(team));
    return {
      team,
      division: override,
      canonicalTeam: known?.team ?? team,
      match: 'override',
      ...(known ? { entry: known, ...lifecycle(known) } : { status: 'unknown' as const }),
    };
  }

  const norm = normalizeTeamKey(team);
  const direct = norm ? BY_KEY.get(norm) : undefined;
  if (direct) {
    return {
      team,
      division: direct.division,
      canonicalTeam: direct.team,
      match: normalizeTeamKey(direct.team) === norm ? 'canonical' : 'alias',
      entry: direct,
      ...lifecycle(direct),
    };
  }

  // Abbreviations that teamAliases already knows about (HSU, UWF, OUAC, ...).
  const expanded = expandTeamAbbrev(team);
  if (expanded) {
    const viaAbbrev = BY_KEY.get(normalizeTeamKey(expanded));
    if (viaAbbrev) {
      return {
        team,
        division: viaAbbrev.division,
        canonicalTeam: viaAbbrev.team,
        match: 'abbreviation',
        entry: viaAbbrev,
        ...lifecycle(viaAbbrev),
      };
    }
  }

  return miss;
}

/* -------------------------------------------------------------------------- */
/* Season-aware lookups                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The first calendar year of a `YYYY-YYYY` (or `YYYY-YY`) season label.
 *
 * Returns `null` for anything it cannot parse — absent, not a guessed year.
 */
export function teamSeasonStartYear(season: string): number | null {
  const m = /^\s*(\d{4})\s*[-–/]\s*\d{2,4}\s*$/.exec(String(season ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Could this program have competed in `season`?
 *
 * Only a `discontinued` status can answer "no": `unknown` means the question is
 * open, not that the program is absent, and callers already refuse to tag a
 * school whose division they could not verify.
 *
 * A discontinued program with no `lastActiveSeason` returns `false` for every
 * season — we cannot prove it overlaps, and "cannot prove" must not read as
 * "yes". Same rule when `season` is unparseable.
 */
export function programCompetedInSeason(
  program: Pick<TeamDivisionEntry, 'status' | 'lastActiveSeason'>,
  season: string
): boolean {
  if (program.status !== 'discontinued') return true;
  const last = program.lastActiveSeason ? teamSeasonStartYear(program.lastActiveSeason) : null;
  const target = teamSeasonStartYear(season);
  if (last === null || target === null) return false;
  return last >= target;
}

/**
 * Does this school field swimming & diving for `gender`?
 *
 * Deliberately asymmetric, for the same reason {@link programCompetedInSeason}
 * is: only a *recorded* list can answer "no". An entry with no
 * `sponsoredGenders` returns `true` for every gender, because absence here means
 * unaudited, not unsponsored — refusing to tag every school we have not yet
 * checked per gender would suppress far more true badges than the one false
 * badge it prevents. The negative answer is a claim, and it needs a source.
 */
export function programSponsorsGender(
  program: Pick<TeamDivisionEntry, 'sponsoredGenders'>,
  gender: SponsoredGender
): boolean {
  const sponsored = program.sponsoredGenders;
  if (!sponsored) return true;
  return sponsored.includes(gender);
}

/**
 * The division this school competed in during `season`, or `null`.
 *
 * `null` covers three honest answers, all of which mean "do not judge this swim
 * against a division table": the school is unmapped, the program had already
 * been discontinued by `season`, or we hold a division history that does not
 * cover `season`.
 *
 * Schools with no `divisionHistory` fall back to their current `division`, which
 * is itself `null` for a discontinued program.
 */
export function divisionForTeamInSeason(
  teamName: string,
  season: string,
  options?: TeamDivisionOptions
): NcaaDivision | null {
  const resolution = resolveTeamDivision(teamName, options);
  if (resolution.match === 'override') return resolution.division;

  const entry = resolution.entry;
  if (!entry) return null;
  if (!programCompetedInSeason(entry, season)) return null;

  const target = teamSeasonStartYear(season);
  if (target !== null && entry.divisionHistory?.length) {
    for (const period of entry.divisionHistory) {
      const from = period.from ? teamSeasonStartYear(period.from) : null;
      const through = period.through ? teamSeasonStartYear(period.through) : null;
      if ((from === null || target >= from) && (through === null || target <= through)) {
        return period.division;
      }
    }
    // A history exists but names no division for this season. Absent, not a guess.
    return null;
  }

  return entry.division;
}

/**
 * Strict lookup: the team's division, or `null` when we do not hold it.
 *
 * Prefer this over {@link divisionForTeam}. `null` must be rendered as "division
 * unknown", never coerced to a default — scoring an athlete against the wrong
 * division's table produces a plausible, wrong badge.
 */
export function divisionForTeamOrNull(
  teamName: string,
  options?: TeamDivisionOptions
): NcaaDivision | null {
  return resolveTeamDivision(teamName, options).division;
}

/**
 * Lookup with an explicit, caller-chosen fallback.
 *
 * The fallback is a parameter precisely so that assuming a division is a visible
 * decision at the call site rather than a hidden default in this file.
 */
export function divisionForTeamOrDefault(
  teamName: string,
  fallback: NcaaDivision,
  options?: TeamDivisionOptions
): NcaaDivision {
  return resolveTeamDivision(teamName, options).division ?? fallback;
}

/**
 * The division {@link divisionForTeam} assumes when a team is unmapped.
 *
 * This is a legacy behaviour, not a correct one: an unknown team is not a D1
 * team. It is retained only so existing call sites keep their old semantics
 * while they migrate to {@link divisionForTeamOrNull}.
 */
export const LEGACY_UNKNOWN_TEAM_DIVISION: NcaaDivision = 'D1';

/**
 * Legacy lookup. Always returns a division, falling back to
 * {@link LEGACY_UNKNOWN_TEAM_DIVISION} for an unknown team.
 *
 * The substring fallback is gone — "Pittsburg State University" no longer
 * resolves through "Pitt" — but the D1 default remains for compatibility.
 *
 * @deprecated Use {@link divisionForTeamOrNull} and handle `null`, or
 * {@link divisionForTeamOrDefault} when a fallback is genuinely intended.
 */
export function divisionForTeam(
  teamName: string,
  overrides?: Record<string, NcaaDivision>
): NcaaDivision {
  return divisionForTeamOrDefault(teamName, LEGACY_UNKNOWN_TEAM_DIVISION, { overrides });
}

/* -------------------------------------------------------------------------- */
/* Meet-level resolution                                                       */
/* -------------------------------------------------------------------------- */

/**
 * What the teams in a meet collectively say about its division.
 *
 * - `uniform` — every team resolved and they all agree. Only this state yields a
 *   non-null meet-wide `division`.
 * - `mixed` — two or more divisions are represented. There is no single correct
 *   meet-wide answer; tag each athlete by their own team's division.
 * - `partial` — the teams that resolved agree, but at least one did not resolve.
 *   The agreed division is in `divisions[0]`; using it for the unresolved teams
 *   is a guess, so it is deliberately not promoted to `division`.
 * - `unknown` — nothing resolved, or no teams were supplied.
 */
export type MeetDivisionStatus = 'uniform' | 'mixed' | 'partial' | 'unknown';

export type MeetDivisionResolution = {
  /** Per-team resolution, deduplicated, in first-seen order. */
  teams: TeamDivisionResolution[];
  /** Input team name → division, `null` for unresolved. The per-athlete answer. */
  byTeam: Record<string, NcaaDivision | null>;
  /** Distinct resolved divisions, sorted. Empty when nothing resolved. */
  divisions: NcaaDivision[];
  /** Non-null only when `status === 'uniform'`. Never a guess. */
  division: NcaaDivision | null;
  status: MeetDivisionStatus;
  /** Teams we could not resolve, as supplied. */
  unresolvedTeams: string[];
};

/**
 * Derive a meet's division from the divisions of the teams competing in it.
 *
 * Deliberately does **not** force one meet-wide value when teams disagree —
 * `byTeam` is the authoritative per-athlete mapping and `division` stays `null`
 * for anything but a unanimous, fully-resolved field.
 */
export function resolveMeetDivisions(
  teams: Iterable<string>,
  options?: TeamDivisionOptions
): MeetDivisionResolution {
  const seen = new Set<string>();
  const resolutions: TeamDivisionResolution[] = [];
  const byTeam: Record<string, NcaaDivision | null> = {};
  const unresolvedTeams: string[] = [];
  const divisions = new Set<NcaaDivision>();

  for (const raw of teams) {
    const team = String(raw ?? '').trim();
    if (!team) continue;
    const dedupeKey = normalizeTeamKey(team) || team.toLowerCase();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const resolution = resolveTeamDivision(team, options);
    resolutions.push(resolution);
    byTeam[team] = resolution.division;
    if (resolution.division) divisions.add(resolution.division);
    else unresolvedTeams.push(team);
  }

  const distinct = [...divisions].sort();
  let status: MeetDivisionStatus;
  if (distinct.length === 0) status = 'unknown';
  else if (distinct.length > 1) status = 'mixed';
  else if (unresolvedTeams.length > 0) status = 'partial';
  else status = 'uniform';

  return {
    teams: resolutions,
    byTeam,
    divisions: distinct,
    division: status === 'uniform' ? distinct[0] : null,
    status,
    unresolvedTeams,
  };
}

/**
 * Legacy team → division map builder.
 *
 * @deprecated Uses the legacy D1 fallback, so an unknown team is reported as D1.
 * Use {@link resolveMeetDivisions}, whose `byTeam` reports unknown as `null`.
 */
export function registerTeamsFromList(teams: string[]): Record<string, NcaaDivision> {
  const out: Record<string, NcaaDivision> = {};
  for (const t of teams) {
    out[t] = divisionForTeam(t);
  }
  return out;
}
