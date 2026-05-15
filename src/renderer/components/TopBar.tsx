import { Icon } from './Icon';

interface Props {
  workspace: string;
  model: string;
  onChangeWorkspace: () => void;
}

export function TopBar({ workspace, model, onChangeWorkspace }: Props) {
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

      <div className="tb-pill" title="Total tokens this session">
        <span className="label">tokens</span>
        <span className="val">—</span>
      </div>
      <div className="tb-pill" title="Cost / budget">
        <span className="label">$</span>
        <span className="val">0.00</span>
        <span style={{ color: 'var(--muted-2)' }}>/ 5.00</span>
      </div>
      <div className="tb-pill" title="Default model — set via settings.json defaultModel">
        <span className="dot" />
        <span className="val">{model}</span>
      </div>
    </div>
  );
}
