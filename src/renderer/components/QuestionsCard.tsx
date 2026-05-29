import { useMemo, useState } from 'react';
import type { ClarifyingQuestion } from '../../shared/types';
import { Icon } from './Icon';

interface Props {
  questions: ClarifyingQuestion[];
  /**
   * Send the composed answers back to the Director. Reuses the normal send
   * path, which resumes the Director session — so the Director sees its own
   * questions + these answers and emits a grounded plan (a fresh message
   * below). Returns when the send is dispatched.
   */
  onSubmitAnswers: (composed: string) => Promise<void>;
}

/**
 * N8: the Director's pre-plan clarifying questions, with an answer field each.
 * Submitting composes a plain-text answers message (NOT a fenced block — only
 * Director output is parsed for directives) and sends it via the Director send
 * path. Local state only: once sent, the card locks; the grounded plan that
 * arrives next is the durable record.
 */
export function QuestionsCard({ questions, onSubmitAnswers }: Props) {
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const hasAny = useMemo(
    () => Object.values(answers).some((a) => a.trim().length > 0),
    [answers],
  );

  const submit = async () => {
    if (busy || sent) return;
    setBusy(true);
    const lines: string[] = [
      'Here are my answers to your clarifying questions:',
      '',
    ];
    questions.forEach((q, i) => {
      const a = (answers[i] ?? '').trim();
      lines.push(`${i + 1}. Q: ${q.question}`);
      lines.push(`   A: ${a || '(no answer — use a sensible default)'}`);
    });
    lines.push('', 'Please now produce the plan.');
    try {
      await onSubmitAnswers(lines.join('\n'));
      setSent(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="prd-card questions-card">
      <div className="prd-head">
        <span className="prd-badge">Questions</span>
        <span className="prd-title">Clarify before planning</span>
        <span style={{ flex: 1 }} />
        {sent ? (
          <span className="prd-badge">sent</span>
        ) : (
          <button
            className="tb-btn primary"
            onClick={() => void submit()}
            disabled={busy || !hasAny}
            title={
              hasAny
                ? 'Send answers back to the Director — it will emit a grounded plan'
                : 'Answer at least one question (blanks become sensible defaults)'
            }
          >
            <Icon name="send" size={11} /> {busy ? 'Sending…' : 'Send answers'}
          </button>
        )}
      </div>

      {questions.map((q, i) => (
        <div className="prd-section" key={i}>
          <div className="prd-section-label">{q.question}</div>
          <div className="prd-section-body">
            <div className="questions-why">{q.why}</div>
            <textarea
              className="questions-answer"
              value={answers[i] ?? ''}
              onChange={(e) =>
                setAnswers((prev) => ({ ...prev, [i]: e.target.value }))
              }
              placeholder="Your answer (leave blank to let the Director assume a sensible default)"
              rows={2}
              disabled={sent || busy}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
