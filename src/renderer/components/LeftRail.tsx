import { Icon, type IconName } from './Icon';

export type RailScreen =
  | 'agents'
  | 'templates'
  | 'tools'
  | 'cost'
  | 'history'
  | 'settings';

interface RailItem {
  id: RailScreen;
  icon: IconName;
  label: string;
  badge?: string;
}

interface Props {
  active: RailScreen;
  agentCount: number;
  onSelect: (next: RailScreen) => void;
}

export function LeftRail({ active, agentCount, onSelect }: Props) {
  const items: RailItem[] = [
    {
      id: 'agents',
      icon: 'agents',
      label: 'Agents',
      badge: agentCount > 0 ? String(agentCount) : undefined,
    },
    { id: 'templates', icon: 'templates', label: 'Templates' },
    { id: 'tools', icon: 'tools', label: 'Tools' },
    { id: 'cost', icon: 'cost', label: 'Spend' },
    { id: 'history', icon: 'history', label: 'Runs' },
  ];

  return (
    <div className="rail">
      {items.map((it) => (
        <div
          key={it.id}
          className={'rail-item' + (active === it.id ? ' active' : '')}
          title={it.label}
          onClick={() => onSelect(it.id)}
        >
          <Icon name={it.icon} size={16} />
          {it.badge && <span className="badge">{it.badge}</span>}
        </div>
      ))}
      <div className="rail-spacer" />
      <div
        className={'rail-item' + (active === 'settings' ? ' active' : '')}
        title="Settings"
        onClick={() => onSelect('settings')}
      >
        <Icon name="settings" size={16} />
      </div>
    </div>
  );
}
