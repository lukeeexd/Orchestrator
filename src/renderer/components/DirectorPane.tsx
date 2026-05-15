import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DirectorMessage, DirectorMode, PlanRow } from '../../shared/types';
import { Icon } from './Icon';
import { PlanCard } from './PlanCard';

interface Props {
  width: number;
  messages: DirectorMessage[];
  busy: boolean;
  mode: DirectorMode;
  onModeChange: (next: DirectorMode) => void;
  onSend: (
    body: string,
    mode: DirectorMode,
    attachments?: string[],
  ) => Promise<void>;
  onSpawnPlan: (msg: DirectorMessage) => Promise<void>;
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
  busy,
  mode,
  onModeChange,
  onSend,
  onSpawnPlan,
}: Props) {
  return (
    <div className="pane director" style={{ width }}>
      <div className="pane-head">
        <span className="title">
          <b>Director</b>
        </span>
        <ModeToggle mode={mode} onChange={onModeChange} />
        <span className="spacer" />
        {busy && (
          <span className="meta" style={{ color: 'var(--accent)' }}>
            streaming
          </span>
        )}
        <button className="icon-btn" title="More">
          <Icon name="more" size={13} />
        </button>
      </div>

      {messages.length === 0 ? (
        <EmptyChat mode={mode} />
      ) : (
        <Chat messages={messages} mode={mode} onSpawnPlan={onSpawnPlan} />
      )}

      <Composer
        busy={busy}
        mode={mode}
        onSend={(body, attachments) => onSend(body, mode, attachments)}
      />
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
  onSpawnPlan: (msg: DirectorMessage) => Promise<void>;
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
  onSpawn: (msg: DirectorMessage) => Promise<void>;
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
          onSpawn={() => onSpawn(message)}
        />
      )}
    </div>
  );
}

function Composer({
  busy,
  mode,
  onSend,
}: {
  busy: boolean;
  mode: DirectorMode;
  onSend: (body: string, attachments?: string[]) => Promise<void>;
}) {
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);

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
    await onSend(body, okPaths.length > 0 ? okPaths : undefined);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
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
      <textarea
        className="composer-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          mode === 'auto'
            ? 'Describe a task — Director will plan & auto-spawn…'
            : 'Ask the Director for advice…'
        }
        rows={3}
        disabled={busy}
      />
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
