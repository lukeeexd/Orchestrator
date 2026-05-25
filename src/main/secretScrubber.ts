/**
 * Shared secret-masking pass used by F9 crash bundles and F11
 * run-bundle exports. Pattern list intentionally biased toward
 * false-positive redaction over false-negative leakage — the cost
 * of a spurious `[REDACTED:...]` in a stack trace is much smaller
 * than the cost of a leaked token in a public bug report.
 *
 * Centralised here so the F9 and F11 export paths share a single
 * pattern set; adding a new pattern lights up in both.
 */

interface SecretPattern {
  re: RegExp;
  label: string;
}

const SECRET_PATTERNS: ReadonlyArray<SecretPattern> = [
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, label: 'anthropic' },
  { re: /sk-[A-Za-z0-9]{32,}/g, label: 'api-key' },
  { re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, label: 'github' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, label: 'aws-key' },
  { re: /\bxox[abpr]-[A-Za-z0-9-]{10,}\b/g, label: 'slack' },
  {
    re: /\bbearer\s+eyJ[A-Za-z0-9_=-]+\.[A-Za-z0-9_=-]+\.[A-Za-z0-9_.+/=-]*/gi,
    label: 'jwt',
  },
  // Env-style assignment: VAR_NAME=long-base64-ish value (matches
  // OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN, etc.)
  {
    re: /\b([A-Z][A-Z0-9_]{4,})\s*[:=]\s*["']?([A-Za-z0-9_.+/=-]{24,})["']?/g,
    label: 'env',
  },
];

export function scrubSecrets(s: string): string {
  let out = s;
  for (const { re, label } of SECRET_PATTERNS) {
    out = out.replace(re, (_match, name) => {
      if (label === 'env' && typeof name === 'string') {
        return `${name}=[REDACTED:${label}]`;
      }
      return `[REDACTED:${label}]`;
    });
  }
  return out;
}
