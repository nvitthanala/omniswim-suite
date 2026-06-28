import {
  createContext,
  type PropsWithChildren,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  DEFAULT_SUITE_PREFERENCES,
  LEGACY_THEME_STORAGE_KEY,
  isThemePreset,
  modeForPreset,
  presetForMode,
  SUITE_PREFERENCES_STORAGE_KEY,
  TEXT_SCALE_VALUES,
  type SuitePreferences,
  type ThemeMode,
} from './types';

type SuitePreferencesContextValue = {
  preferences: SuitePreferences;
  setPreferences: (next: SuitePreferences | ((current: SuitePreferences) => SuitePreferences)) => void;
  updatePreferences: (patch: Partial<SuitePreferences>) => void;
  resetPreferences: () => void;
  toggleThemeMode: () => void;
};

const SuitePreferencesContext = createContext<SuitePreferencesContextValue | null>(null);

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value);
}

function readLegacyMode(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  const legacy = window.localStorage.getItem(LEGACY_THEME_STORAGE_KEY);
  return legacy === 'light' || legacy === 'dark' ? legacy : null;
}

function normalizePreferences(value: unknown): SuitePreferences {
  const legacyMode = readLegacyMode();
  const base = legacyMode
    ? {
        ...DEFAULT_SUITE_PREFERENCES,
        colorMode: legacyMode,
        themePreset: presetForMode(legacyMode),
      }
    : DEFAULT_SUITE_PREFERENCES;

  if (!value || typeof value !== 'object') return base;

  const raw = value as Partial<SuitePreferences>;
  const themePreset = isThemePreset(raw.themePreset) ? raw.themePreset : base.themePreset;
  const colorMode =
    raw.colorMode === 'light' || raw.colorMode === 'dark'
      ? raw.colorMode
      : themePreset === 'custom'
        ? base.colorMode
        : modeForPreset(themePreset, base.colorMode);

  return {
    ...base,
    ...raw,
    themePreset,
    colorMode,
    accentColor: isHexColor(raw.accentColor) ? raw.accentColor : base.accentColor,
    textScale:
      raw.textScale === 'compact' ||
      raw.textScale === 'default' ||
      raw.textScale === 'comfortable' ||
      raw.textScale === 'large'
        ? raw.textScale
        : base.textScale,
    reducedMotion: Boolean(raw.reducedMotion),
    highContrast: Boolean(raw.highContrast),
    focusRingEnhanced: Boolean(raw.focusRingEnhanced),
    sidebarCollapsedDefault: Boolean(raw.sidebarCollapsedDefault),
  };
}

function loadPreferences(): SuitePreferences {
  if (typeof window === 'undefined') return DEFAULT_SUITE_PREFERENCES;

  try {
    const stored = window.localStorage.getItem(SUITE_PREFERENCES_STORAGE_KEY);
    return normalizePreferences(stored ? JSON.parse(stored) : null);
  } catch {
    return normalizePreferences(null);
  }
}

export function applySuitePreferences(preferences: SuitePreferences) {
  if (typeof document === 'undefined') return;

  const root = document.documentElement;
  root.dataset.theme = preferences.colorMode;
  root.dataset.themePreset = preferences.themePreset;
  root.dataset.textScale = preferences.textScale;
  root.dataset.reducedMotion = String(preferences.reducedMotion);
  root.dataset.highContrast = String(preferences.highContrast);
  root.dataset.focusRingEnhanced = String(preferences.focusRingEnhanced);
  root.style.setProperty('--custom-accent', preferences.accentColor);
  root.style.setProperty('--text-scale', String(TEXT_SCALE_VALUES[preferences.textScale]));
}

export function SuitePreferencesProvider({ children }: PropsWithChildren) {
  const [preferences, setPreferencesState] = useState<SuitePreferences>(() => loadPreferences());

  const setPreferences = useCallback(
    (next: SuitePreferences | ((current: SuitePreferences) => SuitePreferences)) => {
      setPreferencesState(current => normalizePreferences(typeof next === 'function' ? next(current) : next));
    },
    []
  );

  const updatePreferences = useCallback(
    (patch: Partial<SuitePreferences>) => {
      setPreferences(current => normalizePreferences({ ...current, ...patch }));
    },
    [setPreferences]
  );

  const resetPreferences = useCallback(() => {
    setPreferences(DEFAULT_SUITE_PREFERENCES);
  }, [setPreferences]);

  const toggleThemeMode = useCallback(() => {
    setPreferences(current => {
      const nextMode: ThemeMode = current.colorMode === 'dark' ? 'light' : 'dark';
      if (current.themePreset === 'custom') {
        return { ...current, colorMode: nextMode };
      }
      const themePreset = presetForMode(nextMode);
      return { ...current, colorMode: nextMode, themePreset };
    });
  }, [setPreferences]);

  useEffect(() => {
    applySuitePreferences(preferences);
    window.localStorage.setItem(SUITE_PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
    window.localStorage.setItem(LEGACY_THEME_STORAGE_KEY, preferences.colorMode);
  }, [preferences]);

  const value = useMemo<SuitePreferencesContextValue>(
    () => ({
      preferences,
      setPreferences,
      updatePreferences,
      resetPreferences,
      toggleThemeMode,
    }),
    [preferences, resetPreferences, setPreferences, toggleThemeMode, updatePreferences]
  );

  return <SuitePreferencesContext.Provider value={value}>{children}</SuitePreferencesContext.Provider>;
}

export function useSuitePreferences() {
  const context = useContext(SuitePreferencesContext);
  if (!context) {
    throw new Error('useSuitePreferences must be used within SuitePreferencesProvider');
  }
  return context;
}
