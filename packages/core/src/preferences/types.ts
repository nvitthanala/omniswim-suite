export type ThemeMode = 'dark' | 'light';

export type ThemePreset =
  | 'midnight'
  | 'deck-light'
  | 'championship'
  | 'deep-ocean'
  | 'slate-pro'
  | 'custom';

export type TextScale = 'compact' | 'default' | 'comfortable' | 'large';

export type SuitePreferences = {
  themePreset: ThemePreset;
  accentColor: string;
  colorMode: ThemeMode;
  textScale: TextScale;
  reducedMotion: boolean;
  highContrast: boolean;
  focusRingEnhanced: boolean;
  sidebarCollapsedDefault: boolean;
};

export type ThemePresetMeta = {
  id: ThemePreset;
  name: string;
  description: string;
  accentColor: string;
  mode: ThemeMode;
};

export const SUITE_PREFERENCES_STORAGE_KEY = 'omni-preferences';
export const LEGACY_THEME_STORAGE_KEY = 'omni-theme';

export const DEFAULT_SUITE_PREFERENCES: SuitePreferences = {
  themePreset: 'midnight',
  accentColor: '#f87171',
  colorMode: 'dark',
  textScale: 'default',
  reducedMotion: false,
  highContrast: false,
  focusRingEnhanced: false,
  sidebarCollapsedDefault: false,
};

export const THEME_PRESETS: ThemePresetMeta[] = [
  {
    id: 'midnight',
    name: 'Midnight Pool',
    description: 'The classic OmniSwim dark deck with a warm coral highlight.',
    accentColor: '#f87171',
    mode: 'dark',
  },
  {
    id: 'deck-light',
    name: 'Deck Light',
    description: 'Bright, low-glare surfaces for daytime planning sessions.',
    accentColor: '#b91c1c',
    mode: 'light',
  },
  {
    id: 'championship',
    name: 'Championship Gold',
    description: 'Navy boards and gold accents for meet-day energy.',
    accentColor: '#fbbf24',
    mode: 'dark',
  },
  {
    id: 'deep-ocean',
    name: 'Deep Ocean',
    description: 'Teal and cyan tones with a calm analytics feel.',
    accentColor: '#22d3ee',
    mode: 'dark',
  },
  {
    id: 'slate-pro',
    name: 'Slate Pro',
    description: 'Neutral contrast for long roster reviews.',
    accentColor: '#94a3b8',
    mode: 'dark',
  },
  {
    id: 'custom',
    name: 'Your Colors',
    description: 'Pick a team highlight color and choose a light or dark base.',
    accentColor: '#f87171',
    mode: 'dark',
  },
];

export const TEXT_SCALE_VALUES: Record<TextScale, number> = {
  compact: 0.9,
  default: 1,
  comfortable: 1.1,
  large: 1.2,
};

export function isThemePreset(value: unknown): value is ThemePreset {
  return typeof value === 'string' && THEME_PRESETS.some(preset => preset.id === value);
}

export function isTextScale(value: unknown): value is TextScale {
  return value === 'compact' || value === 'default' || value === 'comfortable' || value === 'large';
}

export function presetForMode(mode: ThemeMode): ThemePreset {
  return mode === 'light' ? 'deck-light' : 'midnight';
}

export function modeForPreset(preset: ThemePreset, fallback: ThemeMode = 'dark'): ThemeMode {
  return THEME_PRESETS.find(item => item.id === preset)?.mode ?? fallback;
}
