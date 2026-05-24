import { useEffect, useMemo, useRef, useState } from 'react';
import { BUILTIN_COMMANDS } from '../../shared/builtinCommands';
import type { BuiltinAction } from '../../shared/builtinCommands';

/**
 * F1: Ctrl-K / ⌘-K command palette. Surfaces the same set of actions
 * the Director-composer slash-command menu exposes, but reachable from
 * anywhere in the app. Filtering is a case-insensitive substring match
 * over each action's name + description.
 *
 * The palette mounts globally in App.tsx and renders nothing when
 * closed. Ctrl-K toggles open; Escape closes; Enter runs the focused
 * action and closes; Up/Down navigate. The action handler is the
 * same callback the slash menu invokes (App.runBuiltinAction), so
 * adding a new BuiltinAction in shared/builtinCommands.ts lights it
 * up in both surfaces.
 */
interface Props {
  open: boolean;
  onClose: () => void;
  onRun: (action: BuiltinAction) => void | Promise<void>;
}

export function CommandPalette({ open, onClose, onRun }: Props) {
  const [query, setQuery] = useState('');
  const [focusIdx, setFocusIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state every time the palette opens so a stale query / focus
  // index from the last invocation doesn't leak in.
  useEffect(() => {
    if (open) {
      setQuery('');
      setFocusIdx(0);
      // The focus has to happen on the next paint — the input isn't
      // in the DOM yet on the same tick the prop flips.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return BUILTIN_COMMANDS;
    return BUILTIN_COMMANDS.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q),
    );
  }, [query]);

  // Keep the focus index inside the filtered list as the user types.
  useEffect(() => {
    if (focusIdx >= filtered.length) {
      setFocusIdx(Math.max(0, filtered.length - 1));
    }
  }, [filtered.length, focusIdx]);

  if (!open) return null;

  const run = async (idx: number) => {
    const cmd = filtered[idx];
    if (!cmd) return;
    onClose();
    await onRun(cmd.action);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusIdx((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusIdx((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      void run(focusIdx);
    }
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 200,
        background: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'center',
        paddingTop: '15vh',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        style={{
          width: 'min(520px, 90vw)',
          background: 'var(--bg)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          boxShadow: '0 12px 32px rgba(0, 0, 0, 0.4)',
          display: 'flex',
          flexDirection: 'column',
          maxHeight: '70vh',
          overflow: 'hidden',
        }}
      >
        <input
          ref={inputRef}
          className="text-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setFocusIdx(0);
          }}
          style={{
            border: 'none',
            borderBottom: '1px solid var(--border)',
            borderRadius: 0,
            padding: '10px 12px',
            fontSize: 13,
            background: 'transparent',
          }}
          spellCheck={false}
        />
        <div style={{ overflowY: 'auto', padding: 4 }}>
          {filtered.length === 0 ? (
            <div
              className="inline-empty"
              style={{ padding: 18, fontSize: 11 }}
            >
              No commands match "{query}".
            </div>
          ) : (
            filtered.map((cmd, idx) => (
              <div
                key={cmd.name}
                onMouseEnter={() => setFocusIdx(idx)}
                onClick={() => void run(idx)}
                style={{
                  padding: '6px 10px',
                  borderRadius: 4,
                  cursor: 'default',
                  background:
                    idx === focusIdx ? 'var(--sub-2)' : 'transparent',
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 8,
                }}
              >
                <code
                  style={{
                    fontWeight: 700,
                    color:
                      idx === focusIdx ? 'var(--accent)' : 'var(--text-1)',
                    minWidth: 90,
                  }}
                >
                  /{cmd.name}
                </code>
                <span
                  style={{
                    color: 'var(--text-2)',
                    fontSize: 11,
                  }}
                >
                  {cmd.description}
                </span>
              </div>
            ))
          )}
        </div>
        <div
          style={{
            borderTop: '1px solid var(--border)',
            padding: '6px 10px',
            fontSize: 10,
            color: 'var(--muted-2)',
            display: 'flex',
            gap: 12,
          }}
        >
          <span>
            <code>↑↓</code> navigate
          </span>
          <span>
            <code>↵</code> run
          </span>
          <span>
            <code>Esc</code> close
          </span>
        </div>
      </div>
    </div>
  );
}
