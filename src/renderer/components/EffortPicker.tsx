import { EFFORT_LEVELS } from '../../shared/efforts';
import type { EffortLevel } from '../../shared/types';

interface Props {
  value: EffortLevel;
  onChange: (next: EffortLevel) => void;
  /** Compact rendering for inline use in toolbars. Default false (full-width field). */
  compact?: boolean;
  /** Disable the picker (e.g. while saving). */
  disabled?: boolean;
}

const LABELS: Record<EffortLevel, string> = {
  low: 'low · fast',
  medium: 'medium',
  high: 'high · default',
  xhigh: 'xhigh',
  max: 'max · top-tier',
  ultracode: 'ultracode · Opus 4.8',
};

/**
 * Shared reasoning-effort dropdown. Mirrors Claude Code's effort levels:
 * low → fastest, ultracode → deepest (Opus 4.8's top tier). Default
 * applied throughout the app is 'high'.
 */
export function EffortPicker({
  value,
  onChange,
  compact = false,
  disabled,
}: Props) {
  return (
    <select
      className={
        'text-input settings-select' + (compact ? ' model-picker-compact' : '')
      }
      value={value}
      onChange={(e) => onChange(e.target.value as EffortLevel)}
      disabled={disabled}
    >
      {EFFORT_LEVELS.map((e) => (
        <option key={e} value={e}>
          {LABELS[e]}
        </option>
      ))}
    </select>
  );
}
