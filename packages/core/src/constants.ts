/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { ConversionFactors } from './types';

export const CONVERSION_FACTORS: ConversionFactors = {
  '50 Freestyle': { men_lcm: 0.87, women_lcm: 0.881, both_scm: 0.906 },
  '100 Freestyle': { men_lcm: 0.873, women_lcm: 0.884, both_scm: 0.906 },
  '200 Freestyle': { men_lcm: 0.875, women_lcm: 0.884, both_scm: 0.906 },
  '400 Freestyle': { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  '500 Freestyle': { men_lcm: 1.115, women_lcm: 1.122, both_scm: 1.153 },
  '800 Freestyle': { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  '1000 Freestyle': { men_lcm: 1.115, women_lcm: 1.13, both_scm: 1.153 },
  '1500 Freestyle': { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  '1650 Freestyle': { men_lcm: 0.975, women_lcm: 0.985, both_scm: 1.013 },
  '100 Backstroke': { men_lcm: 0.845, women_lcm: 0.863, both_scm: 0.906 },
  '200 Backstroke': { men_lcm: 0.859, women_lcm: 0.867, both_scm: 0.906 },
  '100 Breaststroke': { men_lcm: 0.866, women_lcm: 0.88, both_scm: 0.906 },
  '200 Breaststroke': { men_lcm: 0.868, women_lcm: 0.888, both_scm: 0.906 },
  '100 Butterfly': { men_lcm: 0.878, women_lcm: 0.887, both_scm: 0.906 },
  '200 Butterfly': { men_lcm: 0.876, women_lcm: 0.891, both_scm: 0.906 },
  '200 IM': { men_lcm: 0.867, women_lcm: 0.877, both_scm: 0.906 },
  '400 IM': { men_lcm: 0.875, women_lcm: 0.886, both_scm: 0.906 },
};

export const SCORING_POINTS = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1];

export const NEON_COLORS = [
  '#00F5FF', // Neon Cyan
  '#FF00FF', // Neon Magenta
  '#39FF14', // Neon Lime
  '#FFD700', // Gold
  '#FF4444', // Neon Red
  '#8A2BE2', // Neon Violet
  '#FF8C00', // Neon Orange
  '#7FFF00', // Chartreuse
];

export const TEAM_COLORS_MAP: Record<string, string> = {
  'Henderson State University': '#FF4444',
  'Ouachita Baptist University': '#8A2BE2',
  'Delta State University': '#39FF14',
  'Oklahoma Baptist University': '#00F5FF',
};

export const NCAA_CUTS: Record<string, { men: { a: number, b: number }, women: { a: number, b: number } }> = {
  '50 Freestyle': {
    men: { a: 19.48, b: 20.46 },
    women: { a: 22.72, b: 23.86 }
  },
  '100 Freestyle': {
    men: { a: 43.12, b: 45.23 },
    women: { a: 49.58, b: 52.06 }
  },
  '200 Freestyle': {
    men: { a: 95.45, b: 100.22 }, // 1:35.45 -> 95.45
    women: { a: 107.70, b: 113.08 }
  },
  '500 Freestyle': {
    men: { a: 261.76, b: 274.84 },
    women: { a: 290.30, b: 304.82 }
  },
  '100 Backstroke': {
    men: { a: 46.47, b: 48.79 },
    women: { a: 53.51, b: 56.18 }
  },
  '200 Backstroke': {
    men: { a: 102.78, b: 107.92 },
    women: { a: 117.00, b: 122.85 }
  },
  '100 Breaststroke': {
    men: { a: 52.91, b: 55.56 },
    women: { a: 61.03, b: 64.08 }
  },
  '200 Breaststroke': {
    men: { a: 115.12, b: 120.87 },
    women: { a: 133.06, b: 139.71 }
  },
  '100 Butterfly': {
    men: { a: 46.45, b: 48.77 },
    women: { a: 53.37, b: 56.04 }
  },
  '200 Butterfly': {
    men: { a: 104.66, b: 110.89 },
    women: { a: 119.30, b: 125.26 }
  },
};

