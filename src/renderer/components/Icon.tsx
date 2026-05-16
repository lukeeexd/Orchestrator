import type { CSSProperties } from 'react';

export type IconName =
  | 'director'
  | 'agents'
  | 'templates'
  | 'history'
  | 'tools'
  | 'cost'
  | 'settings'
  | 'play'
  | 'pause'
  | 'stop'
  | 'fork'
  | 'check'
  | 'x'
  | 'redirect'
  | 'plus'
  | 'cmd'
  | 'send'
  | 'attach'
  | 'chevron'
  | 'chevron-down'
  | 'pin'
  | 'file'
  | 'logs'
  | 'memory'
  | 'context'
  | 'expand'
  | 'more'
  | 'branch';

interface Props {
  name: IconName;
  size?: number;
  color?: string;
  stroke?: number;
  style?: CSSProperties;
}

export function Icon({
  name,
  size = 14,
  color = 'currentColor',
  stroke = 1.6,
  style,
}: Props) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: color,
    strokeWidth: stroke,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style,
  };
  switch (name) {
    case 'director':
      return (
        <svg {...common}>
          <path d="M8 1.5l5.5 3.2v6.6L8 14.5 2.5 11.3V4.7L8 1.5z" />
          <path d="M8 5.5v5M5.5 7v2M10.5 7v2" />
        </svg>
      );
    case 'agents':
      return (
        <svg {...common}>
          <circle cx="5" cy="5" r="2" />
          <circle cx="11" cy="5" r="2" />
          <circle cx="8" cy="11" r="2" />
          <path d="M5 7l3 2M11 7l-3 2" />
        </svg>
      );
    case 'templates':
      return (
        <svg {...common}>
          <rect x="2" y="2" width="5" height="5" rx="1" />
          <rect x="9" y="2" width="5" height="5" rx="1" />
          <rect x="2" y="9" width="5" height="5" rx="1" />
          <rect x="9" y="9" width="5" height="5" rx="1" />
        </svg>
      );
    case 'history':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M8 4.5V8l2.5 1.5" />
        </svg>
      );
    case 'tools':
      return (
        <svg {...common}>
          <path d="M10.5 2L13.5 5L10 8.5L7 5.5L10.5 2z" />
          <path d="M7 5.5l-5 5v3h3l5-5" />
        </svg>
      );
    case 'cost':
      return (
        <svg {...common}>
          <path d="M8 2v12M11 5c0-1.5-1.3-2-3-2s-3 .5-3 2 1.5 2 3 2 3 .5 3 2-1.3 2-3 2-3-.5-3-2" />
        </svg>
      );
    case 'settings':
      return (
        <svg {...common}>
          <path d="M2 4h12M2 8h12M2 12h12" />
          <circle cx="5" cy="4" r="1.5" fill="var(--bg)" />
          <circle cx="10" cy="8" r="1.5" fill="var(--bg)" />
          <circle cx="7" cy="12" r="1.5" fill="var(--bg)" />
        </svg>
      );
    case 'play':
      return (
        <svg {...common}>
          <path d="M4 2.5v11l9-5.5-9-5.5z" fill={color} />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common}>
          <rect x="4" y="3" width="3" height="10" />
          <rect x="9" y="3" width="3" height="10" />
        </svg>
      );
    case 'stop':
      return (
        <svg {...common}>
          <rect x="3.5" y="3.5" width="9" height="9" rx="1" />
        </svg>
      );
    case 'fork':
      return (
        <svg {...common}>
          <circle cx="4" cy="3.5" r="1.5" />
          <circle cx="12" cy="3.5" r="1.5" />
          <circle cx="8" cy="12.5" r="1.5" />
          <path d="M4 5v3a2 2 0 002 2h4a2 2 0 002-2V5" />
          <path d="M8 10v1" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M3 8.5L6.5 12L13 4.5" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" />
        </svg>
      );
    case 'redirect':
      return (
        <svg {...common}>
          <path d="M2 5h8a4 4 0 014 4v3M10 2l-3 3 3 3" />
        </svg>
      );
    case 'plus':
      return (
        <svg {...common}>
          <path d="M8 2v12M2 8h12" />
        </svg>
      );
    case 'cmd':
      return (
        <svg {...common}>
          <path d="M5 5h6v6H5z" />
          <path d="M5 5V3.5a1.5 1.5 0 10-1.5 1.5H5zM11 5V3.5a1.5 1.5 0 111.5 1.5H11zM5 11v1.5a1.5 1.5 0 11-1.5-1.5H5zM11 11v1.5a1.5 1.5 0 101.5-1.5H11z" />
        </svg>
      );
    case 'send':
      return (
        <svg {...common}>
          <path d="M2 8L14 2L10 14L8 9L2 8z" fill={color} stroke="none" />
        </svg>
      );
    case 'attach':
      return (
        <svg {...common}>
          <path d="M10 4L5 9a2 2 0 102.8 2.8l5-5a3.5 3.5 0 00-5-5L3 6.5" />
        </svg>
      );
    case 'chevron':
      return (
        <svg {...common}>
          <path d="M6 4l4 4-4 4" />
        </svg>
      );
    case 'chevron-down':
      return (
        <svg {...common}>
          <path d="M4 6l4 4 4-4" />
        </svg>
      );
    case 'pin':
      return (
        <svg {...common}>
          <path
            d="M8 1.5l2 3.5h2l-3 3 1 5L8 11l-2 2 1-5-3-3h2l2-3.5z"
            fill={color}
            stroke="none"
          />
        </svg>
      );
    case 'file':
      return (
        <svg {...common}>
          <path d="M4 2h5l3 3v9H4z" />
          <path d="M9 2v3h3" />
        </svg>
      );
    case 'logs':
      return (
        <svg {...common}>
          <path d="M3 4h10M3 8h10M3 12h7" />
        </svg>
      );
    case 'memory':
      return (
        <svg {...common}>
          <rect x="2.5" y="3.5" width="11" height="9" rx="1" />
          <path d="M5 6h6M5 8h6M5 10h4" />
        </svg>
      );
    case 'context':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="6" />
          <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" />
        </svg>
      );
    case 'expand':
      return (
        <svg {...common}>
          <path d="M3 6V3h3M13 6V3h-3M3 10v3h3M13 10v3h-3" />
        </svg>
      );
    case 'more':
      return (
        <svg {...common}>
          <circle cx="3.5" cy="8" r="1" fill={color} />
          <circle cx="8" cy="8" r="1" fill={color} />
          <circle cx="12.5" cy="8" r="1" fill={color} />
        </svg>
      );
    case 'branch':
      return (
        <svg {...common}>
          <path d="M4 2v12M4 6c0 2 2 2 4 2s4 0 4 4M12 4v0M12 4l-1.5-1.5M12 4l1.5-1.5" />
        </svg>
      );
  }
}
