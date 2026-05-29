import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';

export type ViewMode = 'compact' | 'stream' | 'canvas';

interface Props {
  workspace: string;
  model: string;
  onChangeModel: (next: string) => void;
  /** Currently-applied theme ('light' | 'dark') — picks the toggle glyph. */
  resolvedTheme: 'light' | 'dark';
  /** Quick-toggle sets an explicit light/dark mode ('system' lives in Settings). */
  onToggleTheme: (next: 'light' | 'dark') => void;
  onChangeWorkspace: () => void;
}

export function TopBar({
  workspace,
  model,
  onChangeModel,
  resolvedTheme,
  onToggleTheme,
  onChangeWorkspace,
}: Props) {
  const dark = resolvedTheme === 'dark';
  return (
    <div className="topbar">
      <div className="tb-crumb">
        <span className="proj">orchestrator</span>
        <span className="slash">/</span>
        <span
          className="session"
          onClick={onChangeWorkspace}
          style={{ cursor: 'pointer' }}
          title="Click to change workspace"
        >
          {workspace || 'no workspace · click to set'}
        </span>
      </div>

      <div className="tb-spacer" />

      <button
        className="icon-btn"
        onClick={() => onToggleTheme(dark ? 'light' : 'dark')}
        title={dark ? 'Switch to light mode' : 'Switch to dark mode'}
        aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
      >
        <Icon name={dark ? 'sun' : 'moon'} size={14} />
      </button>

      <div
        className="tb-model"
        title="Default model — used by the Director and new agents unless overridden per-project"
      >
        <span className="tb-dot" />
        <ModelPicker value={model} onChange={onChangeModel} compact />
      </div>
    </div>
  );
}
