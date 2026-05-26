import { useState } from 'react';
import { Modal } from './Modal';

interface Props {
  branches: string[];
  current: string | null;
  /** Resolves with the chosen base branch, or null when the user cancels. */
  onResolve: (choice: string | null) => void;
}

/**
 * F14: base-branch picker shown on plan accept when the project has
 * auto-branch enabled and the workspace is a git repo. Lists local
 * branches with the current HEAD pre-selected, plus a "spawn anyway,
 * don't create a branch" escape hatch in case the user wants to
 * bypass auto-branch for one specific plan.
 *
 * Esc / backdrop cancels the spawn entirely (Modal handles both).
 * Enter on the confirm button — left to default browser focus.
 */
export function BaseBranchModal({ branches, current, onResolve }: Props) {
  const [choice, setChoice] = useState<string>(
    current && branches.includes(current) ? current : branches[0] ?? '',
  );

  return (
    <Modal
      title="Auto-branch · pick a base"
      onClose={() => onResolve(null)}
      maxWidth={420}
      footer={
        <>
          <button
            className="text-input"
            style={{ background: 'transparent', cursor: 'default' }}
            onClick={() => onResolve(null)}
          >
            Cancel
          </button>
          <span className="spacer" />
          <button
            className="text-input"
            onClick={() => onResolve(choice)}
            disabled={choice.length === 0}
            style={{
              background: 'var(--accent)',
              color: 'var(--ink)',
              cursor: 'default',
            }}
          >
            Spawn from <code>{choice}</code>
          </button>
        </>
      }
    >
      <p style={{ margin: '0 0 10px', color: 'var(--muted)' }}>
        The new <code>orchestrator/...</code> branch will be rooted at this
        branch. Pick wherever you want the agents' edits to start from —
        usually <code>main</code> or whatever is current.
      </p>
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          maxHeight: 240,
          overflowY: 'auto',
        }}
      >
        {branches.map((b) => (
          <label
            key={b}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '4px 8px',
              borderRadius: 4,
              cursor: 'default',
              background:
                b === choice ? 'var(--sub)' : 'transparent',
            }}
          >
            <input
              type="radio"
              name="base-branch"
              value={b}
              checked={b === choice}
              onChange={() => setChoice(b)}
            />
            <span style={{ flex: 1 }}>{b}</span>
            {b === current && (
              <span className="badge" style={{ background: 'var(--sub-2)' }}>
                current
              </span>
            )}
          </label>
        ))}
      </div>
    </Modal>
  );
}
