/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export type TeamColorJsonEntry = string | { primary: string; secondary?: string };

export type ParsedTeamColors = { primary: string; secondary?: string };

/** Run before generic substring matching — order matters. */
const COLOR_ALIAS_RULES: ReadonlyArray<{ pattern: RegExp; key: string }> = [
  { pattern: /\b(nc state|north carolina state|north carolina st)\b/, key: 'nc state' },
  {
    pattern: /\b(unc chapel hill|university of north carolina at chapel hill|tar heels)\b/,
    key: 'north carolina',
  },
  {
    pattern: /\b(university of north carolina|unc\b|north carolina tar heels)\b/,
    key: 'north carolina',
  },
  { pattern: /^north carolina$/, key: 'north carolina' },

  { pattern: /\b(michigan state|michigan st|mich state|mich st)\b/, key: 'michigan state' },
  { pattern: /\b(university of michigan)\b/, key: 'michigan' },

  { pattern: /\b(ohio state|ohio st)\b/, key: 'ohio state' },
  { pattern: /\b(ohio university|university of ohio)\b/, key: 'ohio' },

  { pattern: /\b(indiana university of pennsylvania|indiana \(pa\)|iup\b)\b/, key: 'indiana (pa)' },
  { pattern: /\b(indiana university|university of indiana)\b/, key: 'indiana' },

  { pattern: /\b(florida state|florida st|fsu)\b/, key: 'florida state' },
  { pattern: /\b(university of florida|florida gators)\b/, key: 'florida' },

  { pattern: /\b(georgia tech|georgia institute of technology)\b/, key: 'georgia tech' },
  { pattern: /\b(university of georgia)\b/, key: 'georgia' },

  { pattern: /\b(penn state|pennsylvania state|penn st)\b/, key: 'penn state' },
  { pattern: /\b(university of pennsylvania|upenn)\b/, key: 'penn' },
  { pattern: /\bpenn\b/, key: 'penn' },

  { pattern: /\b(miami \(oh\)|miami university|miami oh)\b/, key: 'miami (oh)' },
  { pattern: /\b(university of miami|miami \(fl\)|miami hurricanes)\b/, key: 'miami' },

  { pattern: /\b(virginia tech|va tech)\b/, key: 'virginia tech' },
  { pattern: /\b(university of virginia|uva)\b/, key: 'virginia' },

  { pattern: /\b(kansas state|kansas st)\b/, key: 'kansas state' },
  { pattern: /\b(university of kansas)\b/, key: 'kansas' },

  { pattern: /\b(iowa state|iowa st)\b/, key: 'iowa state' },
  { pattern: /\b(university of iowa)\b/, key: 'iowa' },

  { pattern: /\b(mississippi state|miss state|mississippi st)\b/, key: 'mississippi state' },
  { pattern: /\b(ole miss|university of mississippi)\b/, key: 'ole miss' },

  { pattern: /\b(south carolina)\b/, key: 'south carolina' },
  { pattern: /\b(north dakota state|north dakota st)\b/, key: 'north dakota state' },
  { pattern: /\b(south dakota state|south dakota st)\b/, key: 'south dakota state' },

  { pattern: /\b(southern california|usc trojans|usc)\b/, key: 'usc' },
  { pattern: /\b(ucla|uc los angeles)\b/, key: 'ucla' },

  { pattern: /\b(arizona state|asu)\b/, key: 'arizona state' },
  { pattern: /\b(university of arizona|arizona wildcats)\b/, key: 'arizona' },

  { pattern: /\b(colorado state|colorado st)\b/, key: 'colorado state' },
  { pattern: /\b(university of colorado)\b/, key: 'colorado' },

  { pattern: /\b(boston college)\b/, key: 'boston college' },
  { pattern: /\b(boston university|\bbu\b)\b/, key: 'boston university' },
];

export function normalizeTeamNameForColorLookup(name: string): string {
  return name
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/&/g, ' and ')
    .replace(/['']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Score how well a catalog key matches a team name (higher = better). */
export function scoreTeamColorKeyMatch(searchName: string, key: string): number {
  if (searchName === key) return 10_000 + key.length;
  const escaped = escapeRegExp(key);
  if (new RegExp(`\\b${escaped}\\b`).test(searchName)) return 5_000 + key.length;
  if (searchName.startsWith(`${key} `) || searchName.endsWith(` ${key}`)) return 4_000 + key.length;
  if (key.length >= 10 && searchName.includes(key)) return 3_000 + key.length;
  if (key.length >= 6 && searchName.includes(key)) return 2_000 + key.length;
  return 0;
}

export function resolveTeamColorKey(
  teamName: string,
  normalizedMap: Record<string, TeamColorJsonEntry>
): string | undefined {
  const searchName = normalizeTeamNameForColorLookup(teamName);
  if (!searchName) return undefined;

  if (normalizedMap[searchName]) return searchName;

  for (const rule of COLOR_ALIAS_RULES) {
    if (rule.pattern.test(searchName) && normalizedMap[rule.key]) {
      return rule.key;
    }
  }

  let bestKey = '';
  let bestScore = 0;
  for (const key of Object.keys(normalizedMap)) {
    const score = scoreTeamColorKeyMatch(searchName, key);
    if (score > bestScore) {
      bestScore = score;
      bestKey = key;
    }
  }

  return bestScore > 0 ? bestKey : undefined;
}

export function parseTeamColorEntry(entry: TeamColorJsonEntry | undefined): ParsedTeamColors {
  if (!entry) return { primary: '#888888' };
  if (typeof entry === 'string') return { primary: entry || '#888888' };
  if (typeof entry === 'object' && entry !== null && typeof entry.primary === 'string') {
    return { primary: entry.primary || '#888888', secondary: entry.secondary };
  }
  return { primary: '#888888' };
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const h = hex.replace('#', '').trim();
  if (h.length === 3) {
    return {
      r: parseInt(h[0] + h[0], 16),
      g: parseInt(h[1] + h[1], 16),
      b: parseInt(h[2] + h[2], 16),
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

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rp = 0,
    gp = 0,
    bp = 0;
  if (h < 60) {
    rp = c;
    gp = x;
  } else if (h < 120) {
    rp = x;
    gp = c;
  } else if (h < 180) {
    gp = c;
    bp = x;
  } else if (h < 240) {
    gp = x;
    bp = c;
  } else if (h < 300) {
    rp = x;
    bp = c;
  } else {
    rp = c;
    bp = x;
  }
  return { r: (rp + m) * 255, g: (gp + m) * 255, b: (bp + m) * 255 };
}

/** Adjust school colors for chart strokes while preserving hue identity. */
export function colorForChartStroke(hex: string, theme: 'dark' | 'light' = 'dark'): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  let { h, s, l } = rgbToHsl(rgb.r, rgb.g, rgb.b);

  if (theme === 'dark') {
    if (l < 0.28) l = 0.34 + l * 0.35;
    else if (l < 0.42) l = Math.min(0.58, l + 0.14);
    if (s < 0.22 && l < 0.5) {
      s = Math.min(0.55, s + 0.22);
      l = Math.min(0.62, l + 0.12);
    }
    if (l > 0.8 && s < 0.3) l = 0.72;
  } else {
    if (l > 0.82) l = 0.72;
    if (l > 0.68 && s < 0.18) l = 0.52;
    if (l < 0.22) l = 0.28;
  }

  const out = hslToRgb(h, s, l);
  return rgbToHex(out.r, out.g, out.b);
}
