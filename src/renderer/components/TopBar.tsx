export type ViewMode = 'compact' | 'stream';

interface Props {
  workspace: string;
  model: string;
  viewMode: ViewMode;
  onChangeWorkspace: () => void;
  onViewModeChange: (next: ViewMode) => void;
}

export function TopBar({
  workspace,
  model,
  viewMode,
  onChangeWorkspace,
  onViewModeChange,
}: Props) {
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

      <div
        className="view-toggle"
        title="Compact: chat bubbles + agent tiles. Stream: terminal-style live log for Director and every agent."
      >
        <button
          className={viewMode === 'compact' ? 'on' : ''}
          onClick={() => onViewModeChange('compact')}
        >
          compact
        </button>
        <button
          className={viewMode === 'stream' ? 'on' : ''}
          onClick={() => onViewModeChange('stream')}
        >
          stream
        </button>
      </div>

      <div className="tb-pill" title="Default model — set via settings.json defaultModel">
        <span className="dot" />
        <span className="val">{model}</span>
      </div>
    </div>
  );
}
