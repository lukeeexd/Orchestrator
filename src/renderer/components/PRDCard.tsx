import { useState } from 'react';
import type { ProjectPrd } from '../../shared/types';
import { Icon } from './Icon';

interface Props {
  prd: ProjectPrd;
}

/**
 * P15: Renders a Director-emitted PRD as a card inside the Director
 * stream. Sections are emitted in the order:
 *   problem → goals → non_goals → constraints → open_questions
 *
 * Empty arrays are rendered as a "—" placeholder rather than hidden,
 * so reviewers can see at a glance that a section is deliberately
 * empty (vs missing data).
 *
 * "Copy as markdown" is the only affordance — the user pastes into
 * their own notes / issue tracker / Confluence. No save-to-disk
 * because we don't know where the user's docs live.
 */
export function PRDCard({ prd }: Props) {
  const [copied, setCopied] = useState(false);

  const md = formatAsMarkdown(prd);

  const onCopy = () => {
    void navigator.clipboard.writeText(md).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="prd-card">
      <div className="prd-head">
        <span className="prd-badge">PRD</span>
        {prd.title && <span className="prd-title">{prd.title}</span>}
        <button
          className="tb-btn"
          onClick={onCopy}
          title="Copy this PRD as Markdown to the clipboard"
          style={{ marginLeft: 'auto' }}
        >
          <Icon name={copied ? 'check' : 'file'} size={11} />{' '}
          {copied ? 'Copied' : 'Copy as Markdown'}
        </button>
      </div>

      <Section label="Problem">
        <p className="prd-prose">{prd.problem}</p>
      </Section>

      <Section label="Goals">
        <BulletList items={prd.goals} />
      </Section>

      <Section label="Non-goals">
        <BulletList items={prd.non_goals} />
      </Section>

      <Section label="Constraints">
        <BulletList items={prd.constraints} />
      </Section>

      <Section label="Open questions">
        <BulletList items={prd.open_questions} />
      </Section>
    </div>
  );
}

function Section({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="prd-section">
      <div className="prd-section-label">{label}</div>
      <div className="prd-section-body">{children}</div>
    </div>
  );
}

function BulletList({ items }: { items: string[] }) {
  if (items.length === 0) return <span className="prd-empty">—</span>;
  return (
    <ul className="prd-list">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  );
}

function formatAsMarkdown(prd: ProjectPrd): string {
  const lines: string[] = [];
  lines.push(`# ${prd.title ?? 'Product Requirements'}`);
  lines.push('');
  lines.push('## Problem');
  lines.push(prd.problem);
  lines.push('');
  const section = (label: string, items: string[]) => {
    lines.push(`## ${label}`);
    if (items.length === 0) lines.push('_None._');
    else for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  };
  section('Goals', prd.goals);
  section('Non-goals', prd.non_goals);
  section('Constraints', prd.constraints);
  section('Open questions', prd.open_questions);
  return lines.join('\n').trim() + '\n';
}
