import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { Settings } from '../shared/ipc';

const DEFAULTS: Settings = {
  apiKey: '',
  oauthToken: '',
  defaultModel: 'claude-sonnet-4-6',
  // Budgets default to 0 (unlimited). Caps are opt-in — set a non-zero
  // value here (or per spawn) to enforce one. The old $1 / 100k / 600s
  // safety belts were too restrictive (a single Opus 4.7 turn easily
  // exceeds $1) and surprised users who thought "no limit set" meant
  // unlimited.
  defaultBudgetUsd: 0,
  defaultBudgetTokens: 0,
  defaultBudgetSeconds: 0,
};

let cached: Settings | null = null;
let settingsPath: string | null = null;

function pathFor(): string {
  if (!settingsPath) {
    settingsPath = path.join(app.getPath('userData'), 'settings.json');
  }
  return settingsPath;
}

export function readSettings(): Settings {
  if (cached) return cached;
  const p = pathFor();
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw) as Partial<Settings>;
    cached = { ...DEFAULTS, ...parsed };
  } catch {
    cached = { ...DEFAULTS };
  }
  return cached;
}

export function writeSettings(next: Partial<Settings>): Settings {
  const merged: Settings = { ...readSettings(), ...next };
  const p = pathFor();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
  cached = merged;
  return merged;
}
