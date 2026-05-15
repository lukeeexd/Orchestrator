import { Icon, type IconName } from './Icon';

interface Props {
  icon: IconName;
  title: string;
  body: string;
}

export function PlaceholderScreen({ icon, title, body }: Props) {
  return (
    <div className="pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>{title}</b>
        </span>
      </div>
      <div className="empty" style={{ height: '100%' }}>
        <div className="empty-glyph">
          <Icon name={icon} size={28} color="var(--muted)" stroke={1.2} />
        </div>
        <div className="empty-title" style={{ color: 'var(--text-2)' }}>
          {title} — coming in v1.1
        </div>
        <div className="empty-body">{body}</div>
      </div>
    </div>
  );
}
