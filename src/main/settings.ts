import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { Settings } from '../shared/ipc';
import { DEFAULT_EFFORT, isEffortLevel } from '../shared/efforts';

const DEFAULTS: Settings = {
  apiKey: '',
  oauthToken: '',
  // Agents default to a cheaper model + standard effort so plan-spawned
  // workers don't run up large bills unless the user explicitly picks
  // something bigger.
  defaultModel: 'claude-sonnet-4-6',
  defaultEffort: DEFAULT_EFFORT,
  // The Director benefits from deeper reasoning + bigger context (it has
  // to keep the whole fleet, prior conversation, and plan in its head),
  // so the global default is Opus 4.7 with the 1M context beta and xhigh
  // effort. Agents stay on the cheaper Sonnet path above.
  defaultDirectorModel: 'claude-opus-4-7-1m',
  defaultDirectorEffort: 'xhigh',
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

export function settingsFilePath(): string {
  return pathFor();
}

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

    // One-time migration: the v1.0 defaults were ($1 / 100k / 600s) and
    // surprised users who'd never set a budget. If we see all three at
    // exactly those values, assume they're untouched legacy defaults and
    // flip to unlimited. Writes back so the migration runs once.
    if (
      parsed.defaultBudgetUsd === 1.0 &&
      parsed.defaultBudgetTokens === 100_000 &&
      parsed.defaultBudgetSeconds === 600
    ) {
      parsed.defaultBudgetUsd = 0;
      parsed.defaultBudgetTokens = 0;
      parsed.defaultBudgetSeconds = 0;
      const merged: Settings = { ...DEFAULTS, ...parsed };
      fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
      cached = merged;
      return cached;
    }

    const merged: Settings = { ...DEFAULTS, ...parsed };
    // Guard against a hand-edited or older settings.json with an invalid
    // effort string. Fall back to the defaults instead of pushing a bad
    // value through to the SDK.
    if (!isEffortLevel(merged.defaultEffort)) {
      merged.defaultEffort = DEFAULTS.defaultEffort;
    }
    if (!isEffortLevel(merged.defaultDirectorEffort)) {
      merged.defaultDirectorEffort = DEFAULTS.defaultDirectorEffort;
    }
    cached = merged;
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
