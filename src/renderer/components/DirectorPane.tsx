import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import type {
  Agent,
  DirectorMessage,
  DirectorMode,
  EffortLevel,
  PlanRow,
  Provider,
} from '../../shared/types';
import type { SlashCommand } from '../../shared/commands';
import { applyCommandArguments } from '../../shared/commands';
import { BUILTIN_COMMANDS } from '../../shared/builtinCommands';
import { Icon } from './Icon';
import { PlanCard } from './PlanCard';
import { ModelPicker } from './ModelPicker';
import { EffortPicker } from './EffortPicker';
import { DirectorStream } from './DirectorStream';
import type { ViewMode } from './TopBar';
import type { BuiltinAction } from '../../shared/builtinCommands';
import { handleImageDrop, handleImagePaste } from '../lib/imagePaste';

const ROLE_TINT: Record<Agent['role'], string> = {
  pm: '#4ade80',
  researcher: '#60a5fa',
  coder: '#c084fc',
  qa: '#fbbf24',
  devops: '#f97316',
  security: '#f87171',
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
  provider: Provider;
  /** Project id used to scope which `.claude/commands/` directory to load from. */
  projectId: string | null;
  /** Dispatches built-in slash command actions (rail nav, wipe, etc). */
  onSlashAction: (action: BuiltinAction) => void | Promise<void>;
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
  provider,
  projectId,
  onSlashAction,
}: Props) {
  const [confirmWipe, setConfirmWipe] = useState(false);
  return (
    <div className="pane director" style={{ width }}>
      <div className="pane-head">
        <span className="title">
          <b>Director</b>
        </span>
        {provider === 'codex' && (
          <span
            className="badge"
            title="This project runs against the `codex` CLI. Effort + tool allow-lists are simpler/different for Codex agents."
            style={{ background: 'var(--sub-2)', color: 'var(--muted)' }}
          >
            codex
          </span>
        )}
        <ModeToggle mode={mode} onChange={onModeChange} />
        <ModelPicker
          value={model}
          onChange={onModelChange}
          compact
          provider={provider}
        />
        {provider === 'claude' && (
          <EffortPicker value={effort} onChange={onEffortChange} compact />
        )}
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
        key={projectId ?? 'no-project'}
        busy={busy}
        mode={mode}
        agents={agents}
        projectId={projectId}
        onSend={(body, attachments) => onSend(body, mode, attachments)}
        onSlashAction={onSlashAction}
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
  projectId,
  onSend,
  onSlashAction,
}: {
  busy: boolean;
  mode: DirectorMode;
  agents: Agent[];
  projectId: string | null;
  onSend: (body: string, attachments?: string[]) => Promise<void>;
  onSlashAction: (action: BuiltinAction) => void | Promise<void>;
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
  const [slashState, setSlashState] = useState<{
    open: boolean;
    query: string;
    selected: number;
  }>({ open: false, query: '', selected: 0 });
  const [commands, setCommands] = useState<SlashCommand[]>(
    BUILTIN_COMMANDS as SlashCommand[],
  );
  const [helpOpen, setHelpOpen] = useState(false);

  // Load custom slash commands from disk for the active project. Built-ins
  // come from shared/builtinCommands so they're always available without
  // a round-trip.
  useEffect(() => {
    void window.api.listSlashCommands(projectId).then((disk) => {
      setCommands([...(BUILTIN_COMMANDS as SlashCommand[]), ...disk]);
    });
  }, [projectId]);

  const mentionMatches = useMemo(() => {
    if (!mentionState.open) return [];
    const q = mentionState.query.toLowerCase();
    return agents
      .filter((a) => !q || a.name.toLowerCase().startsWith(q))
      .slice(0, 8);
  }, [mentionState, agents]);

  const slashMatches = useMemo(() => {
    if (!slashState.open) return [];
    const q = slashState.query.toLowerCase();
    return commands
      .filter((c) => !q || c.name.toLowerCase().startsWith(q))
      .slice(0, 10);
  }, [slashState, commands]);

  const pick = async () => {
    const { attachments: picked } = await window.api.pickAttachments();
    if (picked.length === 0) return;
    setAttachments((prev) => [...prev, ...picked]);
  };

  const remove = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
    // Fire-and-forget cleanup of the ephemeral paste-temp file (if any).
    // Main-side guards against deleting picked attachments outside our
    // managed temp dir, so this is safe for every chip removal.
    if (path) void window.api.disposeAttachment(path);
  };

  const submit = async () => {
    const body = text.trim();
    const okPaths = attachments.filter((a) => a.ok).map((a) => a.path);
    if (!body && okPaths.length === 0) return;
    if (busy) return;

    // Slash command interception. Built-ins fire local actions and never
    // hit the agent. Custom commands expand to their .md body (with
    // $ARGUMENTS substituted) and then go through the normal send path.
    if (body.startsWith('/')) {
      const spaceIdx = body.indexOf(' ');
      const cmdName = body.slice(1, spaceIdx < 0 ? undefined : spaceIdx);
      const restArgs = spaceIdx < 0 ? '' : body.slice(spaceIdx + 1);
      const match = commands.find((c) => c.name === cmdName);
      if (match) {
        const builtin = (BUILTIN_COMMANDS as SlashCommand[]).find(
          (c) => c.name === cmdName,
        );
        if (builtin) {
          // Built-in: fire the action, clear input, no send. The action
          // type is the builtin's stored field — narrow via the original
          // BUILTIN_COMMANDS so we keep the discriminated union.
          const action = (
            BUILTIN_COMMANDS.find((c) => c.name === cmdName) as
              | (typeof BUILTIN_COMMANDS)[number]
              | undefined
          )?.action;
          setText('');
          setAttachments([]);
          setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
          setSlashState({ open: false, query: '', selected: 0 });
          if (action === 'show-help') {
            setHelpOpen(true);
            return;
          }
          if (action) void onSlashAction(action);
          return;
        }
        // Custom command: expand $ARGUMENTS and send as a normal prompt.
        const expanded = applyCommandArguments(match.body, restArgs);
        setText('');
        setAttachments([]);
        setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
        setSlashState({ open: false, query: '', selected: 0 });
        await onSend(expanded, okPaths.length > 0 ? okPaths : undefined);
        return;
      }
      // Unknown /command: fall through to the literal-prompt path —
      // matches the Claude CLI's behaviour for typos.
    }

    setText('');
    setAttachments([]);
    setMentionState({ open: false, query: '', atIdx: -1, selected: 0 });
    setSlashState({ open: false, query: '', selected: 0 });
    await onSend(body, okPaths.length > 0 ? okPaths : undefined);
  };

  /** Detect `/<word>` at the very start of input. */
  const refreshSlash = (value: string, caret: number) => {
    if (!value.startsWith('/')) {
      setSlashState({ open: false, query: '', selected: 0 });
      return;
    }
    const firstSpace = value.indexOf(' ');
    const cmdEnd = firstSpace < 0 ? value.length : firstSpace;
    if (caret > cmdEnd) {
      // Caret moved past the command word — close picker so it doesn't
      // hover while the user is typing arguments.
      setSlashState({ open: false, query: '', selected: 0 });
      return;
    }
    const query = value.slice(1, cmdEnd);
    if (!/^[A-Za-z0-9_-]*$/.test(query)) {
      setSlashState({ open: false, query: '', selected: 0 });
      return;
    }
    setSlashState({ open: true, query, selected: 0 });
  };

  const insertSlash = (name: string) => {
    // Replace the typed `/<query>` with `/<name> ` so the user can type
    // arguments straight away. Built-ins without args are still
    // submittable by hitting Enter immediately.
    const firstSpace = text.indexOf(' ');
    const rest = firstSpace < 0 ? '' : text.slice(firstSpace);
    const next = `/${name}${rest || ' '}`;
    setText(next);
    setSlashState({ open: false, query: '', selected: 0 });
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      const pos = next.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
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
    if (slashState.open && slashMatches.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashState((s) => ({
          ...s,
          selected: Math.min(slashMatches.length - 1, s.selected + 1),
        }));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashState((s) => ({ ...s, selected: Math.max(0, s.selected - 1) }));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        insertSlash(slashMatches[slashState.selected].name);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashState({ open: false, query: '', selected: 0 });
        return;
      }
      // Note: Enter while the picker is open does NOT pick — it submits.
      // For a builtin like /clear, the user types `/cl` + Tab to expand
      // OR `/clear` + Enter; either way submit() routes the action.
    }
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
            refreshSlash(e.target.value, e.target.selectionStart ?? 0);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => {
            const target = e.target as HTMLTextAreaElement;
            refreshMention(target.value, target.selectionStart ?? 0);
            refreshSlash(target.value, target.selectionStart ?? 0);
          }}
          onClick={(e) => {
            const target = e.target as HTMLTextAreaElement;
            refreshMention(target.value, target.selectionStart ?? 0);
            refreshSlash(target.value, target.selectionStart ?? 0);
          }}
          onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
            void handleImagePaste(e, (info) =>
              setAttachments((prev) => [...prev, info]),
            );
          }}
          onDragOver={(e: DragEvent<HTMLTextAreaElement>) =>
            e.preventDefault()
          }
          onDrop={(e: DragEvent<HTMLTextAreaElement>) => {
            void handleImageDrop(e, (info) =>
              setAttachments((prev) => [...prev, info]),
            );
          }}
          placeholder={
            mode === 'auto'
              ? 'Describe a task — Director will plan & auto-spawn… (/ for commands, @ for agents, paste or drop images to attach)'
              : 'Ask the Director for advice… (/ for commands, @ for agents, paste or drop images to attach)'
          }
          rows={3}
        />
        {slashState.open && slashMatches.length > 0 && (
          <div className="mention-picker slash-picker">
            {slashMatches.map((c, i) => (
              <div
                key={`${c.scope}:${c.name}`}
                className={'mention-item' + (i === slashState.selected ? ' on' : '')}
                onMouseDown={(e) => {
                  e.preventDefault();
                  insertSlash(c.name);
                }}
                title={c.body || c.description}
              >
                <span className="m-name">/{c.name}</span>
                {c.argumentHint && (
                  <span className="m-role">{c.argumentHint}</span>
                )}
                <span
                  className="m-status"
                  style={{
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                    maxWidth: 320,
                  }}
                >
                  {c.description}
                </span>
                <span
                  className="m-status"
                  style={{
                    fontSize: 9,
                    color: 'var(--muted-2)',
                    marginLeft: 4,
                  }}
                  title={c.source}
                >
                  {c.scope}
                </span>
              </div>
            ))}
          </div>
        )}
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
          title="Attach text files (md / code / config) or images (or paste images directly)"
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
      {helpOpen && (
        <SlashHelpModal
          commands={commands}
          onClose={() => setHelpOpen(false)}
        />
      )}
    </div>
  );
}

function SlashHelpModal({
  commands,
  onClose,
}: {
  commands: SlashCommand[];
  onClose: () => void;
}) {
  const byScope = {
    builtin: commands.filter((c) => c.scope === 'builtin'),
    project: commands.filter((c) => c.scope === 'project'),
    user: commands.filter((c) => c.scope === 'user'),
  };
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, maxHeight: '80vh', overflow: 'auto' }}
      >
        <div className="modal-head">
          <span className="title">
            <b>Slash commands</b>
          </span>
          <span className="spacer" />
          <button className="icon-btn" onClick={onClose} title="Close">
            <Icon name="x" size={11} />
          </button>
        </div>
        <div className="modal-body" style={{ gap: 14 }}>
          {(['builtin', 'project', 'user'] as const).map((scope) =>
            byScope[scope].length === 0 ? null : (
              <section key={scope}>
                <h3 className="settings-h" style={{ marginBottom: 6 }}>
                  {scope === 'builtin'
                    ? 'Built-in'
                    : scope === 'project'
                    ? `Project (.claude/commands/)`
                    : `User (~/.claude/commands/)`}
                </h3>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                  }}
                >
                  {byScope[scope].map((c) => (
                    <div
                      key={c.name}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '120px 1fr',
                        gap: 10,
                        alignItems: 'baseline',
                      }}
                    >
                      <span style={{ color: 'var(--accent)' }}>
                        /{c.name}
                        {c.argumentHint ? (
                          <span style={{ color: 'var(--muted)' }}>
                            {' '}
                            {c.argumentHint}
                          </span>
                        ) : null}
                      </span>
                      <span style={{ color: 'var(--text)' }}>
                        {c.description}
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            ),
          )}
          <p
            style={{
              margin: 0,
              fontSize: 11,
              color: 'var(--muted)',
            }}
          >
            Project commands shadow user-scoped commands with the same name.
            Built-in names are reserved. Custom commands support{' '}
            <code>$ARGUMENTS</code> (everything after the command name) and
            positional <code>$1</code>/<code>$2</code> placeholders.
          </p>
        </div>
      </div>
    </div>
  );
}
