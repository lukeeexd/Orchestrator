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
  // S6: payload from the secondary channel — public download URL the
  // user opens in their browser when the primary auto-update isn't
  // delivering. Independent of `updateReady` (which is the in-app
  // auto-installed path).
  const [secondaryUpdate, setSecondaryUpdate] = useState<{
    version: string;
    downloadUrl: string;
  } | null>(null);

  useEffect(() => {
    const off1 = window.api.onUpdateDownloaded((p) => setUpdateReady(p));
    const off2 = window.api.onSecondaryUpdateAvailable((p) =>
      setSecondaryUpdate({ version: p.version, downloadUrl: p.downloadUrl }),
    );
    return () => {
      off1();
      off2();
    };
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
      {!updateReady && secondaryUpdate && (
        <button
          className="statusbar-update"
          onClick={() =>
            void window.api.openSecondaryDownload(secondaryUpdate.downloadUrl)
          }
          title="The primary auto-update channel isn't delivering this version. Click to open the public download URL in your browser and install manually."
        >
          <Icon name="file" size={11} />
          <span>Update {secondaryUpdate.version} available · Download</span>
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
      <div className="seg">
        <span className="k">Ctrl+B</span>
        <span className="v">Toggle inspector</span>
      </div>
    </div>
  );
}
