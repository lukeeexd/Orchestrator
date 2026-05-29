import type { SlashCommand } from './commands';

/**
 * Slash commands the renderer handles directly without sending anything
 * to an agent — they map to existing app actions (rail navigation,
 * wipe-director, open external usage page, etc). The runtime intercepts
 * these before any prompt is sent.
 */
export type BuiltinAction =
  | 'wipe-director'
  | 'open-usage'
  | 'go-agents'
  | 'go-history'
  | 'go-settings'
  | 'go-tools'
  | 'go-templates'
  | 'go-marketplace'
  | 'go-docs'
  | 'show-help';

export interface BuiltinCommand extends SlashCommand {
  scope: 'builtin';
  action: BuiltinAction;
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  {
    name: 'clear',
    description: 'Wipe Director chat and session memory for this project.',
    body: '',
    scope: 'builtin',
    action: 'wipe-director',
  },
  {
    name: 'usage',
    description: 'Open Anthropic’s official usage page in your browser.',
    body: '',
    scope: 'builtin',
    action: 'open-usage',
  },
  {
    name: 'agents',
    description: 'Switch to the Agents rail.',
    body: '',
    scope: 'builtin',
    action: 'go-agents',
  },
  {
    name: 'history',
    description: 'Switch to the History/Runs rail.',
    body: '',
    scope: 'builtin',
    action: 'go-history',
  },
  {
    name: 'settings',
    description: 'Switch to Settings.',
    body: '',
    scope: 'builtin',
    action: 'go-settings',
  },
  {
    name: 'tools',
    description: 'Switch to the per-role tool allow-lists.',
    body: '',
    scope: 'builtin',
    action: 'go-tools',
  },
  {
    name: 'templates',
    description: 'Switch to Templates (saved fleets).',
    body: '',
    scope: 'builtin',
    action: 'go-templates',
  },
  {
    name: 'marketplace',
    description: 'Switch to the skill Marketplace.',
    body: '',
    scope: 'builtin',
    action: 'go-marketplace',
  },
  {
    name: 'docs',
    description: 'Switch to the Docs viewer.',
    body: '',
    scope: 'builtin',
    action: 'go-docs',
  },
  {
    name: 'help',
    description: 'Show this list of slash commands.',
    body: '',
    scope: 'builtin',
    action: 'show-help',
  },
];
