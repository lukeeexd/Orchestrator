export type ViewMode = 'compact' | 'stream';

interface Props {
  workspace: string;
  model: string;
  totalTokens: number;
  totalCost: number;
  viewMode: ViewMode;
  onChangeWorkspace: () => void;
  onViewModeChange: (next: ViewMode) => void;
}

function formatTokens(n: number): string {
  if (n <= 0) return '—';
  if (n < 1000) return n.toString();
  return `${(n / 1000).toFixed(1)}k`;
}

export function TopBar({
  workspace,
  model,
  totalTokens,
  totalCost,
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

      <div className="tb-pill" title="Total tokens across all agents this session">
        <span className="label">tokens</span>
        <span className="val">{formatTokens(totalTokens)}</span>
      </div>
      <div className="tb-pill" title="Total cost across all agents this session">
        <span className="label">$</span>
        <span className="val">{totalCost.toFixed(2)}</span>
      </div>
      <div className="tb-pill" title="Default model — set via settings.json defaultModel">
        <span className="dot" />
        <span className="val">{model}</span>
      </div>
    </div>
  );
}
