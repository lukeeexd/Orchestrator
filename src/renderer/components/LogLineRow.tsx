import { memo, useState } from 'react';
import type { LogLine, ToolCall } from '../../shared/types';
import { computeLogLineKey } from '../../shared/logNotes';
import { Icon } from './Icon';

interface Props {
  line: LogLine;
  /** F12: existing pinned note for this line (looked up by lineKey). */
  note?: string;
  /** F12: when present, the line shows a sticky-note affordance. */
  onSaveNote?: (lineKey: string, body: string) => Promise<void> | void;
}

/**
 * H8: memoised so the long-running chatty-agent case doesn't
 * re-render every prior row on each streamed line. LogLine
 * objects are immutable (the runner creates a new instance per
 * line and never mutates them in place), so reference equality
 * is a correct memo check here.
 *
 * F12: optional note / onSaveNote props enable a sticky-note panel
 * below the line. Callers that don't pass them get the original
 * memo behaviour.
 */
function LogLineRowInner({ line, note, onSaveNote }: Props) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const canNote = !!onSaveNote;

  const openEditor = () => {
    setDraft(note ?? '');
    setEditing(true);
  };
  const cancelEdit = () => {
    setEditing(false);
    setDraft('');
  };
  const save = async () => {
    if (!onSaveNote) return;
    const key = computeLogLineKey(line);
    await onSaveNote(key, draft);
    setEditing(false);
  };

  return (
    <div className={'log-line ' + line.kind}>
      <span className="ts">{line.ts}</span>
      <span className="kind">{line.kind}</span>
      <span className="msg">
        <LogMsg msg={line.msg} />
      </span>
      {canNote && !editing && (
        <button
          className="log-line-note-toggle"
          onClick={openEditor}
          title={note ? 'Edit note' : 'Pin a note to this line'}
          style={{
            background: 'transparent',
            border: 0,
            color: note ? 'var(--accent)' : 'var(--muted-2)',
            cursor: 'default',
            padding: '0 4px',
            opacity: note ? 1 : undefined,
          }}
        >
          <Icon name={note ? 'check' : 'file'} size={10} />
        </button>
      )}
      {note && !editing && (
        <div
          style={{
            marginLeft: 24,
            marginTop: 2,
            marginBottom: 2,
            padding: '4px 8px',
            background: 'var(--sub-2)',
            borderLeft: '2px solid var(--accent)',
            borderRadius: 2,
            fontSize: 11,
            color: 'var(--text-1)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {note}
        </div>
      )}
      {editing && (
        <div
          style={{
            marginLeft: 24,
            marginTop: 2,
            marginBottom: 2,
            padding: 4,
            background: 'var(--sub-2)',
            borderLeft: '2px solid var(--accent)',
            borderRadius: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
          }}
        >
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                cancelEdit();
              } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void save();
              }
            }}
            placeholder="Note for this line (Ctrl-Enter saves, Esc cancels, empty saves = delete)"
            style={{
              width: '100%',
              minHeight: 50,
              fontSize: 11,
              fontFamily: 'inherit',
            }}
            spellCheck={false}
          />
          <div style={{ display: 'flex', gap: 4 }}>
            <span className="spacer" style={{ flex: 1 }} />
            <button
              className="tb-btn"
              style={{ height: 20 }}
              onClick={cancelEdit}
            >
              Cancel
            </button>
            <button
              className="tb-btn primary"
              style={{ height: 20 }}
              onClick={() => void save()}
              title={
                draft.trim() === ''
                  ? 'Saving an empty note deletes it'
                  : 'Save (Ctrl-Enter)'
              }
            >
              {draft.trim() === '' && note ? 'Delete' : 'Save'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const LogLineRow = memo(LogLineRowInner);

function LogMsg({ msg }: { msg: string | ToolCall }) {
  if (typeof msg === 'string') return <span>{msg}</span>;
  return (
    <span>
      <span className="fn">{msg.fn}</span>
      <span className="dim">(</span>
      {msg.args.map((a, i) => (
        <span key={i}>
          {i > 0 && <span className="dim">, </span>}
          <span className="arg">{a.k}</span>
          <span className="dim">=</span>
          <span className="str">"{a.v}"</span>
        </span>
      ))}
      <span className="dim">)</span>
    </span>
  );
}
