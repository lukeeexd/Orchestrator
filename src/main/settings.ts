import { app, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { Settings } from '../shared/ipc';
import { DEFAULT_EFFORT, isEffortLevel } from '../shared/efforts';

/**
 * Prefix stamped onto encrypted secret values in settings.json so we
 * can tell encrypted blobs from raw plaintext (legacy / migration
 * fallthrough). Plain strings without this prefix are treated as
 * pre-encryption-era values and migrated on next write.
 */
const ENC_PREFIX = 'enc:v1:';

function encryptSecret(plain: string): string {
  if (!plain) return '';
  if (!safeStorage.isEncryptionAvailable()) {
    // Fall back to plaintext when the OS keychain isn't available
    // (first-launch Linux, headless CI). The DPAPI on Windows is
    // always available, which is the only platform we ship to.
    return plain;
  }
  try {
    return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
  } catch {
    return plain;
  }
}

function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) {
    // Legacy plaintext — migration runs on next write.
    return stored;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    // Encrypted blob with no keystore: nothing we can do. Treat as
    // empty so the next spawn cleanly falls back to auto-discovery.
    return '';
  }
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    return '';
  }
}

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
  // so the global default is Opus 4.8 with the 1M context beta and xhigh
  // effort. Agents stay on the cheaper Sonnet path above.
  defaultDirectorModel: 'claude-opus-4-8-1m',
  defaultDirectorEffort: 'xhigh',
  // Budgets default to 0 (unlimited). Caps are opt-in — set a non-zero
  // value here (or per spawn) to enforce one. The old $1 / 100k / 600s
  // safety belts were too restrictive (a single Opus 4.7 turn easily
  // exceeds $1) and surprised users who thought "no limit set" meant
  // unlimited.
  defaultBudgetUsd: 0,
  defaultBudgetTokens: 0,
  defaultBudgetSeconds: 0,
  // Marketplace "defaults for new projects" knob. Off so the simple
  // global-applies-everywhere model is the default; users who want
  // per-project customization opt in via the Settings checkbox.
  copyGlobalSubsToNewProjects: false,
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

    // M4: decrypt secrets that were written with the safeStorage
    // wrapper. Legacy plaintext flows through unchanged and gets
    // re-encrypted on next write (auto-migration).
    if (typeof parsed.apiKey === 'string') {
      parsed.apiKey = decryptSecret(parsed.apiKey);
    }
    if (typeof parsed.oauthToken === 'string') {
      parsed.oauthToken = decryptSecret(parsed.oauthToken);
    }

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
      // Write through so both the budget migration AND the
      // plaintext→ciphertext secrets migration land on disk.
      writeSettingsToDisk(merged);
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

/**
 * Persist the settings record to disk, encrypting the two secret
 * fields via safeStorage. The in-memory `cached` Settings keeps
 * plaintext (so consumers don't have to decrypt every read); only
 * disk-side bytes are wrapped.
 */
function writeSettingsToDisk(merged: Settings): void {
  const p = pathFor();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const onDisk = {
    ...merged,
    apiKey: encryptSecret(merged.apiKey),
    oauthToken: encryptSecret(merged.oauthToken),
  };
  fs.writeFileSync(p, JSON.stringify(onDisk, null, 2), 'utf8');
}

export function writeSettings(next: Partial<Settings>): Settings {
  const merged: Settings = { ...readSettings(), ...next };
  writeSettingsToDisk(merged);
  cached = merged;
  return merged;
}
