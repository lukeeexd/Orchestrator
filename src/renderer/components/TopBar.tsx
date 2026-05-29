export type ViewMode = 'compact' | 'stream' | 'canvas';

interface Props {
  workspace: string;
  model: string;
  onChangeWorkspace: () => void;
}

export function TopBar({
  workspace,
  model,
  onChangeWorkspace,
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

      <div className="tb-pill" title="Default model — set via settings.json defaultModel">
        <span className="dot" />
        <span className="val">{model}</span>
      </div>
    </div>
  );
}
