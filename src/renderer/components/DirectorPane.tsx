import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { DirectorMessage } from '../../shared/types';
import { Icon } from './Icon';
import { PlanCard } from './PlanCard';

interface Props {
  width: number;
  messages: DirectorMessage[];
  busy: boolean;
  onSend: (body: string) => Promise<void>;
}

export function DirectorPane({ width, messages, busy, onSend }: Props) {
  return (
    <div className="pane director" style={{ width }}>
      <div className="pane-head">
        <span className="title">
          <b>Director</b>
        </span>
        <span className="meta">claude-sonnet-4-6</span>
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
        <EmptyChat />
      ) : (
        <Chat messages={messages} />
      )}

      <Composer busy={busy} onSend={onSend} />
    </div>
  );
}

function EmptyChat() {
  return (
    <div className="empty">
      <div className="empty-glyph">
        <Icon name="director" size={28} color="var(--accent)" stroke={1.2} />
      </div>
      <div className="empty-title">Awaiting your first task</div>
      <div className="empty-body">
        Describe what you want built, refactored, or investigated. The
        Director will plan the work and propose a fleet of agents to
        carry it out.
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

function Chat({ messages }: { messages: DirectorMessage[] }) {
  const tailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    tailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages.length]);

  return (
    <div className="chat">
      {messages.map((m) => (
        <Message key={m.id} message={m} />
      ))}
      <div ref={tailRef} />
    </div>
  );
}

function Message({ message }: { message: DirectorMessage }) {
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
        />
      )}
    </div>
  );
}

function Composer({
  busy,
  onSend,
}: {
  busy: boolean;
  onSend: (body: string) => Promise<void>;
}) {
  const [text, setText] = useState('');

  const submit = async () => {
    const body = text.trim();
    if (!body || busy) return;
    setText('');
    await onSend(body);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
      <textarea
        className="composer-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Tell the Director what to do next…"
        rows={3}
        disabled={busy}
      />
      <div className="composer-bar">
        <span className="chip">
          <Icon name="attach" size={10} /> 0 attachments
        </span>
        <span className="chip">
          <Icon name="branch" size={10} /> main
        </span>
        <span className="chip">@ agent</span>
        <span className="spacer" />
        <span style={{ color: 'var(--muted-2)' }}>⇧↵ newline</span>
        <button
          className="tb-btn primary"
          style={{ height: 22 }}
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
        >
          <Icon name="send" size={11} /> {busy ? 'Working…' : 'Send'}
          <span className="kbd">↵</span>
        </button>
      </div>
    </div>
  );
}
