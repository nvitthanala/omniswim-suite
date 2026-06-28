/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

export type ThemeColors = {
  chartGrid: string;
  chartTick: string;
  accent: string;
  isHighContrast: boolean;
  isDark: boolean;
};

function readThemeColors(): ThemeColors {
  const s = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return {
    chartGrid: s.getPropertyValue('--chart-grid').trim() || '#374151',
    chartTick: s.getPropertyValue('--chart-tick').trim() || '#9ca3af',
    accent: s.getPropertyValue('--text-accent').trim() || '#f87171',
    isHighContrast: document.documentElement.dataset.highContrast === 'true',
    isDark,
  };
}

/** Re-read when preference attributes on `<html>` change. */
export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(() =>
    typeof document !== 'undefined'
      ? readThemeColors()
      : { chartGrid: '#374151', chartTick: '#9ca3af', accent: '#f87171', isHighContrast: false, isDark: true }
  );

  useEffect(() => {
    setColors(readThemeColors());
    const obs = new MutationObserver(() => setColors(readThemeColors()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme', 'data-theme-preset', 'data-text-scale', 'data-high-contrast', 'style'],
    });
    return () => obs.disconnect();
  }, []);

  return colors;
}
