import {
  loadBundles,
  listBundleSkills,
  readSkillContent,
} from './marketplace';
import { MARKETPLACE_DEFAULT_SOURCE_ID } from '../shared/ipc';
import type { SkillAuditReport, SkillAuditFinding } from '../shared/types';

/**
 * P7 — static security audit for a marketplace source. Runs after a
 * new source is added + synced; walks every SKILL.md in every bundle,
 * pattern-matches for content that could be risky when an agent
 * follows the skill's instructions, and returns one report per
 * skill with the findings.
 *
 * Not a sandbox — the runner doesn't refuse to load anything based
 * on these findings. The audit is informational so the user can
 * decide whether to keep the source subscribed before agent runs
 * start consuming its skills. Default source (alirezarezvani) skips
 * the audit entirely; it's the vetted seed.
 *
 * Patterns are intentionally simple substring/regex checks. False
 * positives are accepted as the price of "no false negatives" —
 * the user reviews findings in a modal; the cost of a spurious
 * yellow badge is a moment of confusion, the cost of a missed
 * exfil pattern is much higher.
 */

interface PatternDef {
  /** Stable id used by the renderer for keys + future per-pattern dismiss. */
  id: string;
  severity: SkillAuditFinding['severity'];
  /** Human-readable category surfaced in the modal. */
  category: SkillAuditFinding['category'];
  /** Regex run line-by-line against SKILL.md content. */
  test: RegExp;
  /** One-line explanation shown alongside the snippet. */
  reason: string;
}

const PATTERNS: ReadonlyArray<PatternDef> = [
  // ─────────────── Network — high severity ───────────────
  // curl/wget shelling out to fetch arbitrary URLs. A skill that
  // instructs the agent to download + run something from the
  // internet is the highest-confidence supply-chain risk.
  {
    id: 'net-curl',
    severity: 'red',
    category: 'network',
    test: /\b(?:curl|wget)\b/i,
    reason: 'curl/wget shells out to fetch arbitrary URLs.',
  },
  {
    id: 'net-fetch',
    severity: 'yellow',
    category: 'network',
    test: /\b(?:fetch|requests\.|urllib\.|http\.client|axios)\b/,
    reason: 'Network-fetch API call — verify the destination URL.',
  },
  {
    id: 'net-exfil',
    severity: 'red',
    category: 'network',
    test: /\b(?:pastebin\.com|transfer\.sh|ngrok|requestbin|webhook\.site|beeceptor|sendgrid)\b/i,
    reason: 'Reference to a known data-exfil / paste / webhook service.',
  },
  // ─────────────── Credential stores — high severity ─────
  // Anything reaching into the user's credential storage is suspect
  // unless the skill is genuinely about credential management.
  {
    id: 'cred-gh-auth',
    severity: 'red',
    category: 'credentials',
    test: /\bgh\s+auth\s+(token|status|login)\b/i,
    reason: 'Reads GitHub CLI credentials.',
  },
  {
    id: 'cred-aws',
    severity: 'red',
    category: 'credentials',
    test: /\baws\s+configure\b|\.aws\/credentials\b|AWS_(?:SECRET_ACCESS|ACCESS_KEY)_KEY/i,
    reason: 'Touches AWS credentials.',
  },
  {
    id: 'cred-keychain',
    severity: 'red',
    category: 'credentials',
    test: /\bsecurity\s+find-(?:generic|internet)-password\b|\bkeychain\b|\bkwallet\b|\bsecret-tool\b/i,
    reason: 'Reads OS credential store (keychain/kwallet/libsecret).',
  },
  {
    id: 'cred-password-manager',
    severity: 'red',
    category: 'credentials',
    test: /\bop\s+(?:read|item|signin)\b|\bpass\s+show\b|\bbw\s+(?:get|unlock)\b/i,
    reason: '1Password / pass / Bitwarden credential read.',
  },
  {
    id: 'cred-env',
    severity: 'yellow',
    category: 'credentials',
    test: /\$\{?(?:GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET|GH_TOKEN)\b|process\.env\.(?:GITHUB_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|AWS_SECRET|GH_TOKEN)/,
    reason: 'References a sensitive environment variable.',
  },
  // ─────────────── FS-escape — medium severity ───────────
  // Paths that go outside the project workspace. The runner pins
  // tool calls to the workspace, but a skill that *instructs* the
  // agent to e.g. read ~/.ssh/id_rsa is a documented escape attempt
  // even if the tool layer blocks it.
  {
    id: 'fs-home',
    severity: 'yellow',
    category: 'fs-escape',
    test: /(?:~\/|\$HOME\/|%USERPROFILE%|%HOMEPATH%|%APPDATA%|\bC:\\Users\\|\/home\/[a-z]+\/|\/Users\/[a-z]+\/)/i,
    reason: 'Path outside the workspace (home / appdata / user dir).',
  },
  {
    id: 'fs-tmp',
    severity: 'yellow',
    category: 'fs-escape',
    test: /(?:\/tmp\/|\/var\/|%TEMP%|%TMP%)/i,
    reason: 'Path under a system temp / runtime dir.',
  },
  {
    id: 'fs-ssh',
    severity: 'red',
    category: 'fs-escape',
    test: /\.ssh\/(?:id_rsa|id_ed25519|known_hosts|authorized_keys|config)\b/,
    reason: 'References SSH key / config files.',
  },
  // ─────────────── Eval / exec — medium severity ─────────
  // Shell commands inside the SKILL.md body run when the agent
  // copies them verbatim. eval/exec invocations specifically.
  {
    id: 'eval-shell',
    severity: 'yellow',
    category: 'eval',
    test: /\b(?:eval|exec)\s*[`(]|\bbash\s+-c\b|\bsh\s+-c\b|\$\(/,
    reason: 'eval/exec or inline shell invocation.',
  },
  {
    id: 'eval-pipe-shell',
    severity: 'red',
    category: 'eval',
    test: /\|\s*(?:sh|bash|zsh|fish)\b|\|\s*python\s*-c\b/,
    reason: 'Pipes content directly into a shell / interpreter.',
  },
];

/**
 * Audit every skill in a source. Returns one report per skill
 * (only skills that have findings show up — clean skills are
 * inferred from the bundle count vs report count if the renderer
 * wants a "N audited, M clean" summary).
 *
 * Default source returns an empty array — the vetted seed skips
 * the audit entirely. Any other source gets the full walk.
 */
export function auditSource(sourceId: string): SkillAuditReport[] {
  if (sourceId === MARKETPLACE_DEFAULT_SOURCE_ID) return [];
  const reports: SkillAuditReport[] = [];
  const bundles = loadBundles(sourceId);
  for (const bundle of bundles) {
    const skills = listBundleSkills(sourceId, bundle.id);
    for (const sk of skills) {
      const content = readSkillContent(sourceId, bundle.id, sk.id);
      if (!content) continue;
      const findings = scanContent(content);
      if (findings.length === 0) continue;
      reports.push({
        sourceId,
        bundleId: bundle.id,
        skillId: sk.id,
        skillName: sk.name ?? sk.id,
        worstSeverity: worstOf(findings),
        findings,
      });
    }
  }
  // Sort red first so the modal opens with the scariest skills at
  // the top — easier to triage when the source has a mix.
  reports.sort((a, b) => severityRank(b.worstSeverity) - severityRank(a.worstSeverity));
  return reports;
}

function scanContent(content: string): SkillAuditFinding[] {
  const out: SkillAuditFinding[] = [];
  const lines = content.split(/\r?\n/);
  // Per-pattern dedupe: a skill that mentions \`curl\` ten times shows
  // up as ONE finding with a single representative snippet, not ten.
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const pat of PATTERNS) {
      if (seen.has(pat.id)) continue;
      if (!pat.test.test(line)) continue;
      seen.add(pat.id);
      out.push({
        patternId: pat.id,
        category: pat.category,
        severity: pat.severity,
        reason: pat.reason,
        snippet: line.trim().slice(0, 200),
        lineNumber: i + 1,
      });
    }
  }
  return out;
}

function worstOf(findings: SkillAuditFinding[]): SkillAuditFinding['severity'] {
  let worst: SkillAuditFinding['severity'] = 'green';
  for (const f of findings) {
    if (severityRank(f.severity) > severityRank(worst)) worst = f.severity;
  }
  return worst;
}

function severityRank(s: SkillAuditFinding['severity']): number {
  return s === 'red' ? 2 : s === 'yellow' ? 1 : 0;
}
