import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUITE_PREFERENCES,
  isThemePreset,
  THEME_PRESETS,
} from '../packages/core/src/preferences/types';

describe('OLED theme preset', () => {
  it('registers oled while preserving the default preset', () => {
    expect(isThemePreset('oled')).toBe(true);
    expect(THEME_PRESETS.find(preset => preset.id === 'oled')?.name).toBe('OLED black');
    expect(DEFAULT_SUITE_PREFERENCES.themePreset).toBe('midnight');
  });
});
