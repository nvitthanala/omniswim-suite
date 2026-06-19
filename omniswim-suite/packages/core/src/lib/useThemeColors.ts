/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

export type ThemeColors = {
  chartGrid: string;
  chartTick: string;
  isDark: boolean;
};

function readThemeColors(): ThemeColors {
  const s = getComputedStyle(document.documentElement);
  const isDark = document.documentElement.getAttribute('data-theme') !== 'light';
  return {
    chartGrid: s.getPropertyValue('--chart-grid').trim() || '#374151',
    chartTick: s.getPropertyValue('--chart-tick').trim() || '#9ca3af',
    isDark,
  };
}

/** Re-read when `data-theme` on `<html>` changes (light / dark). */
export function useThemeColors(): ThemeColors {
  const [colors, setColors] = useState<ThemeColors>(() =>
    typeof document !== 'undefined'
      ? readThemeColors()
      : { chartGrid: '#374151', chartTick: '#9ca3af', isDark: true }
  );

  useEffect(() => {
    setColors(readThemeColors());
    const obs = new MutationObserver(() => setColors(readThemeColors()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return colors;
}
