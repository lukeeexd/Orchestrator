import { Icon } from './Icon';

interface Props {
  width: number;
}

export function Drawer({ width }: Props) {
  return (
    <div className="drawer" style={{ width }}>
      <div className="empty" style={{ height: '100%' }}>
        <div className="empty-glyph">
          <Icon name="agents" size={24} color="var(--muted)" stroke={1.2} />
        </div>
        <div className="empty-title" style={{ color: 'var(--text-2)' }}>
          No agent selected
        </div>
        <div className="empty-body">
          Click any agent in the workspace to inspect its tools, memory,
          context, and live log. Hit <code>⌘1</code>–<code>⌘9</code> to jump.
        </div>
      </div>
    </div>
  );
}
