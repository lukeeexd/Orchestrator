import { useEffect, useRef, useState } from 'react';
import type { DirectorMessage, DirectorMode, PlanRow } from '../../shared/types';
import { PlanCard } from './PlanCard';
import { PRDCard } from './PRDCard';
import { QuestionsCard } from './QuestionsCard';
import { Icon } from './Icon';
import { findPrevPlanRows } from '../lib/planDiff';

/**
 * Flat terminal-style render of the Director's conversation. Replaces the
 * chat-bubble layout from `DirectorPane.Chat` when the view-mode toggle
 * is set to "stream".
 *
 * Plan blocks and Redirect blocks still render as structured cards
 * inline — they're actionable and would lose their affordance if
 * collapsed into plain text. Everything else is monospace prose with
 * Claude-Code-style glyph prefixes.
 *
 * Auto-scrolls to the tail unless the user has scrolled up to read —
 * we lock scroll while they're not near the bottom so a streaming
 * response doesn't yank them away mid-read.
 */
interface Props {
  messages: DirectorMessage[];
  mode: DirectorMode;
  onSpawnPlan: (msg: DirectorMessage, rows: PlanRow[]) => Promise<void>;
  onSaveAsTemplate?: (rows: PlanRow[]) => void;
  /** F5: caller handles confirmation + refresh. Per-message affordance. */
  onRewindTo: (messageId: string) => Promise<void>;
  /** N8: submit clarifying-question answers back to the Director. */
  onSubmitAnswers: (composed: string) => Promise<void>;
}

export function DirectorStream({
  messages,
  mode,
  onSpawnPlan,
  onSaveAsTemplate,
  onRewindTo,
  onSubmitAnswers,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [stickToBottom, setStickToBottom] = useState(true);

  // Track whether the user is near the bottom. If they scroll up to read,
  // suspend auto-scroll until they come back. 80px tolerance accounts for
  // momentum scroll + the tail spacer below the last message.
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setStickToBottom(nearBottom);
  };

  useEffect(() => {
    if (!stickToBottom) return;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, stickToBottom]);

  return (
    <div className="director-stream" ref={scrollRef} onScroll={onScroll}>
      {messages.map((m, idx) => (
        <StreamEntry
          key={m.id}
          message={m}
          mode={mode}
          onSpawnPlan={(rows) => onSpawnPlan(m, rows)}
          onSaveAsTemplate={onSaveAsTemplate}
          prevPlanRows={
            m.plan && m.plan.length > 0
              ? findPrevPlanRows(messages, idx)
              : undefined
          }
          onRewindTo={onRewindTo}
          isLastMessage={idx === messages.length - 1}
          onSubmitAnswers={onSubmitAnswers}
        />
      ))}
      {messages.length === 0 && (
        <div className="stream-empty">
          <span className="dim">
            <Icon name="director" size={11} /> Director idle. Type below to
            send a task.
          </span>
        </div>
      )}
    </div>
  );
}

function StreamEntry({
  message,
  mode,
  onSpawnPlan,
  onSaveAsTemplate,
  prevPlanRows,
  onRewindTo,
  isLastMessage,
  onSubmitAnswers,
}: {
  message: DirectorMessage;
  mode: DirectorMode;
  onSpawnPlan: (rows: PlanRow[]) => Promise<void>;
  onSaveAsTemplate?: (rows: PlanRow[]) => void;
  prevPlanRows?: PlanRow[];
  onRewindTo: (messageId: string) => Promise<void>;
  isLastMessage: boolean;
  onSubmitAnswers: (composed: string) => Promise<void>;
}) {
  // F5: same skip-conditions as the chat-view Message component.
  const canRewind = !message.live && !isLastMessage;
  // Pick a glyph + className per author. Mirrors the Claude Code CLI's
  // ●/⏺/⎿ vocabulary — keeps reads quick: ● is "actor talking", ⎿ is
  // "system narration", >  is "user input".
  const glyph =
    message.who === 'user'
      ? '>'
      : message.who === 'system'
      ? '⎿'
      : '●';
  const klass =
    'stream-entry ' +
    message.who +
    (message.live ? ' live' : '');

  return (
    <div className={klass}>
      <div className="stream-head">
        <span className="glyph">{glyph}</span>
        <span className="who">{message.name}</span>
        <span className="dim">·</span>
        <span className="dim ts">{message.time}</span>
        {canRewind && (
          <button
            className="dir-msg-rewind"
            onClick={() => void onRewindTo(message.id)}
            title="Rewind the Director chat here — every message after this point is wiped and the next turn starts a fresh session"
          >
            <Icon name="redirect" size={10} /> rewind
          </button>
        )}
        {message.live && <span className="dim live-dot">streaming…</span>}
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="stream-attachments">
          {message.attachments.map((a, i) => (
            <span className="att-chip" key={`${a.path}-${i}`} title={a.path}>
              <Icon name="attach" size={10} /> {a.name}
            </span>
          ))}
        </div>
      )}
      {(message.body || message.live) && (
        <div className="stream-body">
          {message.body}
          {message.live && !message.body && <span className="log-cursor" />}
        </div>
      )}
      {message.plan && message.plan.length > 0 && (
        <div className="stream-card">
          <PlanCard
            rows={message.plan}
            accepted={message.planAccepted === true}
            mode={mode}
            onSpawn={onSpawnPlan}
            onSaveAsTemplate={onSaveAsTemplate}
            prevRows={prevPlanRows}
            critique={message.critique}
          />
        </div>
      )}
      {message.prd && (
        <div className="stream-card">
          <PRDCard prd={message.prd} />
        </div>
      )}
      {message.questions && message.questions.length > 0 && (
        <div className="stream-card">
          <QuestionsCard
            questions={message.questions}
            onSubmitAnswers={onSubmitAnswers}
          />
        </div>
      )}
      {message.redirect && (
        <div className="stream-redirect">
          <span className="glyph">⎿</span>
          <span className="badge">
            redirect · {message.redirectFired ? 'fired' : 'queued'}
          </span>
          <span className="r-agent">@{message.redirect.agent}</span>
          <span className="dim">— {message.redirect.instruction}</span>
        </div>
      )}
    </div>
  );
}
