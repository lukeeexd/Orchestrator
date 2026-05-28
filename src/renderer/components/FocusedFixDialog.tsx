import { useState } from 'react';
import type { EffortLevel, Provider } from '../../shared/types';
import { Modal } from './Modal';
import { Icon } from './Icon';

interface Props {
  projectId: string;
  workspace: string;
  /** Project's coder model — pre-fills the model picker (renderer keeps a single hardcoded coder model for now). */
  defaultModel: string;
  defaultEffort: EffortLevel;
  provider: Provider;
  onCancel: () => void;
  onSpawned: () => void;
}

/**
 * P8 — "Focused fix" quick spawn. Bypasses the Director for the
 * common single-file bugfix case: user picks a file, types a 3-line
 * task, optionally sets a budget, hits Spawn. We pin the file path
 * into the coder's opening prompt with a soft-constraint preamble
 * ("touch only this file, no shell beyond git diff") and attach the
 * file so its contents are in context immediately.
 *
 * v1 enforces the constraint at the prompt level, not via the tool
 * allow-list. The runner's tool resolution today is per-(role,
 * project); adding a per-spawn override would be a bigger change
 * than this slice warranted. Coder agents reliably respect the
 * scope hint in practice — if the soft constraint stops being
 * enough, P8.1 can wire a real allow-list override.
 */
export function FocusedFixDialog({
  projectId,
  workspace,
  defaultModel,
  defaultEffort,
  provider,
  onCancel,
  onSpawned,
}: Props) {
  const [filePath, setFilePath] = useState<string>('');
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pickFile = async () => {
    const res = await window.api.pickAttachments();
    if (res.attachments.length === 0) return;
    const first = res.attachments[0];
    if (!first.ok) {
      setError(first.reason ?? 'File could not be read.');
      return;
    }
    setError(null);
    setFilePath(first.path);
  };

  const relativePath = (() => {
    if (!filePath || !workspace) return filePath;
    if (filePath.startsWith(workspace)) {
      // Strip workspace prefix + leading separator. Works for both
      // C:\foo\bar and /home/x/bar — split on whichever leads.
      const rest = filePath.slice(workspace.length);
      return rest.replace(/^[\\/]/, '');
    }
    return filePath;
  })();

  const fileOutsideWorkspace =
    !!filePath && !!workspace && !filePath.startsWith(workspace);

  const handleSpawn = async () => {
    if (!filePath || task.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      // The opening prompt: pin the file by name, paste the user's
      // task, then the soft scope constraint. Plain text — no special
      // markup; the coder reads it like any other task.
      const taskPrompt =
        `Focused fix on \`${relativePath}\`.\n\n` +
        `${task.trim()}\n\n` +
        `Constraints:\n` +
        `- Edit only the named file. Touch siblings only if the change ` +
        `genuinely requires it — and call out why in the result message.\n` +
        `- No shell commands except \`git diff\` / \`git status\` to verify ` +
        `the change. No installs, no scripts, no test runs.\n` +
        `- Stop once the user-described change is implemented. Don't ` +
        `opportunistically refactor in the same pass.`;

      await window.api.spawnAgent({
        projectId,
        role: 'coder',
        workspace,
        task: taskPrompt,
        model: defaultModel,
        effort: defaultEffort,
        provider,
        // The picked file rides as an attachment so the coder sees its
        // contents in the opening turn — saves a Read tool call and
        // makes "stay focused on this file" easier to honour.
        attachments: [filePath],
      });
      onSpawned();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<b>Focused fix</b>}
      maxWidth={520}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={() => void handleSpawn()}
            disabled={busy || !filePath || task.trim().length === 0}
            title={
              !filePath
                ? 'Pick a file to focus on'
                : task.trim().length === 0
                ? 'Describe the fix'
                : 'Spawn a coder agent with this file pinned'
            }
          >
            {busy ? 'Spawning…' : 'Spawn coder'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="lbl">File</span>
        <span className="v" style={{ display: 'flex', gap: 6, flex: 1 }}>
          <input
            className="text-input"
            value={relativePath}
            onChange={(e) => {
              // Allow paste of an absolute path too; the relative
              // derivation runs from filePath, but if the user typed
              // we let it pass through directly.
              const v = e.target.value;
              setFilePath(v);
            }}
            placeholder="Pick or paste a path…"
            style={{ flex: 1 }}
          />
          <button
            className="tb-btn"
            onClick={() => void pickFile()}
            disabled={busy}
            title="Open a file picker scoped to the workspace"
          >
            <Icon name="attach" size={11} /> Pick
          </button>
        </span>
      </div>

      {fileOutsideWorkspace && (
        <div
          className="field"
          style={{ color: 'var(--waiting)', fontSize: 11 }}
        >
          File is outside the project workspace. The coder will still receive
          it as an attachment, but git operations will run in the workspace
          dir — make sure the file is reachable from there.
        </div>
      )}

      <div className="field">
        <span className="lbl">Task</span>
        <span className="v" style={{ flex: 1 }}>
          <textarea
            className="text-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder="What needs to change in this file? (3 lines max recommended)"
            rows={4}
            style={{ width: '100%', resize: 'vertical', fontSize: 12 }}
          />
        </span>
      </div>

      {error && (
        <div
          className="field"
          style={{ color: 'var(--error)', fontSize: 11 }}
        >
          {error}
        </div>
      )}

      <div
        className="field"
        style={{ color: 'var(--text-2)', fontSize: 11, fontStyle: 'italic' }}
      >
        Spawns a single coder, no Director. The file's contents arrive as
        an attachment; the task includes a scope constraint asking the
        coder to leave siblings alone.
      </div>
    </Modal>
  );
}
