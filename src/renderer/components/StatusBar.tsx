import { useEffect, useState } from 'react';
import { Icon } from './Icon';

interface Props {
  agentCount: number;
}

export function StatusBar({ agentCount }: Props) {
  const idle = agentCount === 0;
  const [updateReady, setUpdateReady] = useState<{
    version: string;
    notes: string;
  } | null>(null);

  useEffect(() => {
    return window.api.onUpdateDownloaded((p) => setUpdateReady(p));
  }, []);

  return (
    <div className="statusbar">
      <div className="seg">
        <span
          className="dot"
          style={
            idle
              ? { background: 'var(--muted-2)', boxShadow: 'none' }
              : undefined
          }
        />
        <span className="v">{idle ? 'Idle' : `${agentCount} agents`}</span>
      </div>
      <div className="spacer" />
      {updateReady && (
        <button
          className="statusbar-update"
          onClick={() => void window.api.restartToUpdate()}
          title={
            updateReady.notes
              ? updateReady.notes.slice(0, 400)
              : 'Restart Orchestrator to apply the downloaded update.'
          }
        >
          <Icon name="check" size={11} />
          <span>Update {updateReady.version || 'ready'} · Restart</span>
        </button>
      )}
      <div className="seg">
        <span className="k">Ctrl+N</span>
        <span className="v">New agent</span>
      </div>
      <div className="seg">
        <span className="k">Ctrl+.</span>
        <span className="v">Abort selected</span>
      </div>
    </div>
  );
}
