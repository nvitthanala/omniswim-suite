/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * Athlete name aliasing — a first-class way to LINK two name spellings as the
 * same human, so imports (SwimCloud paste, etc.) stop creating duplicate
 * athletes ("Steven Balistreri" vs "Stevie Balistreri", or a swimmer's short
 * roster name vs a long multi-token SwimCloud name).
 *
 * There are NO hardcoded nickname tables here. Two mechanisms:
 *
 *   1. buildAliasResolver(workspace | links) → a resolver that maps any name to
 *      its confirmed canonical identity. Team/gender-scoped links win over
 *      global links; resolution is transitive (A→B, B→C ⇒ A→C) and cycle-safe.
 *
 *   2. suggestAliasCandidates(existing, incoming) → a heuristic that PROPOSES
 *      likely same-athlete pairs for UI confirmation (surname + first-name
 *      relation, initial-vs-full, token-subset for the long-form case, and
 *      "Last, First" comma ordering). It never auto-links.
 *
 *   3. planAutoAliasLinks(workspace) → a two-tier decision engine that AUTO-links
 *      only pairs backed by conclusive/strong/moderate evidence and demotes
 *      everything else to (2). See the "auto-link" section at the bottom of this
 *      file for the tier rules, the hard blockers, and the merge semantics.
 *
 * addAliasLink / removeAliasLink return `{ patch, inverse, description }` — the
 * same undo-able WorkspaceEditorPatch contract as swimEditor.ts / applyExactSwap.
 *
 * Test: npx tsx scripts/test_athlete_aliases.mjs
 *       npx tsx scripts/test_athlete_autolink.mjs
 */

import { v4 as uuidv4 } from 'uuid';
import {
  AliasAutoRule,
  AliasEvidenceTier,
  AliasLinkProvenance,
  AliasTimeMatch,
  AthleteAliasLink,
  Gender,
  HistoricalSwim,
  PlannedSwimEntry,
  Recruit,
  SwimmerResult,
  Workspace,
} from '../types';
import {
  canonicalSwimmerName,
  convertTimeToSeconds,
  foldDiacritics,
  isDivingEvent,
  stripEventGenderMarker,
} from './utils';
import { itemAt, regexGroup } from './indexedAccess';
import type { WorkspaceEditorPatch } from './swimEditor';
import { teamLabelKey } from '../data/teamAliases';

/**
 * Diacritic-folded normalized identity key for a name. Uses
 * `canonicalSwimmerName`, so "Last, First" folds to the same key as
 * "First Last" (single-comma heuristic — suffix forms like "Malone, Curtis,
 * Jr." are left untouched). Links store raw name strings and keys are always
 * computed here at build/lookup time, so pre-existing links stored with
 * comma-order spellings keep resolving after this fold was added.
 */
export function aliasNameKey(name: string): string {
  return foldDiacritics(canonicalSwimmerName(String(name ?? '')));
}

/**
 * Spelling-preserving identity key: same case/whitespace/comma folding as
 * `aliasNameKey` but diacritics are KEPT, so "Olivér Pózvai" and "Oliver Pozvai"
 * stay distinct.
 *
 * `aliasNameKey` is the *resolution* key (what unifies two names downstream);
 * this is the *pair* key (what identifies a specific spelling). The auto-linker
 * needs both: a diacritic-only pair still needs a link row (so the UI renders one
 * canonical spelling), and that row must be addressable for dedup/suppression —
 * which is impossible if both sides collapse to the same key.
 */
export function aliasIdentityKey(name: string): string {
  return canonicalSwimmerName(String(name ?? ''));
}

/** Order-independent key for a pair of spellings (used for dedup + suppression). */
export function aliasPairKey(a: string, b: string): string {
  return [aliasIdentityKey(a), aliasIdentityKey(b)].sort().join('||');
}

/** True when a stored row is a suppression tombstone rather than a live link. */
export function isAliasSuppression(link: AthleteAliasLink | null | undefined): boolean {
  return Boolean(link && link.status === 'suppressed');
}

// --- resolver ---------------------------------------------------------------

export interface AthleteAliasResolver {
  /** All links this resolver was built from. */
  readonly links: AthleteAliasLink[];
  /**
   * Resolve `name` to its canonical display name (transitively). Team/gender
   * scoped links take precedence over global (team-less) links. Returns the
   * input name unchanged when no link applies (identity default).
   */
  resolveAthleteName(name: string, team?: string, gender?: Gender): string;
  /** True when two names resolve to the same canonical identity in this scope. */
  areLinked(a: string, b: string, team?: string, gender?: Gender): boolean;
}

const SCOPE_SEP = '\u0000';

function scopeTeam(team?: string): string {
  return team != null && String(team).trim() !== '' ? String(team).trim() : '';
}

/**
 * Build an alias resolver from a Workspace (reads `athleteAliases`) or a raw
 * links array. An empty/absent set yields an identity resolver.
 *
 * Suppression tombstones (`status: 'suppressed'`) resolve nothing — they are
 * skipped here but retained on `resolver.links` so callers can see them.
 */
export function buildAliasResolver(source: Workspace | AthleteAliasLink[]): AthleteAliasResolver {
  const links = Array.isArray(source) ? source : source.athleteAliases ?? [];

  // aliasKey (scoped by gender[+team]) → canonicalName.
  const scoped = new Map<string, string>(); // `${gender}␀${team}␀${aliasKey}`
  const global = new Map<string, string>(); // `${gender}␀${aliasKey}`

  for (const link of links) {
    if (!link || !link.aliasName || !link.canonicalName) continue;
    if (isAliasSuppression(link)) continue;
    const ak = aliasNameKey(link.aliasName);
    if (!ak) continue;
    const team = scopeTeam(link.team);
    if (team) {
      const k = `${link.gender}${SCOPE_SEP}${team}${SCOPE_SEP}${ak}`;
      if (!scoped.has(k)) scoped.set(k, link.canonicalName);
    } else {
      const k = `${link.gender}${SCOPE_SEP}${ak}`;
      if (!global.has(k)) global.set(k, link.canonicalName);
    }
  }

  const lookupOnce = (nameKey: string, team?: string, gender?: Gender): string | null => {
    const t = scopeTeam(team);
    if (gender != null) {
      if (t) {
        const hit = scoped.get(`${gender}${SCOPE_SEP}${t}${SCOPE_SEP}${nameKey}`);
        if (hit != null) return hit;
      }
      const g = global.get(`${gender}${SCOPE_SEP}${nameKey}`);
      if (g != null) return g;
      return null;
    }
    // Gender unknown: fall back to any matching link (scoped first, then global).
    if (t) {
      for (const [k, v] of scoped) {
        if (k.endsWith(`${SCOPE_SEP}${t}${SCOPE_SEP}${nameKey}`)) return v;
      }
    }
    for (const [k, v] of global) {
      if (k.endsWith(`${SCOPE_SEP}${nameKey}`)) return v;
    }
    return null;
  };

  const resolveAthleteName = (name: string, team?: string, gender?: Gender): string => {
    let current = String(name ?? '');
    let currentKey = aliasNameKey(current);
    if (!currentKey) return current;
    const seen = new Set<string>([currentKey]);
    // Bounded to guarantee termination even on malformed data. Each hop is
    // applied first (so a diacritic-only alias like "Jose" → "José" still yields
    // the canonical display form), then we stop once a key repeats (cycle).
    for (let i = 0; i < 64; i += 1) {
      const next = lookupOnce(currentKey, team, gender);
      if (next == null) break;
      const nextKey = aliasNameKey(next);
      if (!nextKey) break;
      current = next;
      if (seen.has(nextKey)) break; // applied this hop; a repeat means a cycle
      seen.add(nextKey);
      currentKey = nextKey;
    }
    return current;
  };

  return {
    links,
    resolveAthleteName,
    areLinked: (a, b, team, gender) =>
      aliasNameKey(resolveAthleteName(a, team, gender)) ===
      aliasNameKey(resolveAthleteName(b, team, gender)),
  };
}

/** Shared identity resolver (no links) — the default for optional resolver args. */
export const IDENTITY_ALIAS_RESOLVER: AthleteAliasResolver = buildAliasResolver([]);

// --- add / remove (undo-able patches) ---------------------------------------

export type AddAliasLinkInput = {
  canonicalName: string;
  aliasName: string;
  gender: Gender;
  team?: string;
  source?: 'manual' | 'import';
  createdAt?: string;
  /** Audit trail. Defaults to `{ origin: 'user' }`. */
  provenance?: AliasLinkProvenance;
};

/** Does `link` describe the same unordered pair, in the same gender+team scope? */
function linkMatchesPair(
  link: AthleteAliasLink,
  pairKey: string,
  gender: Gender,
  team: string
): boolean {
  if (!link || link.gender !== gender) return false;
  if (scopeTeam(link.team) !== team) return false;
  return aliasPairKey(link.aliasName, link.canonicalName) === pairKey;
}

/**
 * Add a confirmed alias link (source defaults to 'manual'). Appended to
 * `athleteAliases`; inverse restores the prior array exactly.
 *
 * A human decision outranks the heuristic in both directions: if a suppression
 * tombstone exists for this exact pair/scope it is dropped, so explicitly
 * linking a previously-rejected pair works and stays linked.
 */
export function addAliasLink(workspace: Workspace, input: AddAliasLinkInput): WorkspaceEditorPatch {
  const base = workspace.athleteAliases ?? [];
  const team = scopeTeam(input.team);
  const pairKey = aliasPairKey(input.aliasName, input.canonicalName);
  const kept = base.filter(
    l => !(isAliasSuppression(l) && linkMatchesPair(l, pairKey, input.gender, team))
  );
  const link: AthleteAliasLink = {
    id: uuidv4(),
    gender: input.gender,
    canonicalName: input.canonicalName,
    aliasName: input.aliasName,
    source: input.source ?? 'manual',
    createdAt: input.createdAt ?? new Date().toISOString(),
    ...(team ? { team } : {}),
    ...(input.provenance ? { provenance: input.provenance } : {}),
  };
  return {
    patch: { athleteAliases: [...kept, link] },
    inverse: { athleteAliases: base },
    description: `Link "${input.aliasName}" → "${input.canonicalName}"`,
  };
}

/**
 * Remove an alias link by id (hard delete — leaves no tombstone, so the
 * auto-linker may propose the pair again). Use `unlinkAndSuppressAlias` when the
 * user is rejecting the pair rather than tidying up.
 */
export function removeAliasLink(workspace: Workspace, id: string): WorkspaceEditorPatch {
  const base = workspace.athleteAliases ?? [];
  const target = base.find(l => l.id === id);
  return {
    patch: { athleteAliases: base.filter(l => l.id !== id) },
    inverse: { athleteAliases: base },
    description: target
      ? `Unlink "${target.aliasName}" → "${target.canonicalName}"`
      : `Remove alias link ${id}`,
  };
}

// --- suppression (durable "do not link these two") --------------------------

export type SuppressAliasPairInput = {
  nameA: string;
  nameB: string;
  gender: Gender;
  team?: string;
  reason?: 'user_unlink' | 'user_reject';
  note?: string;
  createdAt?: string;
};

/**
 * Record a durable "these two names are NOT the same athlete" decision.
 *
 * Stored as a tombstone row inside `athleteAliases` (`status: 'suppressed'`) so
 * it persists through the existing `athlete_aliases` table with no schema change
 * and survives reload + re-import. The tombstone resolves nothing; it only
 * blocks the auto-linker (and the suggestion list) for that pair and scope.
 */
export function suppressAliasPair(
  workspace: Workspace,
  input: SuppressAliasPairInput
): WorkspaceEditorPatch {
  const base = workspace.athleteAliases ?? [];
  const team = scopeTeam(input.team);
  const pairKey = aliasPairKey(input.nameA, input.nameB);
  const now = input.createdAt ?? new Date().toISOString();
  // Drop any live link (and any earlier tombstone) for the same pair/scope.
  const kept = base.filter(l => !linkMatchesPair(l, pairKey, input.gender, team));
  const tombstone: AthleteAliasLink = {
    id: uuidv4(),
    gender: input.gender,
    canonicalName: input.nameA,
    aliasName: input.nameB,
    source: 'manual',
    createdAt: now,
    status: 'suppressed',
    ...(team ? { team } : {}),
    provenance: {
      origin: 'user',
      suppressedReason: input.reason ?? 'user_reject',
      suppressedAt: now,
      ...(input.note ? { note: input.note } : {}),
    },
  };
  return {
    patch: { athleteAliases: [...kept, tombstone] },
    inverse: { athleteAliases: base },
    description: `Never link "${input.nameB}" with "${input.nameA}"`,
  };
}

/**
 * Remove a live link AND record a tombstone for it, so re-running the import
 * cannot recreate it. This is the durable "unlink" the UI should call.
 */
export function unlinkAndSuppressAlias(
  workspace: Workspace,
  id: string,
  opts: { note?: string; createdAt?: string } = {}
): WorkspaceEditorPatch {
  const base = workspace.athleteAliases ?? [];
  const target = base.find(l => l.id === id && !isAliasSuppression(l));
  if (!target) return removeAliasLink(workspace, id);
  const ep = suppressAliasPair(workspace, {
    nameA: target.canonicalName,
    nameB: target.aliasName,
    gender: target.gender,
    team: target.team,
    reason: 'user_unlink',
    note: opts.note,
    createdAt: opts.createdAt,
  });
  return {
    ...ep,
    description: `Unlink "${target.aliasName}" → "${target.canonicalName}" (will not be re-linked)`,
  };
}

/** Drop a suppression tombstone by id, re-enabling auto-link for that pair. */
export function removeAliasSuppression(workspace: Workspace, id: string): WorkspaceEditorPatch {
  const base = workspace.athleteAliases ?? [];
  const target = base.find(l => l.id === id);
  return {
    patch: { athleteAliases: base.filter(l => l.id !== id) },
    inverse: { athleteAliases: base },
    description: target
      ? `Allow linking "${target.aliasName}" with "${target.canonicalName}" again`
      : `Remove alias suppression ${id}`,
  };
}

/** All suppression tombstones on a workspace / links array. */
export function listAliasSuppressions(
  source: Workspace | AthleteAliasLink[]
): AthleteAliasLink[] {
  const links = Array.isArray(source) ? source : source.athleteAliases ?? [];
  return links.filter(isAliasSuppression);
}

/** True when this pair carries a tombstone in the given gender+team scope. */
export function isAliasPairSuppressed(
  source: Workspace | AthleteAliasLink[],
  nameA: string,
  nameB: string,
  gender: Gender,
  team?: string
): boolean {
  const links = Array.isArray(source) ? source : source.athleteAliases ?? [];
  const pairKey = aliasPairKey(nameA, nameB);
  const t = scopeTeam(team);
  return links.some(l => {
    if (!isAliasSuppression(l)) return false;
    if (l.gender !== gender) return false;
    const linkTeam = scopeTeam(l.team);
    // A global (team-less) tombstone suppresses every team.
    if (linkTeam && t && linkTeam !== t) return false;
    return aliasPairKey(l.aliasName, l.canonicalName) === pairKey;
  });
}

// --- suggestion engine ------------------------------------------------------

export type AliasNameEntry = { name: string; team?: string; gender: Gender };

export type AliasSuggestion = {
  existing: AliasNameEntry;
  incoming: AliasNameEntry;
  score: number;
  reason: string;
};

export type SuggestAliasOptions = {
  /** Minimum score to include a suggestion (default 0.6). */
  minScore?: number;
  /** Existing links / resolver used to skip already-linked pairs. */
  resolver?: AthleteAliasResolver;
  links?: AthleteAliasLink[];
};

/** Split a name into folded tokens; hyphenated surnames become multiple tokens. */
function nameTokens(raw: string): string[] {
  let s = String(raw ?? '').trim();
  // "Last, First [Middle]" → "First Middle Last"
  const comma = s.indexOf(',');
  if (comma >= 0) {
    const last = s.slice(0, comma).trim();
    const rest = s.slice(comma + 1).trim();
    s = `${rest} ${last}`.trim();
  }
  return foldDiacritics(s.toLowerCase())
    .replace(/[.]/g, ' ')
    .split(/[\s-]+/)
    .map(t => t.trim())
    .filter(Boolean);
}

function hasComma(raw: string): boolean {
  return String(raw ?? '').includes(',');
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i += 1;
  return i;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let cur = new Array<number>(n + 1);
  for (let i = 1; i <= m; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      // Both rows hold n + 1 numbers and j runs 1..n, so each read is in range.
      cur[j] = Math.min(itemAt(prev, j) + 1, itemAt(cur, j - 1) + 1, itemAt(prev, j - 1) + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return itemAt(prev, n);
}

function isInitialToken(t: string): boolean {
  return t.length === 1;
}

/** True when every character of `short` appears in `long` in order. */
function isSubsequence(short: string, long: string): boolean {
  let i = 0;
  for (let j = 0; j < long.length && i < short.length; j += 1) {
    if (short[i] === long[j]) i += 1;
  }
  return i === short.length;
}

/**
 * `y` is deliberately EXCLUDED. Smith/Smyth is a name-distinguishing swap, not a
 * transliteration artifact; treating y as a vowel would let it through.
 */
const VOWELS = new Set(['a', 'e', 'i', 'o', 'u']);

/** Indices where two equal-length strings differ. */
function diffIndices(a: string, b: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) out.push(i);
  return out;
}

/**
 * How one name token relates to another. These classes are ORTHOGRAPHIC — they
 * are derived from the shape of the edit, never from a nickname table.
 *
 *  - `identical`     — equal after folding.
 *  - `truncation`    — one is a strict prefix of the other, ≥3 chars ("Cam" ⊂ "Camden").
 *  - `indel`         — exactly one character dropped/added, shorter is a subsequence
 *                      of the longer, ≥4 chars ("Afonso" / "Alfonso").
 *  - `vowel_swap`    — equal length ≥5, exactly ONE differing position at index ≥2,
 *                      and both characters are vowels ("Tristen" / "Tristin").
 *  - `prefix_family` — shared prefix ≥4, edit distance ≤2, both ≥5 chars
 *                      ("Stevie" / "Steven").
 *  - `initial`       — one side is a single letter matching the other's first letter.
 *  - `unrelated`     — everything else.
 *
 * WHY THIS SEPARATES "Alfonso"/"Afonso" (link) FROM "Jake"/"Jack" (do not link),
 * even though both look like tiny edits:
 *   · Alfonso→Afonso is a single DELETION and the short form is a subsequence of
 *     the long one — the signature of a transcription slip. Nothing about the
 *     name's letter sequence is contradicted, only its length.
 *   · Jake/Jack is edit distance 2 with a shared prefix of only 2 of 4 characters
 *     and neither string is a subsequence of the other. It matches no class.
 *   · The near-miss "Jake"/"Jane" (distance 1) is likewise rejected: the single
 *     differing character is a CONSONANT, and consonants are the identity-bearing
 *     part of a name. Only vowel-for-vowel swaps qualify.
 *   · And vowel swaps are additionally required to sit at index ≥2 in a name of
 *     ≥5 characters, so short names where the vowel IS the name ("Tom"/"Tim",
 *     "Dan"/"Don", "Jan"/"Jon") can never qualify — while a late unstressed-vowel
 *     difference ("Tristen"/"Tristin") still does.
 */
export type AliasTokenRelation =
  | 'identical'
  | 'truncation'
  | 'indel'
  | 'vowel_swap'
  | 'prefix_family'
  | 'initial'
  | 'unrelated';

/** `truncation` — the shorter token IS the other's opening, and is ≥3 chars. */
function isTruncationPair(short: string, prefixLen: number): boolean {
  return prefixLen === short.length && short.length >= 3;
}

/**
 * `indel` — exactly one character dropped or added, and the short form is a
 * SUBSEQUENCE of the long one. That combination is the signature of a
 * transcription slip: the letter sequence is never contradicted, only its
 * length ("Afonso" / "Alfonso").
 */
function isIndelPair(short: string, long: string, distance: number): boolean {
  return (
    long.length - short.length === 1 &&
    distance === 1 &&
    short.length >= 4 &&
    isSubsequence(short, long)
  );
}

/**
 * `vowel_swap` — equal length ≥5 with exactly ONE differing position, that
 * position at index ≥2, and a vowel on both sides. The length and index floors
 * are what keep "Tom"/"Tim" and "Dan"/"Don" out while admitting
 * "Tristen"/"Tristin"; consonants are identity-bearing and never qualify.
 */
function isVowelSwapPair(a: string, b: string): boolean {
  if (a.length !== b.length || a.length < 5) return false;
  const diffs = diffIndices(a, b);
  if (diffs.length !== 1) return false;
  const at = itemAt(diffs, 0);
  // `at` came from `diffIndices` over strings of equal length, so both reads are in range.
  return at >= 2 && VOWELS.has(a.charAt(at)) && VOWELS.has(b.charAt(at));
}

/** `prefix_family` — shared prefix ≥4, edit distance ≤2, both ≥5 ("Stevie"/"Steven"). */
function isPrefixFamilyPair(a: string, b: string, prefixLen: number, distance: number): boolean {
  return prefixLen >= 4 && distance <= 2 && a.length >= 5 && b.length >= 5;
}

/**
 * Classify how two folded name tokens relate. Pure; see AliasTokenRelation docs.
 *
 * The class checks run in PRECEDENCE ORDER and the order is load-bearing — a
 * pair that is both a truncation and a prefix family must report `truncation`,
 * which scores differently. This stays an ordered chain, never a lookup table.
 */
/**
 * Relations decidable without measuring the edit — an empty side, an exact
 * match, or an initial. Returns null when the pair needs the shape checks.
 *
 * An initial resolves here and never falls through: a single letter has no edit
 * shape to classify, so it either matches the other's first letter or the pair
 * is unrelated.
 */
function classifyTrivialTokenPair(a: string, b: string): AliasTokenRelation | null {
  if (!a || !b) return 'unrelated';
  if (a === b) return 'identical';
  if (!isInitialToken(a) && !isInitialToken(b)) return null;
  return a[0] === b[0] ? 'initial' : 'unrelated';
}

export function classifyNameToken(rawA: string, rawB: string): AliasTokenRelation {
  const a = String(rawA ?? '');
  const b = String(rawB ?? '');
  const trivial = classifyTrivialTokenPair(a, b);
  if (trivial) return trivial;

  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  const prefixLen = commonPrefixLen(a, b);
  const distance = levenshtein(a, b);

  if (isTruncationPair(short, prefixLen)) return 'truncation';
  if (isIndelPair(short, long, distance)) return 'indel';
  if (isVowelSwapPair(a, b)) return 'vowel_swap';
  if (isPrefixFamilyPair(a, b, prefixLen, distance)) return 'prefix_family';
  return 'unrelated';
}

/**
 * Surname relation. Deliberately narrower than the first-name classifier:
 * `truncation` and `prefix_family` are NOT accepted as surname variants
 * ("Camp"/"Campbell", "Johnson"/"Johnsen" are different families), leaving only
 * the two transcription-artifact shapes.
 */
export type AliasSurnameRelation = 'identical' | 'near' | 'unrelated';

export function classifySurname(a: string, b: string): AliasSurnameRelation {
  if (a === b) return 'identical';
  const rel = classifyNameToken(a, b);
  return rel === 'indel' || rel === 'vowel_swap' ? 'near' : 'unrelated';
}

/** Structural shape of the whole-name relation. */
export type AliasNameRelationKind =
  | 'reordered'
  | 'token_subset'
  | 'same_first_last'
  | 'first_variant'
  | 'first_initial'
  | 'near_surname';

export type AliasNameRelation = {
  score: number;
  reason: string;
  kind: AliasNameRelationKind;
  firstNameRelation: AliasTokenRelation;
  surnameRelation: AliasSurnameRelation;
  /**
   * May reach the `strong` tier (i.e. auto-link IF an exact individual-event time
   * corroborates the pair).
   */
  autoEligible: boolean;
  /**
   * May reach the `moderate` tier (auto-link on name evidence alone, given the
   * competed/import-only asymmetry). Strictly narrower than `autoEligible`.
   */
  moderateEligible: boolean;
};

/**
 * Highest-scoring relation wins. A tie keeps the FIRST one offered, so the rule
 * evaluation order below is load-bearing and must not be reordered.
 */
function createRelationPicker(
  firstNameRelation: AliasTokenRelation,
  surnameRelation: AliasSurnameRelation
) {
  let best: AliasNameRelation | null = null;
  return {
    consider(
      score: number,
      reason: string,
      kind: AliasNameRelationKind,
      autoEligible: boolean,
      moderateEligible: boolean
    ): void {
      if (score <= 0) return;
      if (best && score <= best.score) return;
      best = {
        score,
        reason,
        kind,
        firstNameRelation,
        surnameRelation,
        autoEligible,
        moderateEligible,
      };
    },
    result(): AliasNameRelation | null {
      return best;
    },
  };
}

type AliasRelationPicker = ReturnType<typeof createRelationPicker>;

/**
 * Rule 1 — token subset. Every token of the shorter name appears in the longer
 * one. Covers the SwimCloud long-form case and pure reorderings ("Last, First").
 *
 * Surname agreement is NOT required here: the Hispanic double-surname form
 * ("Alan Gonzalez Mujica" ⊂ "Alan Alejan Gonzalez Mujica") legitimately changes
 * which token lands last, and every token of the short name is still present in
 * the long one.
 */
function considerTokenSubset(
  pick: AliasRelationPicker,
  rawA: string,
  rawB: string,
  tokA: string[],
  tokB: string[],
  setA: Set<string>,
  setB: Set<string>
): void {
  const [shortSet, longSet, shortLen] =
    tokA.length <= tokB.length ? [setA, setB, tokA.length] : [setB, setA, tokB.length];
  if (shortLen < 2) return;
  for (const t of shortSet) {
    if (!longSet.has(t)) return;
  }
  if (setA.size !== setB.size) {
    pick.consider(
      0.9,
      'All name parts of the shorter name appear in the longer name',
      'token_subset',
      true,
      true
    );
    return;
  }
  const reason =
    hasComma(rawA) || hasComma(rawB)
      ? 'Name components match (comma order)'
      : 'Name components match (reordered)';
  pick.consider(0.97, reason, 'reordered', true, true);
}

/**
 * Rule 4 — the legacy shared-prefix score (Steve/Steven/Stevie). Kept
 * byte-identical so established suggestion scores do not move. It only becomes
 * auto-eligible when the token relation is genuinely `prefix_family`; a bare
 * shared prefix ("Erik"/"Eric") stays suggest-only.
 */
function considerSharedPrefixFallback(
  pick: AliasRelationPicker,
  firstA: string,
  firstB: string,
  firstNameRelation: AliasTokenRelation
): void {
  const p = commonPrefixLen(firstA, firstB);
  if (p < 3 || firstA === firstB) return;
  const d = levenshtein(firstA, firstB);
  if (d > 3) return;
  const score = Math.max(0, Math.min(0.88, 0.65 + 0.05 * Math.min(p, 6) - 0.03 * d));
  const eligible = firstNameRelation === 'prefix_family';
  pick.consider(
    score,
    `Same surname, first names share a ${p}-char prefix`,
    'first_variant',
    eligible,
    eligible
  );
}

/** Rules 2–4 — identical surname plus whatever the first names do. */
function considerIdenticalSurname(
  pick: AliasRelationPicker,
  firstA: string,
  firstB: string,
  firstNameRelation: AliasTokenRelation
): void {
  if (firstNameRelation === 'identical') {
    pick.consider(0.9, 'Same first and last name', 'same_first_last', true, true);
  }
  // Initial-vs-full first name ("S Balistreri" vs "Steven Balistreri").
  // Suggest-only: an initial cannot distinguish Jake from Jack.
  if (firstNameRelation === 'initial') {
    pick.consider(
      0.8,
      'First initial matches first name, same surname',
      'first_initial',
      false,
      false
    );
  }
  if (firstNameRelation === 'truncation') {
    const p = commonPrefixLen(firstA, firstB);
    const [shortForm, longForm] =
      firstA.length <= firstB.length ? [firstA, firstB] : [firstB, firstA];
    pick.consider(
      Math.min(0.88, 0.72 + 0.03 * Math.min(p, 6)),
      `Same surname, "${shortForm}" is a short form of "${longForm}"`,
      'first_variant',
      true,
      true
    );
  }
  if (firstNameRelation === 'indel' || firstNameRelation === 'vowel_swap') {
    pick.consider(
      0.84,
      firstNameRelation === 'indel'
        ? 'Same surname, first names differ by one dropped letter'
        : 'Same surname, first names differ by one vowel',
      'first_variant',
      true,
      true
    );
  }
  considerSharedPrefixFallback(pick, firstA, firstB, firstNameRelation);
}

/**
 * Rule 5 — near surname. NEVER enough on its own: "Ryan Johnson" /
 * "Ryan Johnston" is an indel surname with an identical first name and is two
 * different people. The whole branch is therefore capped at `strong`
 * (`moderateEligible: false`), so it needs exact individual-event time
 * corroboration to auto-link.
 */
function considerNearSurname(
  pick: AliasRelationPicker,
  firstNameRelation: AliasTokenRelation
): void {
  if (firstNameRelation === 'identical') {
    pick.consider(0.82, 'Same first name, surname differs by one letter', 'near_surname', true, false);
    return;
  }
  if (
    firstNameRelation === 'truncation' ||
    firstNameRelation === 'indel' ||
    firstNameRelation === 'vowel_swap' ||
    firstNameRelation === 'prefix_family'
  ) {
    pick.consider(
      0.74,
      'First and last name each differ by a one-letter spelling variant',
      'near_surname',
      true,
      false
    );
  }
}

/**
 * Full relation between two athlete names, or null when nothing relates them.
 * Scores are unchanged for every relation the previous heuristic already found,
 * so existing suggestion behavior and thresholds are preserved.
 */
export function classifyAliasNamePair(a: string, b: string): AliasNameRelation | null {
  const tokA = nameTokens(a);
  const tokB = nameTokens(b);
  if (tokA.length < 2 || tokB.length < 2) return null;

  const firstA = itemAt(tokA, 0);
  const firstB = itemAt(tokB, 0);
  const firstNameRelation = classifyNameToken(firstA, firstB);
  const surnameRelation = classifySurname(
    itemAt(tokA, tokA.length - 1),
    itemAt(tokB, tokB.length - 1)
  );

  // Rule order is load-bearing — see createRelationPicker.
  const pick = createRelationPicker(firstNameRelation, surnameRelation);
  considerTokenSubset(pick, a, b, tokA, tokB, new Set(tokA), new Set(tokB));
  if (surnameRelation === 'identical') {
    considerIdenticalSurname(pick, firstA, firstB, firstNameRelation);
  } else if (surnameRelation === 'near') {
    considerNearSurname(pick, firstNameRelation);
  }
  return pick.result();
}

/**
 * Score whether two entries plausibly name the same athlete. Returns the best
 * of several heuristics, or null when nothing relates them. Never auto-links —
 * scores are for UI confirmation only.
 */
function scoreNamePair(a: string, b: string): { score: number; reason: string } | null {
  const rel = classifyAliasNamePair(a, b);
  return rel ? { score: rel.score, reason: rel.reason } : null;
}

/**
 * Propose likely same-athlete pairs between two name sets (existing roster names
 * vs incoming import names). Pairs are gender-matched; already-linked and
 * identical-after-normalization pairs are excluded. Returns scored suggestions
 * sorted by descending score. NO hardcoded nickname tables; never auto-links.
 *
 * Pairs the user has explicitly rejected (suppression tombstones reachable via
 * `opts.resolver.links` / `opts.links`) are excluded too, so a rejected pair does
 * not come back on the next import.
 */
/** Resolver implied by the options: explicit, built from links, or identity. */
function resolverForSuggestOptions(opts: SuggestAliasOptions): AthleteAliasResolver {
  if (opts.resolver) return opts.resolver;
  return opts.links ? buildAliasResolver(opts.links) : IDENTITY_ALIAS_RESOLVER;
}

/**
 * Pairs that can never become a suggestion, checked cheapest-first: identical
 * after normalization (nothing to link), already resolving to one identity in
 * the incoming scope, or explicitly rejected by the user.
 */
function isIneligibleAliasPair(
  existing: AliasNameEntry,
  incoming: AliasNameEntry,
  exKey: string,
  inKey: string,
  resolver: AthleteAliasResolver,
  suppressions: AthleteAliasLink[]
): boolean {
  if (exKey === inKey) return true;
  const team = incoming.team ?? existing.team;
  if (resolver.areLinked(existing.name, incoming.name, team, incoming.gender)) return true;
  return (
    suppressions.length > 0 &&
    isAliasPairSuppressed(suppressions, existing.name, incoming.name, incoming.gender, team)
  );
}

function compareBySuggestionScore(a: AliasSuggestion, b: AliasSuggestion): number {
  return b.score - a.score;
}

export function suggestAliasCandidates(
  existingNames: AliasNameEntry[],
  incomingNames: AliasNameEntry[],
  opts: SuggestAliasOptions = {}
): AliasSuggestion[] {
  const minScore = opts.minScore ?? 0.6;
  const resolver = resolverForSuggestOptions(opts);
  const suppressions = listAliasSuppressions(opts.links ?? resolver.links ?? []);

  const out: AliasSuggestion[] = [];
  const seenPairs = new Set<string>();

  for (const incoming of incomingNames) {
    for (const existing of existingNames) {
      if (incoming.gender !== existing.gender) continue;

      const exKey = aliasNameKey(existing.name);
      const inKey = aliasNameKey(incoming.name);
      if (!exKey || !inKey) continue;
      if (isIneligibleAliasPair(existing, incoming, exKey, inKey, resolver, suppressions)) continue;

      const scored = scoreNamePair(existing.name, incoming.name);
      if (!scored || scored.score < minScore) continue;

      // Dedup symmetric / repeated pairs (by folded key + gender).
      const pairKey = `${[exKey, inKey].sort().join('|')}|${incoming.gender}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);

      out.push({ existing, incoming, score: scored.score, reason: scored.reason });
    }
  }

  return out.sort(compareBySuggestionScore);
}

// ============================================================================
// AUTO-LINK ENGINE
// ============================================================================
//
// Two tiers. `planAutoAliasLinks` decides which duplicate-name pairs are safe to
// merge WITHOUT asking, and demotes everything else to the existing suggestion
// flow (which is never collapsed — a demoted pair is still offered for manual
// confirmation).
//
// ---------------------------------------------------------------------------
// HARD BLOCKERS (a pair is never auto-linked when any of these holds)
// ---------------------------------------------------------------------------
//  1. `both_competed`         Both spellings appear in competed meet results. You
//                             cannot race yourself, so they are provably two
//                             different humans. This blocker rejects none of the
//                             real HSU pairs (in every one of them exactly one
//                             side competed and the other exists only in imported
//                             data) and it is what makes the relay-time trap
//                             unreachable in practice.
//  2. gender mismatch         Enforced by construction: candidates are only ever
//                             enumerated inside one gender.
//  3. `team_mismatch`         Different teams.
//  4. relay time evidence     Enforced BY CONSTRUCTION, not by a runtime check:
//                             `aliasIndividualEventKey` returns null for any relay
//                             event, so a relay row can never enter the evidence
//                             index and can never corroborate a pair. This matters
//                             because every leg of a relay carries the same team
//                             clock — "Stevie Balistreri" and "Tristen Fergunson"
//                             both show 1:31.73 on the Event 11 medley relay and
//                             are different people. Time corroboration is
//                             individual-event only, full stop.
//  5. `cluster_growth`        The link would grow an identity cluster past a
//                             simple pair (a transitive A->B->C merge). Three
//                             identities never merge automatically.
//  6. `ambiguous`             Either side has more than one auto-eligible partner.
//                             A human decides which one.
//  7. `user_linked_elsewhere` Either side is already linked BY A HUMAN to a
//                             different identity. A human decision always outranks
//                             the heuristic.
//  8. `suppressed`            The pair carries a suppression tombstone.
//  9. `already_linked`        Nothing to do (this is what makes apply idempotent).
//
// ---------------------------------------------------------------------------
// EVIDENCE TIERS
// ---------------------------------------------------------------------------
//  conclusive : the two spellings are identical after folding case, whitespace,
//               punctuation and diacritics ("Oliver Pozvai" / "Olivér Pózvai").
//               The fold key is already how identity is keyed downstream, so the
//               two rows are the same athlete by the codebase's own definition —
//               but nothing actually unifies the two DISPLAY spellings, which is
//               why the link row still has to exist.
//  strong     : a recognized name-variant relation (see AliasTokenRelation) PLUS
//               >=1 exact time shared on the same individual event and course,
//               across sources. Covers Ferguson (50 Free 20.59 + 100 Free 46.50)
//               and Mask (100 Breast 55.52). Times may legitimately DIFFER across
//               sources (a SwimCloud personal best vs this meet's swim), so a
//               mismatch is never evidence against a pair — only exact matches
//               count, and absence is neutral.
//  moderate   : `relation.moderateEligible` (identical surname + a first-name
//               variant class, or a token-subset/reordering) AND exactly one side
//               competed while the other is import-only. Covers Balistreri and
//               Campanico. A near-surname NEVER reaches this tier.
//  else       : suggestion only.
//
// ---------------------------------------------------------------------------
// MERGE SEMANTICS
// ---------------------------------------------------------------------------
//  · CANONICAL NAME: the side that appears in competed meet results wins, because
//    that is the official published record. Blocker 1 guarantees at most one side
//    competed, so this is unambiguous. If neither side competed, the spelling
//    with more evidence rows wins; ties break on `aliasIdentityKey` ascending, so
//    the outcome never depends on input ordering.
//  · SWIMS: nothing moves. A link is a read-time identity mapping only — no row
//    in menResults / athleteHistory / recruits / meetEntryPlans is rewritten,
//    deleted or re-keyed. Downstream consumers resolve the alias to the canonical
//    name when they group by athlete, so both sides' swims appear under one
//    identity, and removing the link restores both identities intact.
//  · CLASS YEAR: not copied. Class year is carried on the roster / recruit rows,
//    which are untouched; the canonical athlete keeps their own. This is what
//    makes the merge fully reversible.
//  · REVERSIBLE: every apply returns an `inverse` patch, and
//    `unlinkAndSuppressAlias` both removes the link and records a tombstone so a
//    re-import cannot recreate it.
//  · IDEMPOTENT: a pair that already has a link row (live or tombstone) in the
//    same scope is skipped, so applying twice is a no-op.

/** Course a time was swum in. Times only corroborate within the same course. */
export type AliasCourse = 'SCY' | 'LCM' | 'SCM';

const INDIVIDUAL_STROKES: readonly string[] = [
  'freestyle',
  'backstroke',
  'breaststroke',
  'butterfly',
  'individual medley',
];

const STROKE_EXPANSIONS: [RegExp, string][] = [
  [/\bfly\b/g, 'butterfly'],
  [/\bback\b/g, 'backstroke'],
  [/\bbreast\b/g, 'breaststroke'],
  [/\bfree\b/g, 'freestyle'],
  [/\bim\b/g, 'individual medley'],
];

/**
 * Normalized `"<distance> <stroke>"` key for an INDIVIDUAL event, or null.
 *
 * Returns null for relays (see hard blocker 4 — this is the construction that
 * makes relay times inadmissible), diving, and anything that is not a plain
 * distance+stroke label. Handles both the HyTek meet form
 * ("Event 26 Men 100 Yard Breaststroke") and the bare import form
 * ("100 Breaststroke"), so a meet swim and a SwimCloud row land on the same key.
 */
export function aliasIndividualEventKey(raw: string): string | null {
  const source = String(raw ?? '');
  if (!source.trim()) return null;
  if (/\brelay\b/i.test(source)) return null;
  if (isDivingEvent(source)) return null;

  let e = stripEventGenderMarker(source).toLowerCase();
  e = e.replace(/\bevent\s+\d+\b/g, ' ');
  e = e.replace(/\b(yards?|meters?|metres?|mtr|scy|scm|lcm)\b/g, ' ');
  e = e.replace(/[()]/g, ' ');
  e = e.replace(/\s+/g, ' ').trim();
  for (const [re, full] of STROKE_EXPANSIONS) {
    if (e.includes(full)) break;
    if (re.test(e)) {
      e = e.replace(re, full);
      break;
    }
  }
  e = e.replace(/\s+/g, ' ').trim();
  const m = e.match(/^(\d{2,4}) (.+)$/);
  if (!m) return null;
  const distance = regexGroup(m, 1);
  const stroke = regexGroup(m, 2);
  return INDIVIDUAL_STROKES.includes(stroke) ? `${distance} ${stroke}` : null;
}

/** Course implied by a HyTek meet event label (yards unless it says meters). */
function courseFromEventLabel(event: string): AliasCourse {
  return /\bmet(?:er|re)s?\b|\bmtr\b/i.test(String(event ?? '')) ? 'LCM' : 'SCY';
}

/** `${course}@${seconds}` — the exact-match key. Null for NT / DQ / unparseable. */
function timeEvidenceKey(time: string, course: AliasCourse): string | null {
  const raw = String(time ?? '').trim();
  if (!raw) return null;
  const secs = convertTimeToSeconds(raw);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return `${course}@${secs.toFixed(2)}`;
}

export type AliasEvidenceOrigin = 'meet' | 'history' | 'recruit' | 'plan' | 'incoming';

/** Everything the auto-linker knows about one spelling of one athlete. */
export interface AliasAthleteEvidence {
  /** Display spelling (prefers the competed spelling when several fold together). */
  name: string;
  /** `aliasIdentityKey` — diacritics preserved. */
  identityKey: string;
  /** `aliasNameKey` — diacritics folded. */
  foldKey: string;
  team: string;
  teamKey: string;
  gender: Gender;
  /** True when the name appears on a competed meet result row. */
  competed: boolean;
  /** Total rows attributed to this spelling (used only for canonical tie-breaks). */
  swimCount: number;
  /**
   * individual event key -> (time evidence key -> display time). RELAY ROWS ARE
   * NEVER PRESENT — see hard blocker 4.
   */
  individualTimes: Map<string, Map<string, string>>;
  origins: AliasEvidenceOrigin[];
}

export interface AliasEvidenceIndex {
  athletes: AliasAthleteEvidence[];
  /** `${gender}|${teamKey}|${identityKey}` -> entry. */
  byKey: Map<string, AliasAthleteEvidence>;
}

export type BuildAliasEvidenceOptions = {
  /** Not-yet-applied import rows, treated as import-only evidence. */
  incoming?: HistoricalSwim[];
  /** Restrict to one team (raw name; compared case-insensitively). */
  team?: string;
  /** Restrict to one gender. */
  gender?: Gender;
};

// The same key as `teamLabelKey` (data/teamAliases.ts): trim and lower-case.
function teamKeyOf(team: string | undefined | null): string {
  return teamLabelKey(team);
}

function evidenceMapKey(gender: Gender, teamKey: string, identityKey: string): string {
  return `${gender}|${teamKey}|${identityKey}`;
}

/**
 * Build the per-spelling evidence index a workspace supports.
 *
 * Sources and what each contributes:
 *   · menResults / womenResults + sourceMenResults / sourceWomenResults -> competed
 *     (the frozen PDF copy is included so an athlete who was soft-removed from the
 *     working roster still counts as having raced — that only makes blocker 1
 *     stricter, never looser).
 *   · athleteHistory / recruits / meetEntryPlans / opts.incoming -> import-only.
 *   · Psych-sheet rows are deliberately excluded from BOTH competed status and
 *     time evidence: they are seed projections, not swims.
 *
 * Relay rows contribute presence (a leg is a real appearance at the meet) but
 * never a time — `aliasIndividualEventKey` rejects them.
 */
/** True when a row passes the caller's `{ team, gender }` restriction. */
function isInEvidenceScope(
  opts: BuildAliasEvidenceOptions,
  wantTeam: string | null,
  gender: Gender,
  teamKey: string
): boolean {
  if (opts.gender != null && gender !== opts.gender) return false;
  return wantTeam == null || teamKey === wantTeam;
}

/** A fresh, empty evidence row for one spelling of one athlete. */
function newAliasEvidence(
  name: string,
  team: string,
  teamKey: string,
  gender: Gender,
  identityKey: string
): AliasAthleteEvidence {
  return {
    name: String(name).trim(),
    identityKey,
    foldKey: aliasNameKey(name),
    team: String(team ?? '').trim(),
    teamKey,
    gender,
    competed: false,
    swimCount: 0,
    individualTimes: new Map(),
    origins: [],
  };
}

/**
 * Result rows that are not one athlete's swim, and so contribute no evidence:
 *
 *  · blank rows;
 *  · psych-sheet rows — seed projections, not swims, so they confer neither
 *    competed status nor a time;
 *  · relay placeholder rows, which carry the school name in the athlete column.
 */
function isNonAthleteResultRow(r: SwimmerResult): boolean {
  if (!r || !r.name) return true;
  if (r.isPsychSheet) return true;
  return String(r.name).trim() === String(r.team ?? '').trim();
}

export function buildAliasEvidenceIndex(
  workspace: Workspace,
  opts: BuildAliasEvidenceOptions = {}
): AliasEvidenceIndex {
  const byKey = new Map<string, AliasAthleteEvidence>();
  const wantTeam = opts.team != null ? teamKeyOf(opts.team) : null;

  const touch = (
    name: string,
    team: string,
    gender: Gender,
    competed: boolean,
    origin: AliasEvidenceOrigin
  ): AliasAthleteEvidence | null => {
    const identityKey = aliasIdentityKey(name);
    if (!identityKey) return null;
    const tk = teamKeyOf(team);
    if (!isInEvidenceScope(opts, wantTeam, gender, tk)) return null;
    const key = evidenceMapKey(gender, tk, identityKey);
    let entry = byKey.get(key);
    if (!entry) {
      entry = newAliasEvidence(name, team, tk, gender, identityKey);
      byKey.set(key, entry);
    }
    // Prefer the competed spelling for display (the official record).
    if (competed && !entry.competed) entry.name = String(name).trim();
    if (competed) entry.competed = true;
    entry.swimCount += 1;
    if (!entry.origins.includes(origin)) entry.origins.push(origin);
    return entry;
  };

  const addTime = (
    entry: AliasAthleteEvidence | null,
    event: string,
    time: string,
    course: AliasCourse
  ): void => {
    if (!entry) return;
    const ev = aliasIndividualEventKey(event);
    if (!ev) return; // relay / diving / non-program label -> inadmissible
    const tk = timeEvidenceKey(time, course);
    if (!tk) return;
    let times = entry.individualTimes.get(ev);
    if (!times) {
      times = new Map();
      entry.individualTimes.set(ev, times);
    }
    if (!times.has(tk)) times.set(tk, String(time).trim());
  };

  const addResults = (rows: SwimmerResult[] | undefined, gender: Gender): void => {
    for (const r of rows ?? []) {
      if (isNonAthleteResultRow(r)) continue;
      const entry = touch(r.name, r.team, r.gender ?? gender, true, 'meet');
      const course = courseFromEventLabel(r.event);
      for (const t of [r.time, r.prelimsTime, r.finalsTime]) {
        if (t) addTime(entry, r.event, t, course);
      }
    }
  };

  addResults(workspace.menResults, Gender.MEN);
  addResults(workspace.sourceMenResults, Gender.MEN);
  addResults(workspace.womenResults, Gender.WOMEN);
  addResults(workspace.sourceWomenResults, Gender.WOMEN);

  const addSwims = (rows: HistoricalSwim[] | undefined, origin: AliasEvidenceOrigin): void => {
    for (const s of rows ?? []) {
      if (!s || !s.name) continue;
      const entry = touch(s.name, s.team, s.gender, false, origin);
      addTime(entry, s.event, s.time, (s.timeType as AliasCourse) ?? 'SCY');
    }
  };
  addSwims(workspace.athleteHistory, 'history');
  addSwims(opts.incoming, 'incoming');

  for (const r of (workspace.recruits ?? []) as Recruit[]) {
    if (!r || !r.name) continue;
    const entry = touch(r.name, r.team, r.gender, false, 'recruit');
    addTime(entry, r.event, r.time, (r.timeType as AliasCourse) ?? 'SCY');
  }
  for (const p of (workspace.meetEntryPlans ?? []) as PlannedSwimEntry[]) {
    if (!p || !p.name) continue;
    const entry = touch(p.name, p.team, p.gender, false, 'plan');
    addTime(entry, p.event, p.time, (p.timeType as AliasCourse) ?? 'SCY');
  }

  return { athletes: [...byKey.values()], byKey };
}

/**
 * Exact individual-event time matches between two spellings, sorted
 * deterministically. Relay times can never appear here (blocker 4).
 */
export function aliasTimeCorroboration(
  a: AliasAthleteEvidence,
  b: AliasAthleteEvidence
): AliasTimeMatch[] {
  const out: AliasTimeMatch[] = [];
  for (const [event, timesA] of a.individualTimes) {
    const timesB = b.individualTimes.get(event);
    if (!timesB) continue;
    // Defensive re-check: nothing relay-shaped may ever corroborate a pair.
    if (!aliasIndividualEventKey(event)) continue;
    for (const [key, display] of timesA) {
      if (!timesB.has(key)) continue;
      out.push({ event, time: display, course: key.split('@')[0] as AliasCourse });
    }
  }
  return out.sort((x, y) =>
    x.event === y.event ? x.time.localeCompare(y.time) : x.event.localeCompare(y.event)
  );
}

export type AliasAutoLinkBlocker =
  | 'both_competed'
  | 'team_mismatch'
  | 'cluster_growth'
  | 'ambiguous'
  | 'user_linked_elsewhere'
  | 'suppressed'
  | 'already_linked';

export interface AliasAutoLinkDecision {
  /** Winning spelling (competed side when known). See MERGE SEMANTICS above. */
  canonicalName: string;
  /** Spelling that will resolve to `canonicalName`. */
  aliasName: string;
  gender: Gender;
  team: string;
  tier: AliasEvidenceTier;
  rule: AliasAutoRule;
  score: number;
  reason: string;
  timeMatches: AliasTimeMatch[];
  competedSide: 'canonical' | 'alias' | 'neither';
}

export interface AliasAutoLinkRejection {
  canonicalName: string;
  aliasName: string;
  gender: Gender;
  team: string;
  /** Tier the pair would have reached if the blocker had not fired. */
  tier: AliasEvidenceTier | null;
  score: number;
  reason: string;
  blocker: AliasAutoLinkBlocker;
}

export interface AliasAutoLinkPlan {
  /** Safe to apply without asking. Deterministically ordered. */
  autoLinks: AliasAutoLinkDecision[];
  /** Would have auto-linked, but a hard blocker fired. Auditable. */
  rejected: AliasAutoLinkRejection[];
  /** Below the auto bar (or blocked) — offer for manual confirmation as before. */
  suggestions: AliasSuggestion[];
}

export type PlanAutoAliasOptions = BuildAliasEvidenceOptions & {
  /** Prebuilt index (skips a rebuild when the UI already has one). */
  index?: AliasEvidenceIndex;
  /** Lowest tier eligible for auto-link. Default `'moderate'`. */
  minTier?: AliasEvidenceTier;
  /** Suggestion cut-off (default 0.6, matching suggestAliasCandidates). */
  suggestMinScore?: number;
};

const TIER_RANK: Record<AliasEvidenceTier, number> = {
  conclusive: 3,
  strong: 2,
  moderate: 1,
};

/** Canonical selection: competed wins, then more evidence, then key order. */
function canonicalPreference(a: AliasAthleteEvidence, b: AliasAthleteEvidence): number {
  if (a.competed !== b.competed) return a.competed ? -1 : 1;
  if (a.swimCount !== b.swimCount) return b.swimCount - a.swimCount;
  return a.identityKey.localeCompare(b.identityKey);
}

type AliasAutoCandidate = AliasAutoLinkDecision & {
  canon: AliasAthleteEvidence;
  other: AliasAthleteEvidence;
};

function rejectionOf(c: AliasAutoCandidate, blocker: AliasAutoLinkBlocker): AliasAutoLinkRejection {
  return {
    canonicalName: c.canonicalName,
    aliasName: c.aliasName,
    gender: c.gender,
    team: c.team,
    tier: c.tier,
    score: c.score,
    reason: c.reason,
    blocker,
  };
}

/** Drop the internal evidence handles a candidate carries for sorting. */
function decisionOf(c: AliasAutoCandidate): AliasAutoLinkDecision {
  return {
    canonicalName: c.canonicalName,
    aliasName: c.aliasName,
    gender: c.gender,
    team: c.team,
    tier: c.tier,
    rule: c.rule,
    score: c.score,
    reason: c.reason,
    timeMatches: c.timeMatches,
    competedSide: c.competedSide,
  };
}

/** Reason text for a pair that folds to one key. Tier `conclusive`. */
const FOLD_IDENTICAL_REASON = 'Identical name after folding case, punctuation and accents';

// --- plan: fixed inputs -----------------------------------------------------

/** Everything the pair sweep consults that is fixed for the whole run. */
type AliasPlanContext = {
  /** Scope keys for pairs that already carry a link row or a tombstone. */
  recordedPairs: Set<string>;
  /** identityKey -> identity keys a HUMAN has bound it to. */
  userLinkedKeys: Map<string, Set<string>>;
  suppressions: AthleteAliasLink[];
  resolver: AthleteAliasResolver;
  /** `TIER_RANK` floor a pair must clear to be auto-linkable at all. */
  minTierRank: number;
};

/**
 * Scope keys for every pair that already has a record — live link OR tombstone.
 * Both the team-scoped key and a team-less key are stored, so a decision made
 * under one team blocks the pair in every scope. This is what makes apply
 * idempotent.
 */
function buildRecordedPairKeys(links: AthleteAliasLink[]): Set<string> {
  const out = new Set<string>();
  for (const l of links) {
    if (!l || !l.aliasName || !l.canonicalName) continue;
    const pk = aliasPairKey(l.aliasName, l.canonicalName);
    out.add(`${l.gender}|${scopeTeam(l.team).toLowerCase()}|${pk}`);
    out.add(`${l.gender}||${pk}`);
  }
  return out;
}

/**
 * identityKey -> the identity keys a HUMAN has committed it to, in both
 * directions. Tombstones and heuristic (`provenance.origin === 'auto'`) links
 * are excluded: only a human decision outranks the heuristic.
 */
function buildUserLinkedKeys(links: AthleteAliasLink[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const l of links) {
    if (!l || !l.aliasName || !l.canonicalName) continue;
    if (isAliasSuppression(l)) continue;
    if (l.provenance && l.provenance.origin === 'auto') continue; // heuristic, not a human
    const ka = aliasIdentityKey(l.aliasName);
    const kc = aliasIdentityKey(l.canonicalName);
    if (!out.has(ka)) out.set(ka, new Set());
    if (!out.has(kc)) out.set(kc, new Set());
    (out.get(ka) as Set<string>).add(kc);
    (out.get(kc) as Set<string>).add(ka);
  }
  return out;
}

// --- plan: deterministic orderings ------------------------------------------

/** Sweep order: gender, then team, then identity key. */
function compareEvidenceForSweep(a: AliasAthleteEvidence, b: AliasAthleteEvidence): number {
  if (a.gender !== b.gender) return String(a.gender).localeCompare(String(b.gender));
  if (a.teamKey !== b.teamKey) return a.teamKey.localeCompare(b.teamKey);
  return a.identityKey.localeCompare(b.identityKey);
}

/** Strongest evidence first, then score, then names. */
function compareAutoCandidates(x: AliasAutoCandidate, y: AliasAutoCandidate): number {
  return (
    TIER_RANK[y.tier] - TIER_RANK[x.tier] ||
    y.score - x.score ||
    x.canon.identityKey.localeCompare(y.canon.identityKey) ||
    x.other.identityKey.localeCompare(y.other.identityKey)
  );
}

function comparePlanSuggestions(x: AliasSuggestion, y: AliasSuggestion): number {
  return (
    y.score - x.score ||
    x.existing.name.localeCompare(y.existing.name) ||
    x.incoming.name.localeCompare(y.incoming.name)
  );
}

function compareRejections(x: AliasAutoLinkRejection, y: AliasAutoLinkRejection): number {
  return (
    x.blocker.localeCompare(y.blocker) ||
    y.score - x.score ||
    x.canonicalName.localeCompare(y.canonicalName)
  );
}

// --- plan: per-pair evidence ------------------------------------------------

/** Which side of the pair holds the official competed record, if either. */
function competedSideOf(
  canon: AliasAthleteEvidence,
  other: AliasAthleteEvidence
): 'canonical' | 'alias' | 'neither' {
  if (canon.competed) return 'canonical';
  if (other.competed) return 'alias';
  return 'neither';
}

/**
 * Evidence tier and the rule that produced it, or `tier: null` when the pair
 * never cleared the bar. See the EVIDENCE TIERS note above for what each tier
 * means; `minTierRank` is the caller's floor.
 */
function evaluatePairTier(
  foldIdentical: boolean,
  relation: AliasNameRelation | null,
  timeMatches: AliasTimeMatch[],
  canon: AliasAthleteEvidence,
  other: AliasAthleteEvidence,
  minTierRank: number
): { tier: AliasEvidenceTier | null; rule: AliasAutoRule } {
  let tier: AliasEvidenceTier | null = null;
  let rule: AliasAutoRule = 'identical_after_folding';
  if (foldIdentical) {
    tier = 'conclusive';
    rule = 'identical_after_folding';
  } else if (relation != null && relation.autoEligible && timeMatches.length >= 1) {
    tier = 'strong';
    rule = 'name_variant_time_corroborated';
  } else if (relation != null && relation.moderateEligible && canon.competed !== other.competed) {
    tier = 'moderate';
    rule = 'name_variant_import_only';
  }
  if (tier != null && TIER_RANK[tier] < minTierRank) tier = null;
  return { tier, rule };
}

/**
 * Everything decided about one enumerated pair BEFORE the hard blockers run:
 * which spelling is canonical, the score and reason, the corroborating times,
 * and the tier reached. The returned `tier` is the real one (possibly null);
 * `candidate.tier` carries a placeholder that only ever reaches an accepted
 * candidate, where the real tier is non-null by construction.
 */
function buildAutoCandidate(
  a: AliasAthleteEvidence,
  b: AliasAthleteEvidence,
  foldIdentical: boolean,
  relation: AliasNameRelation | null,
  minTierRank: number
): { candidate: AliasAutoCandidate; tier: AliasEvidenceTier | null } {
  // Canonical = competed side; deterministic tie-break otherwise.
  const [canon, other] = canonicalPreference(a, b) <= 0 ? [a, b] : [b, a];
  const score = foldIdentical ? 1 : (relation as AliasNameRelation).score;
  const reason = foldIdentical ? FOLD_IDENTICAL_REASON : (relation as AliasNameRelation).reason;
  const timeMatches = aliasTimeCorroboration(canon, other);
  const { tier, rule } = evaluatePairTier(
    foldIdentical,
    relation,
    timeMatches,
    canon,
    other,
    minTierRank
  );
  return {
    tier,
    candidate: {
      canonicalName: canon.name,
      aliasName: other.name,
      gender: a.gender,
      team: canon.team || other.team,
      tier: (tier ?? 'moderate') as AliasEvidenceTier,
      rule,
      score,
      reason,
      timeMatches,
      competedSide: competedSideOf(canon, other),
      canon,
      other,
    },
  };
}

// --- plan: hard blockers ----------------------------------------------------

/** Two evidence rows are only ever compared inside one gender, across identities. */
function isComparablePair(a: AliasAthleteEvidence, b: AliasAthleteEvidence): boolean {
  return a.gender === b.gender && a.identityKey !== b.identityKey;
}

/** True when a live link or a tombstone already records this exact pair. */
function hasRecordedPair(
  recordedPairs: Set<string>,
  a: AliasAthleteEvidence,
  b: AliasAthleteEvidence
): boolean {
  const pk = aliasPairKey(a.name, b.name);
  return (
    recordedPairs.has(`${a.gender}|${a.teamKey}|${pk}`) || recordedPairs.has(`${a.gender}||${pk}`)
  );
}

/** True when a HUMAN has already bound either side to a DIFFERENT identity. */
function isUserLinkedElsewhere(
  userLinkedKeys: Map<string, Set<string>>,
  a: AliasAthleteEvidence,
  b: AliasAthleteEvidence
): boolean {
  const aPartners = userLinkedKeys.get(a.identityKey);
  const bPartners = userLinkedKeys.get(b.identityKey);
  return Boolean(
    (aPartners && aPartners.size > 0 && !aPartners.has(b.identityKey)) ||
      (bPartners && bPartners.size > 0 && !bPartners.has(a.identityKey))
  );
}

/**
 * What to do with one enumerated pair. Exactly one of `accept` / `suggest` /
 * a silent block applies.
 */
type AliasPairDisposition = {
  /** Blocker to record, or null when nothing blocked the pair. */
  blocker: AliasAutoLinkBlocker | null;
  /**
   * Record the rejection even when the pair never cleared the tier bar. True
   * only for the "a decision already exists" blockers, which are reported
   * regardless of evidence so the audit shows why nothing happened.
   */
  reportUntiered: boolean;
  /** Offer the pair for manual confirmation instead. */
  suggest: boolean;
  /** Keep the pair as an auto-link candidate. */
  accept: boolean;
};

const ACCEPT_PAIR: AliasPairDisposition = {
  blocker: null,
  reportUntiered: false,
  suggest: false,
  accept: true,
};
const DEMOTE_PAIR: AliasPairDisposition = {
  blocker: null,
  reportUntiered: false,
  suggest: true,
  accept: false,
};
const blockQuietly = (
  blocker: AliasAutoLinkBlocker,
  reportUntiered = false
): AliasPairDisposition => ({ blocker, reportUntiered, suggest: false, accept: false });
const blockButSuggest = (blocker: AliasAutoLinkBlocker): AliasPairDisposition => ({
  blocker,
  reportUntiered: false,
  suggest: true,
  accept: false,
});

/**
 * The hard blockers, IN PRECEDENCE ORDER — see the HARD BLOCKERS note above.
 * The order is load-bearing: an already-recorded pair must report
 * `already_linked` / `suppressed` rather than the blocker a later rule would
 * have found, so this stays an ordered chain and never a lookup table.
 */
function dispositionForPair(
  a: AliasAthleteEvidence,
  b: AliasAthleteEvidence,
  ctx: AliasPlanContext,
  foldIdentical: boolean,
  tier: AliasEvidenceTier | null
): AliasPairDisposition {
  if (a.teamKey !== b.teamKey) return blockQuietly('team_mismatch');
  if (hasRecordedPair(ctx.recordedPairs, a, b)) {
    const suppressed = isAliasPairSuppressed(ctx.suppressions, a.name, b.name, a.gender, a.team);
    return blockQuietly(suppressed ? 'suppressed' : 'already_linked', true);
  }
  // Non-trivially resolve to the same identity already (A->B, B->C chains).
  if (!foldIdentical && ctx.resolver.areLinked(a.name, b.name, a.team, a.gender)) {
    return blockQuietly('already_linked', true);
  }
  if (a.competed && b.competed) return blockButSuggest('both_competed');
  if (isUserLinkedElsewhere(ctx.userLinkedKeys, a, b)) return blockButSuggest('user_linked_elsewhere');
  return tier == null ? DEMOTE_PAIR : ACCEPT_PAIR;
}

// --- plan: collectors and passes --------------------------------------------

/** Demoted pairs, with the score floor applied once at the point of collection. */
function createSuggestionCollector(minScore: number) {
  const out: AliasSuggestion[] = [];
  return {
    out,
    add(
      canonName: string,
      canonTeam: string,
      otherName: string,
      otherTeam: string,
      gender: Gender,
      score: number,
      reason: string
    ): void {
      if (score < minScore) return;
      out.push({
        existing: { name: canonName, team: canonTeam, gender },
        incoming: { name: otherName, team: otherTeam, gender },
        score,
        reason,
      });
    },
  };
}

type AliasSuggestionCollector = ReturnType<typeof createSuggestionCollector>;

/**
 * Route one decided pair to its outcome: a recorded rejection, a manual
 * suggestion, an accepted candidate, or nothing at all.
 *
 * A rejection's `tier` means "tier the pair would have reached", so it is the
 * real (possibly null) tier — never the candidate's placeholder. A pair that
 * never cleared the tier bar is only recorded for the blockers that report
 * untiered, so the audit still shows an existing decision.
 */
function recordPairOutcome(
  candidate: AliasAutoCandidate,
  tier: AliasEvidenceTier | null,
  disposition: AliasPairDisposition,
  rejected: AliasAutoLinkRejection[],
  suggestions: AliasSuggestionCollector,
  candidates: AliasAutoCandidate[]
): void {
  if (disposition.blocker != null && (tier != null || disposition.reportUntiered)) {
    rejected.push({ ...rejectionOf(candidate, disposition.blocker), tier });
  }
  if (disposition.suggest) {
    suggestions.add(
      candidate.canonicalName,
      candidate.canon.team,
      candidate.aliasName,
      candidate.other.team,
      candidate.gender,
      candidate.score,
      candidate.reason
    );
  }
  if (disposition.accept) candidates.push(candidate);
}

/**
 * Enumerate every same-gender pair of spellings once, and sort each into an
 * auto-link candidate, a recorded rejection, or a manual suggestion.
 */
function sweepAliasPairs(
  athletes: AliasAthleteEvidence[],
  ctx: AliasPlanContext,
  rejected: AliasAutoLinkRejection[],
  suggestions: AliasSuggestionCollector
): AliasAutoCandidate[] {
  const candidates: AliasAutoCandidate[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < athletes.length; i += 1) {
    for (let j = i + 1; j < athletes.length; j += 1) {
      const a = itemAt(athletes, i);
      const b = itemAt(athletes, j);
      if (!isComparablePair(a, b)) continue;

      const foldIdentical = a.foldKey === b.foldKey;
      const relation = classifyAliasNamePair(a.name, b.name);
      if (!foldIdentical && !relation) continue;

      const pairId = `${a.gender}|${a.teamKey}|${aliasPairKey(a.name, b.name)}`;
      if (seen.has(pairId)) continue;
      seen.add(pairId);

      const { candidate, tier } = buildAutoCandidate(a, b, foldIdentical, relation, ctx.minTierRank);
      const disposition = dispositionForPair(a, b, ctx, foldIdentical, tier);
      recordPairOutcome(candidate, tier, disposition, rejected, suggestions, candidates);
    }
  }
  return candidates;
}

/** How many auto-eligible partners each identity key has across the candidates. */
function countPartnersByIdentity(candidates: AliasAutoCandidate[]): Map<string, number> {
  const degree = new Map<string, number>();
  const bump = (k: string): void => {
    degree.set(k, (degree.get(k) ?? 0) + 1);
  };
  for (const c of candidates) {
    bump(c.canon.identityKey);
    bump(c.other.identityKey);
  }
  return degree;
}

/** Hard blocker 6: either spelling has more than one auto-eligible partner. */
function isContestedCandidate(
  partners: Map<string, number>,
  c: AliasAutoCandidate
): boolean {
  return (partners.get(c.canon.identityKey) ?? 0) > 1 || (partners.get(c.other.identityKey) ?? 0) > 1;
}

/**
 * Split candidates on hard blocker 6: a spelling with more than one
 * auto-eligible partner is never merged, because a human has to pick which one.
 */
function partitionAmbiguousCandidates(candidates: AliasAutoCandidate[]): {
  unambiguous: AliasAutoCandidate[];
  ambiguous: AliasAutoCandidate[];
} {
  const partners = countPartnersByIdentity(candidates);
  const unambiguous: AliasAutoCandidate[] = [];
  const ambiguous: AliasAutoCandidate[] = [];
  for (const c of candidates) {
    if (isContestedCandidate(partners, c)) ambiguous.push(c);
    else unambiguous.push(c);
  }
  return { unambiguous, ambiguous };
}

/**
 * Union-find over identity keys, used only to answer "how big would the cluster
 * be if this pair were linked?". Deliberately without path compression — the
 * `guard` bound is what guarantees termination on malformed data.
 */
function createIdentityClusters() {
  const parent = new Map<string, string>();
  const size = new Map<string, number>();

  const ensure = (k: string): void => {
    if (!parent.has(k)) {
      parent.set(k, k);
      size.set(k, 1);
    }
  };
  const find = (k: string): string => {
    let cur = k;
    let guard = 0;
    while (parent.get(cur) != null && parent.get(cur) !== cur && guard < 4096) {
      cur = parent.get(cur) as string;
      guard += 1;
    }
    return cur;
  };

  return {
    union(x: string, y: string): void {
      ensure(x);
      ensure(y);
      const rx = find(x);
      const ry = find(y);
      if (rx === ry) return;
      parent.set(ry, rx);
      size.set(rx, (size.get(rx) ?? 1) + (size.get(ry) ?? 1));
    },
    /** Identity count of the cluster linking `x` and `y` would produce. */
    mergedSize(x: string, y: string): number {
      ensure(x);
      ensure(y);
      const rx = find(x);
      const ry = find(y);
      return rx === ry ? (size.get(rx) ?? 1) : (size.get(rx) ?? 1) + (size.get(ry) ?? 1);
    },
  };
}

/**
 * Split candidates on hard blocker 5: never merge a third identity into an
 * existing pair. Seeded from the live links already on the workspace, then
 * applied in the caller's order so an earlier candidate can block a later one.
 */
function partitionClusterGrowth(
  candidates: AliasAutoCandidate[],
  links: AthleteAliasLink[]
): { merged: AliasAutoCandidate[]; grown: AliasAutoCandidate[] } {
  const clusters = createIdentityClusters();
  for (const l of links) {
    if (!l || !l.aliasName || !l.canonicalName) continue;
    if (isAliasSuppression(l)) continue;
    clusters.union(aliasIdentityKey(l.aliasName), aliasIdentityKey(l.canonicalName));
  }

  const merged: AliasAutoCandidate[] = [];
  const grown: AliasAutoCandidate[] = [];
  for (const c of candidates) {
    if (clusters.mergedSize(c.canon.identityKey, c.other.identityKey) > 2) {
      grown.push(c);
      continue;
    }
    clusters.union(c.canon.identityKey, c.other.identityKey);
    merged.push(c);
  }
  return { merged, grown };
}

/** Record a blocked candidate and offer it for manual confirmation instead. */
function demoteCandidates(
  blocked: AliasAutoCandidate[],
  blocker: AliasAutoLinkBlocker,
  rejected: AliasAutoLinkRejection[],
  suggestions: AliasSuggestionCollector
): void {
  for (const c of blocked) {
    rejected.push(rejectionOf(c, blocker));
    suggestions.add(c.canonicalName, c.team, c.aliasName, c.team, c.gender, c.score, c.reason);
  }
}

/**
 * Compute — without mutating anything — which duplicate-name pairs are safe to
 * merge automatically, which were blocked and why, and what remains as a
 * suggestion. Pure: same workspace in, same plan out, independent of row order.
 */
export function planAutoAliasLinks(
  workspace: Workspace,
  opts: PlanAutoAliasOptions = {}
): AliasAutoLinkPlan {
  const index = opts.index ?? buildAliasEvidenceIndex(workspace, opts);
  const links = workspace.athleteAliases ?? [];
  const ctx: AliasPlanContext = {
    recordedPairs: buildRecordedPairKeys(links),
    userLinkedKeys: buildUserLinkedKeys(links),
    suppressions: listAliasSuppressions(links),
    resolver: buildAliasResolver(links),
    minTierRank: TIER_RANK[opts.minTier ?? 'moderate'],
  };

  const rejected: AliasAutoLinkRejection[] = [];
  const suggestions = createSuggestionCollector(opts.suggestMinScore ?? 0.6);

  const athletes = [...index.athletes].sort(compareEvidenceForSweep);
  const candidates = sweepAliasPairs(athletes, ctx, rejected, suggestions);
  candidates.sort(compareAutoCandidates);

  const { unambiguous, ambiguous } = partitionAmbiguousCandidates(candidates);
  demoteCandidates(ambiguous, 'ambiguous', rejected, suggestions);

  const { merged, grown } = partitionClusterGrowth(unambiguous, links);
  demoteCandidates(grown, 'cluster_growth', rejected, suggestions);

  return {
    autoLinks: merged.map(decisionOf),
    rejected: rejected.sort(compareRejections),
    suggestions: suggestions.out.sort(comparePlanSuggestions),
  };
}

/** One-line human summary of an auto-link decision, for audit panels / logs. */
export function describeAliasAutoLink(d: AliasAutoLinkDecision): string {
  const evidence = d.timeMatches.length
    ? ` — matching ${d.timeMatches.map(t => `${t.event} ${t.time}`).join(', ')}`
    : '';
  return `"${d.aliasName}" -> "${d.canonicalName}" (${d.tier}: ${d.reason}${evidence})`;
}

export type ApplyAutoAliasResult = WorkspaceEditorPatch & {
  plan: AliasAutoLinkPlan;
  applied: AliasAutoLinkDecision[];
};

export type ApplyAutoAliasOptions = PlanAutoAliasOptions & {
  /** Precomputed plan (so the UI can preview, let the user prune, then apply). */
  plan?: AliasAutoLinkPlan;
  /** Timestamp recorded on every created link. Defaults to now. */
  now?: string;
  /** Id factory (tests / reproducible ids). Defaults to uuidv4. */
  newId?: () => string;
};

/**
 * Apply a plan's auto-links as one undo-able `WorkspaceEditorPatch`.
 * Idempotent: re-running against the resulting workspace produces an empty plan
 * (every pair now has a link record), so the patch is empty and applying it is a
 * no-op.
 */
export function applyAutoAliasLinks(
  workspace: Workspace,
  opts: ApplyAutoAliasOptions = {}
): ApplyAutoAliasResult {
  const plan = opts.plan ?? planAutoAliasLinks(workspace, opts);
  const base = workspace.athleteAliases ?? [];
  const now = opts.now ?? new Date().toISOString();
  const newId = opts.newId ?? uuidv4;

  const added: AthleteAliasLink[] = plan.autoLinks.map(d => {
    const team = scopeTeam(d.team);
    const provenance: AliasLinkProvenance = {
      origin: 'auto',
      rule: d.rule,
      tier: d.tier,
      score: d.score,
      reason: d.reason,
      competedSide: d.competedSide,
      decidedAt: now,
      ...(d.timeMatches.length ? { timeMatches: d.timeMatches } : {}),
    };
    return {
      id: newId(),
      gender: d.gender,
      canonicalName: d.canonicalName,
      aliasName: d.aliasName,
      source: 'import',
      createdAt: now,
      status: 'active',
      ...(team ? { team } : {}),
      provenance,
    };
  });

  return {
    patch: added.length ? { athleteAliases: [...base, ...added] } : {},
    inverse: added.length ? { athleteAliases: base } : {},
    description: added.length
      ? `Auto-link ${added.length} duplicate swimmer name${added.length === 1 ? '' : 's'}`
      : 'No swimmer names met the auto-link bar',
    plan,
    applied: plan.autoLinks,
  };
}

// ============================================================================
// STANDING DUPLICATE SCAN
// ============================================================================
//
// `suggestAliasCandidates` and `planAutoAliasLinks` both run at IMPORT time,
// against a set of incoming rows. Nothing re-scans a workspace that is already
// split — so a workspace built before the detector existed, or one where the
// user closed the import panel without acting, stays split forever with no
// indication. A split athlete has their history divided across two identities,
// each sitting under the entry cap independently, each ranked and entered, and
// each counted against the distinct-scorer cap.
//
// `detectDuplicateAthletes` is that standing re-scan. It reuses the SAME
// matcher (`classifyAliasNamePair`) and the SAME evidence index as the
// auto-linker — there is no second heuristic here — and differs from
// `planAutoAliasLinks` in exactly two deliberate ways:
//
//  1. REPORTING TIER, not auto-link tier. `planAutoAliasLinks` only reaches
//     `moderate` when exactly one side competed and the other is import-only.
//     A recruit-driven workspace (the HSU planning workflow: SwimCloud imports
//     and planned entries with NO meet loaded) has neither side competed, so
//     every real split there would score `tier: null` and be silently missed.
//     Reporting therefore drops the competed-asymmetry requirement — a pair is
//     reported on `relation.moderateEligible` alone.
//
//  2. `both_competed` is applied as an EXCLUSION for name-shape evidence, and
//     NOT for `conclusive`. Two spellings that each appear in competed meet
//     results are two humans by hard blocker 1's reasoning, which is what keeps
//     sibling pairs ("Kate Smith" / "Katie Smith", identical surname + an indel
//     first name, indistinguishable on name shape alone) out of a standing nag.
//     Fold-identical pairs are exempt: they are the same identity key by the
//     codebase's own definition, so both sides competing is a PDF spelling
//     inconsistency — precisely what should be reported.
//
// WHAT IS DELIBERATELY NOT REPORTED (these are recall costs, taken on purpose,
// because a standing checklist item that cries wolf gets ignored):
//  · `first_initial` — "S Balistreri" / "Steven Balistreri" (0.80). An initial
//    cannot distinguish Jake from Jack; `autoEligible` is false for this class.
//  · the legacy shared-prefix fallback where the token relation is `unrelated`
//    — "Erik Larsen" / "Eric Larsen" (0.77), "Jack Groce" / "Jake Groce" (0.74).
//    Consonant swaps are identity-bearing.
//  · `near_surname` without an exact shared individual-event time — the library's
//    own worked example "Ryan Johnson" / "Ryan Johnston" (0.82). This class is
//    capped at `strong`, so a time must corroborate it.
//
// No new score threshold is introduced. The gate is the relation's own
// eligibility flags; every relation that clears it already scores >= 0.72.

/** One suspected split athlete: two spellings that should probably be one. */
export type DuplicateAthletePair = {
  /** Spelling that should survive the link (competed side when known). */
  canonicalName: string;
  /** Spelling that would resolve to `canonicalName`. */
  aliasName: string;
  gender: Gender;
  /** Raw team string both spellings sit under. */
  team: string;
  /** Name-relation score in [0,1] (1 when the spellings fold to one key). */
  score: number;
  /** Human-readable justification, safe to render. */
  reason: string;
  /** Evidence class, using the auto-linker's own tiers. */
  tier: AliasEvidenceTier;
  /** Exact individual-event times shared by both spellings. Never relay times. */
  timeMatches: AliasTimeMatch[];
  /** True when `planAutoAliasLinks` would merge this pair without asking. */
  autoLinkable: boolean;
};

export type DetectDuplicateAthletesOptions = PlanAutoAliasOptions & {
  /** Precomputed plan (skips a rebuild when the caller already has one). */
  plan?: AliasAutoLinkPlan;
};

/**
 * Re-scan an existing workspace for athletes split across two name spellings.
 *
 * Scope it with `{ team, gender }` — those restrict the evidence index, so a
 * cross-team pair can never be produced. Already-linked pairs and pairs carrying
 * a suppression tombstone are excluded (both by `planAutoAliasLinks`), so a
 * linked or rejected pair never comes back.
 *
 * Pure: same workspace in, same list out, independent of row order. Results are
 * ordered strongest evidence first, then by score, then by name.
 */
export function detectDuplicateAthletes(
  workspace: Workspace,
  opts: DetectDuplicateAthletesOptions = {}
): DuplicateAthletePair[] {
  const index = opts.index ?? buildAliasEvidenceIndex(workspace, opts);
  const plan = opts.plan ?? planAutoAliasLinks(workspace, { ...opts, index });

  const out: DuplicateAthletePair[] = [];
  const seen = new Set<string>();

  const push = (pair: DuplicateAthletePair): void => {
    const k = `${pair.gender}|${teamKeyOf(pair.team)}|${aliasPairKey(pair.canonicalName, pair.aliasName)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push(pair);
  };

  const evidenceFor = (
    name: string,
    team: string | undefined,
    gender: Gender
  ): AliasAthleteEvidence | null =>
    index.byKey.get(evidenceMapKey(gender, teamKeyOf(team), aliasIdentityKey(name))) ?? null;

  // Anything the auto-linker would merge is, by construction, a duplicate.
  for (const d of plan.autoLinks) {
    push({
      canonicalName: d.canonicalName,
      aliasName: d.aliasName,
      gender: d.gender,
      team: d.team,
      score: d.score,
      reason: d.reason,
      tier: d.tier,
      timeMatches: d.timeMatches,
      autoLinkable: true,
    });
  }

  // Everything the auto-linker demoted, re-tiered under the reporting rules
  // above. `pushSuggestion` always emits the canonical side as `existing`.
  for (const s of plan.suggestions) {
    const gender = s.incoming.gender;
    if (gender !== s.existing.gender) continue;
    const team = s.existing.team ?? s.incoming.team ?? '';
    const a = evidenceFor(s.existing.name, s.existing.team, gender);
    const b = evidenceFor(s.incoming.name, s.incoming.team, gender);

    const foldIdentical = aliasNameKey(s.existing.name) === aliasNameKey(s.incoming.name);
    const relation = foldIdentical ? null : classifyAliasNamePair(s.existing.name, s.incoming.name);
    const timeMatches = a && b ? aliasTimeCorroboration(a, b) : [];

    let tier: AliasEvidenceTier | null = null;
    if (foldIdentical) tier = 'conclusive';
    else if (relation && relation.autoEligible && timeMatches.length >= 1) tier = 'strong';
    else if (relation && relation.moderateEligible) tier = 'moderate';
    if (tier == null) continue;

    // Hard blocker 1, applied to reporting. See the header note: exempt for
    // `conclusive`, where both sides competing is a spelling inconsistency.
    if (tier !== 'conclusive' && a != null && b != null && a.competed && b.competed) continue;

    push({
      canonicalName: s.existing.name,
      aliasName: s.incoming.name,
      gender,
      team,
      score: s.score,
      reason: s.reason,
      tier,
      timeMatches,
      autoLinkable: false,
    });
  }

  out.sort(
    (x, y) =>
      TIER_RANK[y.tier] - TIER_RANK[x.tier] ||
      y.score - x.score ||
      x.canonicalName.localeCompare(y.canonicalName) ||
      x.aliasName.localeCompare(y.aliasName)
  );
  return out;
}

/**
 * Record that a detected pair IS one athlete. Returns the same undo-able
 * `WorkspaceEditorPatch` contract as `addAliasLink`, and clears any prior
 * tombstone for the pair (a human decision outranks the heuristic).
 */
export function linkDuplicateAthletePair(
  workspace: Workspace,
  pair: DuplicateAthletePair,
  opts: { source?: 'manual' | 'import'; createdAt?: string; note?: string } = {}
): WorkspaceEditorPatch {
  const now = opts.createdAt ?? new Date().toISOString();
  return addAliasLink(workspace, {
    canonicalName: pair.canonicalName,
    aliasName: pair.aliasName,
    gender: pair.gender,
    team: pair.team,
    source: opts.source ?? 'manual',
    createdAt: now,
    provenance: {
      origin: 'user',
      tier: pair.tier,
      score: pair.score,
      reason: pair.reason,
      decidedAt: now,
      ...(pair.timeMatches.length ? { timeMatches: pair.timeMatches } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    },
  });
}

/**
 * Record that a detected pair is NOT one athlete. Writes a suppression tombstone
 * into `athleteAliases` (`status: 'suppressed'`), so the pair stops being
 * reported here, stops being proposed by the auto-linker, and survives a reload
 * and a re-import — with no schema change.
 */
export function dismissDuplicateAthletePair(
  workspace: Workspace,
  pair: DuplicateAthletePair,
  opts: { note?: string; createdAt?: string } = {}
): WorkspaceEditorPatch {
  return suppressAliasPair(workspace, {
    nameA: pair.canonicalName,
    nameB: pair.aliasName,
    gender: pair.gender,
    team: pair.team,
    reason: 'user_reject',
    note: opts.note,
    createdAt: opts.createdAt,
  });
}
