import type { Stroke } from '../types';

export const SELECT_CLASS = 'glass-input w-full';
export const INPUT_CLASS = 'glass-input w-full';

export const STROKE_LABEL: Record<Stroke, string> = { fly: 'Butterfly', back: 'Backstroke', breast: 'Breaststroke', free: 'Freestyle' };
export const STROKES: readonly Stroke[] = ['free', 'back', 'breast', 'fly'];
