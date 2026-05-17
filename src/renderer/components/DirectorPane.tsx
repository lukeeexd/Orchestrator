import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import type {
  Agent,
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  PlanRow,
} from '../../shared/types';
import { Icon } from './Icon';
import { PlanCard } from './PlanCard';
import { ModelPicker } from './ModelPicker';
import { EffortPicker } from './EffortPicker';
import { DirectorStream } from './DirectorStream';
import type { ViewMode } from './TopBar';

const ROLE_TINT: Record<Agent['role'], string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
};

interface Props {
  width: number;
  messages: DirectorMessage[];
  agents: Agent[];
  busy: boolean;
  mode: DirectorMode;
  model: string;
  effort: EffortLevel;
  onModeChange: (next: DirectorMode) => void;
  onModelChange: (next: string) => void;
  onEffortChange: (next: EffortLevel) => void;
  onSend: (
    body: string,
    mode: DirectorMode,
    attachments?: string[],
  ) => Promise<void>;
  onSpawnPlan: (msg: DirectorMessage, rows: PlanRow[]) => Promise<void>;
  onWipe: () => Promise<void>;
  viewMode: ViewMode;
}

interface AttachmentChip {
  path: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export function DirectorPane({
  width,
  messages,
  agents,
  busy,
  mode,
  model,
  effort,
  onModeChange,
  onModelChange,
  onEffortChange,
  onSend,
  onSpawnPlan,
  onWipe,
  viewMode,
}: Props) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  return (
    <div className="pane director" style={{ width }}>
      <div className="pane-head">
        <span className="title">
          <b>Director</b>
        </span>
        <ModeToggle mode={mode} onChange={onModeChange} />
        <ModelPicker value={model} onChange={onModelChange} compact />
        <EffortPicker value={effort} onChange={onEffortChange} compact />
        <span className="spacer" />
        {busy && (
          <span className="meta" style={{ color: 'var(--accent)' }}>
            streaming
          </span>
        )}
        <button
          className="icon-btn"
          title="Wipe chat — drops messages + session memory. Agents stay."
          onClick={() => setConfirmWipe(true)}
          disabled={messages.length === 0}
        >
          <Icon name="x" size={13} />
        </button>
      </div>

      {viewMode === 'stream' ? (
        <DirectorStream
          messages={messages}
          mode={mode}
          onSpawnPlan={onSpawnPlan}
        />
      ) : messages.length === 0 ? (
        <EmptyChat mode={mode} />
      ) : (
        <Chat messages={messages} mode={mode} onSpawnPlan={onSpawnPlan} />
      )}

      <Composer
        busy={busy}
        mode={mode}
        agents={agents}
        onSend={(body, attachments) => onSend(body, mode, attachments)}
      />
      {confirmWipe && (
        <ConfirmWipe
          messageCount={messages.length}
          onConfirm={async () => {
            await onWipe();
            setConfirmWipe(false);
          }}
          onCancel={() => setConfirmWipe(false)}
        />
      )}
    </div>
  );
}

function ConfirmWipe({
  messageCount,
  onConfirm,
  onCancel,
}: {
  messageCount: number;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 420 }}
      >
        <div className="modal-head">
          <span className="title">
            <b>Wipe Director chat?</b>
          </span>
        </div>
        <div className="modal-body" style={{ gap: 8 }}>
          <p style={{ margin: 0, color: 'var(--text)', fontSize: 13 }}>
            This drops {messageCount} message
            {messageCount === 1 ? '' : 's'} and the Director&apos;s session
            memory for this project. The next message starts fresh, with
            no context from prior turns.
          </p>
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 11 }}>
            Agents stay running. Project, workspace, and config are
            untouched.
          </p>
        </div>
        <div className="modal-foot">
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
              } finally {
                setBusy(false);
              }
            }}
            disabled={busy}
          >
            <Icon name="x" size={11} /> {busy ? 'Wiping…' : 'Wipe'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModeToggle({
  mode,
  onChange,
}: {
  mode: DirectorMode;
  onChange: (next: DirectorMode) => void;
}) {
  return (
    <div className="mode-toggle" title="Auto: Director plans and auto-spawns. Manual: Director advises only.">
      <button
        className={mode === 'auto' ? 'on' : ''}
        onClick={() => onChange('auto')}
      >
        auto
      </button>
      <button
        className={mode === 'manual' ? 'on' : ''}
        onClick={() => onChange('manual')}
      >
        manual
      </button>
    </div>
  );
}

function EmptyChat({ mode }: { mode: DirectorMode }) {
  return (
    <div className="empty">
      <div className="empty-glyph">
        <Icon name="director" size={28} color="var(--accent)" stroke={1.2} />
      </div>
      <div className="empty-title">Awaiting your first task</div>
      <div className="empty-body">
        {mode === 'auto'
          ? 'Describe what you want built. The Director will plan the work and auto-spawn the agents.'
          : 'Describe what you want built. The Director will advise on roles + approach — you spawn the agents yourself from the workspace pane.'}
      </div>
      <div className="empty-hints">
        <span className="empty-hint">
          “Add Stripe subscriptions to onboarding”
        </span>
        <span className="empty-hint">
          “Audit our auth flow for OWASP top-10”
        </span>
        <span className="empty-hint">
          “Migrate the docs site from Docusaurus to Mintlify”
        </span>
      </div>
    </div>
  );
}

function Chat({
  messages,
  mode,
  onSpawnPlan,
}: {
  messages: DirectorMessage[];
  mode: DirectorMode;
  onSpawnPlan: (msg: DirectorMessage, rows: PlanRow[]) => Promise<void>;
}) {
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  return (
    <div className="chat">
      {messages.map((m) => (
        <Message key={m.id} message={m} mode={mode} onSpawn={onSpawnPlan} />
      ))}
      <div ref={tailRef} />
    </div>
  );
}

function Message({
  message,
  mode,
  onSpawn,
}: {
  message: DirectorMessage;
  mode: DirectorMode;
  onSpawn: (msg: DirectorMessage, rows: PlanRow[]) => Promise<void>;
}) {
  return (
    <div className="msg">
      <div className={'msg-head ' + message.who}>
        <span className="who">{message.name}</span>
        <span>·</span>
        <span>{message.time}</span>
        {message.live && (
          <span style={{ color: 'var(--accent)' }}>· streaming</span>
        )}
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="msg-attachments">
          {message.attachments.map((a, i) => (
            <span className="att-chip" key={`${a.path}-${i}`} title={a.path}>
              <Icon name="attach" size={10} /> {a.name}
            </span>
          ))}
        </div>
      )}
      {(message.body || message.live) && (
        <div className="msg-body">
          {message.body}
          {message.live && !message.body && <span className="log-cursor" />}
        </div>
      )}
      {message.plan && message.plan.length > 0 && (
        <PlanCard
          rows={message.plan}
          accepted={message.planAccepted === true}
          mode={mode}
          onSpawn={(rows) => onSpawn(message, rows)}
        />
      )}
      {message.redirect && (
        <div className="dir-redirect">
          <div className="dir-redirect-head">
            <Icon name="redirect" size={11} color="var(--accent)" /> Redirect
            <span className="badge">
              {message.redirectFired ? 'fired' : 'queued'}
            </span>
          </div>
          <div className="dir-redirect-body">
            <span className="r-agent">@{message.redirect.agent}</span>{' '}
            {message.redirect.instruction}
          </div>
        </div>
      )}
    </div>
  );
}

function Composer({
  busy,
  mode,
  agents,
  onSend,
}: {
  busy: boolean;
  mode: DirectorMode;
  agents: Agent[];
  onSend: (body: string, attachments?: string[]) => Promise<void>;
}) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [mentionState, setMentionState] = useState<{
    open: boolean;
    query: string;
    /** Index in `text` where the '@' sits. */
    atIdx: number;
    selected: number;
  }>({ open: false, query: '', atIdx: -1, selected: 0 });

  const mentionMatches = useMemo(() => {
    if (!mentionState.open) return [];
    const q = mentionState.query.toLowerCase();
    return agents
      .filter((a) => !q || a.name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [mentionState, agents]);

  const pick = async () => {
    const { attachments: picked } = await window.api.pickAttachments();
    if (picked.length === 0) return;
    setAttachments((prev) => [...prev, ...picked]);
  };

  const remove = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const submit = async () => {
    const body = text.trim();
    const okPaths = attachments.filter((a) => a.ok).map((a) => a.path);
    if (!body && okPaths.length === 0) return;
    if (busy) return;
    setText('');
    setAttachments([]);
    setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
    await onSend(body, okPaths.length > 0 ? okPaths : undefined);
  };

  /** Detect `@<prefix>` at the cursor and open/refresh the picker. */
  const refreshMention = (value: string, caret: number) => {
    // Walk back from caret looking for an '@' bounded by start-of-line or
    // whitespace. Stop if we hit whitespace before an '@' (so spaces close
    // the picker).
    let i = caret - 1;
    while (i >= 0) {
      const ch = value[i];
      if (ch === '@') {
        const before = i === 0 ? ' ' : value[i - 1];
        if (/\s/.test(before) || i === 0) {
          const query = value.slice(i + 1, caret);
          if (/^[A-Za-z0-9_-]*$/.test(query)) {
            setMentionState({ open: true, query, atIdx: i, selected: 0 });
            return;
          }
        }
        break;
      }
      if (/\s/.test(ch)) break;
      i--;
    }
    setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
  };

  const insertMention = (name: string) => {
    if (mentionState.atIdx < 0) return;
    const before = text.slice(0, mentionState.atIdx);
    const after = text.slice(
      mentionState.atIdx + 1 + mentionState.query.length,
    );
    const inserted = `@${name} `;
    const next = before + inserted + after;
    setText(next);
    setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
    // Restore caret right after the inserted mention.
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const pos = before.length + inserted.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionState.open && mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionState((m) => ({
          ...m,
          selected: Math.min(mentionMatches.length - 1, m.selected + 1),
        }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionState((m) => ({
          ...m,
          selected: Math.max(0, m.selected - 1),
        }));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        insertMention(mentionMatches[mentionState.selected].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
        return;
      }
    }
    // Only intercept Enter for submit when Director is idle. While busy,
    // let Enter insert a newline so the user can keep composing their
    // next message instead of being locked out for a few seconds.
    if (e.key === 'Enter' && !e.shiftKey && !busy) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
      {attachments.length > 0 && (
        <div className="att-row">
          {attachments.map((a) => (
            <span
              className={'att-chip' + (a.ok ? '' : ' bad')}
              key={a.path}
              title={a.reason ?? a.path}
            >
              <Icon name="attach" size={10} />
              {a.name}
              <button
                className="att-x"
                onClick={() => remove(a.path)}
                title="Remove"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-input-wrap">
        <textarea
          ref={taRef}
          className="composer-textarea"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            refreshMention(e.target.value, e.target.selectionStart ?? 0);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            const target = e.target as HTMLTextAreaElement;
            refreshMention(target.value, target.selectionStart ?? 0);
          }}
          onClick={(e) => {
            const target = e.target as HTMLTextAreaElement;
            refreshMention(target.value, target.selectionStart ?? 0);
          }}
          placeholder={
            mode === 'auto'
              ? 'Describe a task — Director will plan & auto-spawn… (type @ to reference an agent)'
              : 'Ask the Director for advice… (type @ to reference an agent)'
          }
          rows={3}
        />
        {mentionState.open && mentionMatches.length > 0 && (
          <div className="mention-picker">
            {mentionMatches.map((a, i) => (
              <div
                key={a.id}
                className={'mention-item' + (i === mentionState.selected ? ' on' : '')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertMention(a.name);
                }}
              >
                <span className="m-name">@{a.name}</span>
                <span
                  className="m-role"
                  style={{ color: ROLE_TINT[a.role] }}
                >
                  {a.role}
                </span>
                <span className="m-status">{a.status}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="composer-bar">
        <button
          className="tb-btn"
          style={{ height: 22 }}
          onClick={() => void pick()}
          disabled={busy}
          title="Attach text files (md / code / config)"
        >
          <Icon name="attach" size={11} /> Attach
        </button>
        <span className="spacer" />
        <span style={{ color: 'var(--muted-2)' }}>⇧↵ newline</span>
        <button
          className="tb-btn primary"
          style={{ height: 22 }}
          onClick={() => void submit()}
          disabled={
            busy ||
            (!text.trim() && attachments.filter((a) => a.ok).length === 0)
          }
        >
          <Icon name="send" size={11} /> {busy ? 'Working…' : 'Send'}
          <span className="kbd">↵</span>
        </button>
      </div>
    </div>
  );
}
