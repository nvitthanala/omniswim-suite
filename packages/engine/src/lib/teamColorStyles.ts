/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Team colours for charts: primary and secondary lookup, and distinct line styles.
// Split out of `utils.ts`, which still re-exports every name from here.

import { TeamScore } from '../types';
import { itemAt } from './indexedAccess';
import teamColorsData from '../team_colors.json';
import {
  colorForChartStroke,
  parseTeamColorEntry,
  resolveTeamColorKey,
  type TeamColorJsonEntry,
} from './teamColorLookup';

/** Curated secondary accents where many programs share the same primary in data. */
const MANUAL_TEAM_SECONDARY: Record<string, string> = {
  'wayne state university': '#FFCC00',
  'wayne state': '#FFCC00',
  'wayne st.': '#FFCC00',
  'wayne st': '#FFCC00',
  'grand valley state university': '#A2B8C8',
  'grand valley': '#A2B8C8',
  'gvsu': '#A2B8C8',
  'uw-green bay': '#FFFFFF',
  'iowa state': '#F1BE48',
  'iowa st.': '#F1BE48',
  'iowa st': '#F1BE48',
  'youngstown state': '#FFFFFF',
  'youngstown st': '#FFFFFF',
  'lenoir-rhyne university': '#000000',
  'lenoir-rhyne': '#000000',
  'emmanuel college': '#002D62',
  'emmanuel (ga)': '#002D62',
  'emmanuel': '#002D62',
  'florida tech': '#CBA052',
  'carson-newman university': '#E2C044',
  'carson-newman': '#E2C044',
  'catawba college': '#C8102E',
  'catawba': '#C8102E',
  'denison': '#FFFFFF',
  'houston': '#FFFFFF',
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim();
  if (h.length === 3) {
    return {
      // `h.length === 3` was just tested, so each index is in range.
      r: parseInt(h.charAt(0) + h.charAt(0), 16),
      g: parseInt(h.charAt(1) + h.charAt(1), 16),
      b: parseInt(h.charAt(2) + h.charAt(2), 16),
    };
  }
  if (h.length === 6) {
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
  }
  return null;
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** Euclidean distance in RGB, max ~441. */
export function rgbColorDistance(a: string, b: string): number {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  if (!A || !B) return 999;
  return Math.sqrt((A.r - B.r) ** 2 + (A.g - B.g) ** 2 + (A.b - B.b) ** 2);
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (h < 60) [rp, gp, bp] = [c, x, 0];
  else if (h < 120) [rp, gp, bp] = [x, c, 0];
  else if (h < 180) [rp, gp, bp] = [0, c, x];
  else if (h < 240) [rp, gp, bp] = [0, x, c];
  else if (h < 300) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  switch (max) {
    case r:
      h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
      break;
    case g:
      h = ((b - r) / d + 2) * 60;
      break;
    default:
      h = ((r - g) / d + 4) * 60;
  }
  return { h, s, l };
}

/** Distinct secondary for charts on dark UI; stable per team name. */
export function synthesizeSecondaryColor(primary: string, salt: string | null | undefined): string {
  const rgb = hexToRgb(primary);
  if (!rgb) return '#00F5FF';
  const { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);
  const sSafe = String(salt ?? 'x');
  const hash = Array.from(sSafe.toLowerCase()).reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const h2 = (h + 38 + (hash % 180)) % 360;
  const s2 = Math.min(0.95, s + 0.15);
  const l2 = Math.min(0.82, Math.max(0.35, l + (hash % 2 === 0 ? 0.18 : -0.1)));
  const o = hslToRgb(h2, s2, l2);
  return rgbToHex(o.r, o.g, o.b);
}

const COLOR_CLOSE_THRESHOLD = 42;

const DASH_PATTERNS: (string | undefined)[] = [undefined, '6 4', '2 3', '10 4', '4 2 1 2', '8 3 2 3'];

function buildNormalizedColorMap(): Record<string, TeamColorJsonEntry> {
  const out: Record<string, TeamColorJsonEntry> = {};
  for (const [key, val] of Object.entries(teamColorsData as Record<string, TeamColorJsonEntry>)) {
    out[key.toLowerCase()] = val;
  }
  return out;
}

let cachedColorMap: Record<string, TeamColorJsonEntry> | null = null;

function getNormalizedColorMap(): Record<string, TeamColorJsonEntry> {
  if (!cachedColorMap) cachedColorMap = buildNormalizedColorMap();
  return cachedColorMap;
}

export function getTeamColors(teamName: string | null | undefined): { primary: string; secondary: string } {
  const safeName = String(teamName ?? 'Unknown').trim() || 'Unknown';
  const normalizedMap = getNormalizedColorMap();

  const matchKey = resolveTeamColorKey(safeName, normalizedMap);
  const entry = matchKey ? normalizedMap[matchKey] : undefined;

  let primary: string;
  let secondaryFromJson: string | undefined;

  if (entry) {
    const parsed = parseTeamColorEntry(entry);
    primary = parsed.primary;
    secondaryFromJson = parsed.secondary;
  } else {
    const hash = Array.from(safeName).reduce((acc, char) => acc + char.charCodeAt(0), 0);
    const colors = ['#00F5FF', '#FF00FF', '#39FF14', '#FFD700', '#FF4444', '#8A2BE2', '#FF8C00'];
    // `hash` is a sum of char codes (a non-negative integer), so the index is in range.
    primary = itemAt(colors, hash % colors.length);
  }

  const searchName = safeName.toLowerCase();
  const manual = MANUAL_TEAM_SECONDARY[searchName];
  if (manual) {
    return { primary, secondary: manual };
  }
  for (const [k, v] of Object.entries(MANUAL_TEAM_SECONDARY)) {
    if (searchName.includes(k) || k.includes(searchName)) {
      return { primary, secondary: v };
    }
  }

  const secondary = secondaryFromJson || synthesizeSecondaryColor(primary, safeName);
  return { primary, secondary };
}

/** @deprecated Prefer getTeamColors; kept for call sites that only need a single stroke. */
export function getTeamColor(teamName: string | null | undefined, _index: number): string {
  return getTeamColors(teamName).primary;
}

/**
 * Resolve per-team timeline stroke color and optional dash when multiple teams share similar primaries.
 * `team.color` must already be each school's primary. Mutates copies with `lineColor` and `strokeDasharray`.
 */
export function assignTeamLineStyles(
  teams: TeamScore[],
  options?: { chartTheme?: 'dark' | 'light' }
): TeamScore[] {
  const chartTheme = options?.chartTheme ?? 'dark';
  const toStroke = (c: string) => colorForChartStroke(c, chartTheme);
  const n = teams.length;
  if (n === 0) return [];

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(a: number): number {
    // `a` is always an index below `n` (a loop bound or a value stored in `parent`).
    const p = itemAt(parent, a);
    if (p === a) return a;
    const root = find(p);
    parent[a] = root;
    return root;
  }
  function unite(a: number, b: number) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  }

  const safeHex = (c: string | undefined) => String(c || '#888888');

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      // `i` and `j` are both below `n === teams.length`.
      const colorI = itemAt(teams, i).color;
      const colorJ = itemAt(teams, j).color;
      const ci = safeHex(colorI).toUpperCase();
      const cj = safeHex(colorJ).toUpperCase();
      if (ci === cj || rgbColorDistance(safeHex(colorI), safeHex(colorJ)) < COLOR_CLOSE_THRESHOLD) {
        unite(i, j);
      }
    }
  }

  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r)!.push(i);
  }

  const out: TeamScore[] = teams.map(t => ({
    ...t,
    color: safeHex(t.color),
    lineColor: toStroke(safeHex(t.color)),
    strokeDasharray: undefined,
  }));

  for (const idxs of groups.values()) {
    if (idxs.length <= 1) continue;

    // Every member of `idxs` is an index below `n`, which is `teams.length` and `out.length`.
    idxs.sort((a, b) => itemAt(teams, b).totalPoints - itemAt(teams, a).totalPoints);

    if (idxs.length === 2) {
      const win = itemAt(idxs, 0);
      const lose = itemAt(idxs, 1);
      const winTeam = itemAt(teams, win);
      const loseTeam = itemAt(teams, lose);
      const winOut = itemAt(out, win);
      const loseOut = itemAt(out, lose);
      const { secondary } = getTeamColors(loseTeam.teamName);
      winOut.lineColor = toStroke(safeHex(winTeam.color));
      loseOut.lineColor = toStroke(
        rgbColorDistance(safeHex(winTeam.color), secondary) < 22
          ? synthesizeSecondaryColor(safeHex(loseTeam.color), loseTeam.teamName)
          : secondary
      );
      winOut.strokeDasharray = undefined;
      loseOut.strokeDasharray = undefined;
      continue;
    }

    const used = new Set<string>();
    idxs.forEach((teamIdx, rank) => {
      const t = itemAt(teams, teamIdx);
      const { primary: schoolPrimary, secondary } = getTeamColors(t.teamName);
      const basePrimary = safeHex(t.color);
      const baseSecondary =
        rgbColorDistance(basePrimary, secondary) < 18 ? synthesizeSecondaryColor(basePrimary, t.teamName) : secondary;

      let dash = DASH_PATTERNS[rank % DASH_PATTERNS.length];
      let lineC = rank % 2 === 0 ? basePrimary : baseSecondary;
      let guard = 0;
      while (used.has(`${lineC}|${dash ?? ''}`) && guard < 48) {
        guard++;
        const altDash = DASH_PATTERNS[guard % DASH_PATTERNS.length];
        const altColor =
          guard % 3 === 0 ? basePrimary : guard % 3 === 1 ? baseSecondary : synthesizeSecondaryColor(schoolPrimary, `${t.teamName}:${guard}`);
        dash = altDash;
        lineC = altColor;
      }
      used.add(`${lineC}|${dash ?? ''}`);
      const teamOut = itemAt(out, teamIdx);
      teamOut.lineColor = toStroke(lineC);
      teamOut.strokeDasharray = dash;
    });
  }

  return out;
}
