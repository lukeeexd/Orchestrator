import {
  KNOWN_MODELS,
  MODEL_LABELS,
  modelsForProvider,
} from '../../shared/models';
import type { Provider } from '../../shared/types';

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** Compact rendering for inline use in toolbars. Default false (full-width field). */
  compact?: boolean;
  /** Disable the picker (e.g. while saving). */
  disabled?: boolean;
  /** Filter the dropdown to one provider's models. Omit to show all. */
  provider?: Provider;
}

/**
 * Shared model dropdown. Always shows the known model ids. If the
 * current value isn't one of them (custom value in settings.json or
 * an older agent record), it's surfaced as a "(custom)" entry so the
 * picker never silently drops it.
 */
export function ModelPicker({
  value,
  onChange,
  compact = false,
  disabled,
  provider,
}: Props) {
  const visible = provider ? modelsForProvider(provider) : KNOWN_MODELS;
  const isCustom = !!value && !visible.includes(value);
  return (
    <select
      className={
        'text-input settings-select' + (compact ? ' model-picker-compact' : '')
      }
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      {isCustom && <option value={value}>{value} (custom)</option>}
      {visible.map((m) => (
        <option key={m} value={m}>
          {MODEL_LABELS[m] ?? m}
        </option>
      ))}
    </select>
  );
}
