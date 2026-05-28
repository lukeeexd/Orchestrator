import type { EffortLevel } from './types';

export const EFFORT_LEVELS: readonly EffortLevel[] = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

export const DEFAULT_EFFORT: EffortLevel = 'high';

export function isEffortLevel(v: unknown): v is EffortLevel {
  return typeof v === 'string' && EFFORT_LEVELS.includes(v as EffortLevel);
}
