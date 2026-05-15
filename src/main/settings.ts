import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { Settings } from '../shared/ipc';

const DEFAULTS: Settings = {
  apiKey: '',
  oauthToken: '',
  defaultModel: 'claude-sonnet-4-6',
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
