import { ModelPicker } from './ModelPicker';

export type ViewMode = 'compact' | 'stream' | 'canvas';

interface Props {
  workspace: string;
  model: string;
  onChangeModel: (next: string) => void;
  onChangeWorkspace: () => void;
}

export function TopBar({
  workspace,
  model,
  onChangeModel,
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
