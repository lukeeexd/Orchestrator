import { useEffect, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';
import type {
  AgentRole,
  EffortLevel,
  Provider,
} from '../../shared/types';
import { AGENT_ROLE_ORDER, ROLES as ROLE_DEFS } from '../../shared/roles';
import { Icon } from './Icon';
import { Modal } from './Modal';
import { AttachmentThumb } from './AttachmentThumb';
import { ModelPicker } from './ModelPicker';
import { EffortPicker } from './EffortPicker';
import {
  handleAttachmentDrop,
  handleAttachmentPaste,
} from '../lib/attachmentDataTransfer';

// Derived from the shared roles table so a role rename or tint
// change lands in one place. Previously the file shadowed the
// shared ROLES with its own array — same data but a separate
// source of truth that could drift (and did, briefly, when the
// security role was added).
const ROLES: { id: AgentRole; label: string; tint: string }[] =
  AGENT_ROLE_ORDER.map((id) => ({
    id,
    label: ROLE_DEFS[id].label,
    tint: ROLE_DEFS[id].tint,
  }));

interface Props {
  onCancel: () => void;
  onSpawned: () => void;
  /** Pre-fill the workspace input from the active project's workspace. */
  defaultWorkspace: string;
  /** Pre-fill the model from the project's Director model. */
  defaultModel: string;
  /** Pre-fill the effort from the project's Director effort. */
  defaultEffort: EffortLevel;
  projectId: string;
  provider: Provider;
}

/**
 * P17 — security-role preset. One-click dependency audit task that
 * detects every supported manifest type, runs the matching audit
 * tool, cross-references CVEs, and writes SECURITY_AUDIT.md at the
 * workspace root. The agent is asked NOT to modify dependency files
 * (no \`npm audit fix\`) — the user wants the report first.
 *
 * Kept as a verbatim string so users can also inspect it / edit it
 * after clicking the preset; the agent then sees whatever the user
 * leaves in the textarea, not the canonical version.
 */
const DEPENDENCY_AUDIT_PRESET =
  `Run a dependency audit on this workspace.\n` +
  `\n` +
  `Steps:\n` +
  `1. Detect package manifests at the workspace root:\n` +
  `   - npm:    package.json (+ package-lock.json or yarn.lock)\n` +
  `   - python: requirements.txt, pyproject.toml, Pipfile.lock, poetry.lock\n` +
  `   - rust:   Cargo.toml (+ Cargo.lock)\n` +
  `   - go:     go.mod (+ go.sum)\n` +
  `   Skip manifests that aren't present. If multiple ecosystems are\n` +
  `   in the same repo, audit each in turn and report them together.\n` +
  `\n` +
  `2. For each detected manifest, run the appropriate audit:\n` +
  `   - npm:    \`npm audit --json\` (parse JSON for vulnerabilities)\n` +
  `   - python: \`pip-audit -f json\` if available; otherwise note\n` +
  `             "pip-audit not installed" and fall back to listing\n` +
  `             direct dependencies + versions.\n` +
  `   - rust:   \`cargo audit --json\` if cargo-audit is installed.\n` +
  `   - go:     \`govulncheck ./...\` if govulncheck is installed.\n` +
  `\n` +
  `3. For each reported CVE, cross-reference the GitHub Advisory\n` +
  `   Database via WebFetch where possible — fill in fixed-in\n` +
  `   versions + severity if the local tool didn't include them.\n` +
  `\n` +
  `4. Write findings to SECURITY_AUDIT.md at the workspace root:\n` +
  `   - Header: date, manifests audited, tools used.\n` +
  `   - Per-vuln table: package · current version · CVE · severity ·\n` +
  `     fix version · advisory link.\n` +
  `   - Triage section: ranked recommendations (upgrade now vs.\n` +
  `     monitor) with one-line reasoning per item.\n` +
  `\n` +
  `Do NOT modify dependency files. Do NOT run \`npm audit fix\` or\n` +
  `equivalent — the user wants the report; the fixes come later.\n` +
  `\n` +
  `Output your final message as a one-line summary like "3 critical,\n` +
  `5 high, 12 medium across npm + python — full report in\n` +
  `SECURITY_AUDIT.md".`;

interface AttachmentChip {
  path: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export function SpawnAgentForm({
  onCancel,
  onSpawned,
  defaultWorkspace,
  defaultModel,
  defaultEffort,
  projectId,
  provider,
}: Props) {
  const [role, setRole] = useState<AgentRole>('coder');
  // P10: optional qa flavour. Hidden until role === 'qa'. Reset to
  // 'default' on role change so a stale Playwright selection doesn't
  // leak to a non-qa role.
  const [qaFlavour, setQaFlavour] = useState<'default' | 'playwright'>(
    'default',
  );
  const [workspace, setWorkspace] = useState(defaultWorkspace);
  // Provider starts at the project's default; user can flip for one
  // spawn without changing the project itself. When the provider
  // changes mid-form we blank the model so the runner cascades to the
  // new provider's default (the existing model id won't validate
  // against the new provider).
  const [agentProvider, setAgentProvider] = useState<Provider>(provider);
  const [model, setModel] = useState(defaultModel);
  const [effort, setEffort] = useState<EffortLevel>(defaultEffort);
  const [task, setTask] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [budgetUsd, setBudgetUsd] = useState('');
  const [budgetTokens, setBudgetTokens] = useState('');
  const [budgetSeconds, setBudgetSeconds] = useState('');
  const [attachments, setAttachments] = useState<AttachmentChip[]>([]);
  const [defaults, setDefaults] = useState<{
    usd: number;
    tokens: number;
    seconds: number;
  } | null>(null);

  useEffect(() => {
    window.api.getSettings().then((s) => {
      setDefaults({
        usd: s.defaultBudgetUsd,
        tokens: s.defaultBudgetTokens,
        seconds: s.defaultBudgetSeconds,
      });
    });
  }, []);

  const pickWorkspace = async () => {
    const { path } = await window.api.pickWorkspace();
    if (path) setWorkspace(path);
  };

  const pickAttachments = async () => {
    const { attachments: picked } = await window.api.pickAttachments();
    if (picked.length > 0) {
      setAttachments((prev) => [...prev, ...picked]);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
    // Fire-and-forget cleanup. Main-side gate ensures only ephemeral
    // paste-temp files are deleted; picked attachments outside our
    // managed dir are silently ignored.
    if (path) void window.api.disposeAttachment(path);
  };

  const parseNum = (raw: string): number | undefined => {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n < 0) return undefined;
    return n;
  };

  const submit = async () => {
    setError(null);
    if (!workspace.trim()) {
      setError('Pick a workspace folder.');
      return;
    }
    if (!task.trim()) {
      setError('Describe the task.');
      return;
    }
    setBusy(true);
    try {
      const budget = {
        usd: parseNum(budgetUsd),
        tokens: parseNum(budgetTokens),
        seconds: parseNum(budgetSeconds),
      };
      const hasBudget =
        budget.usd != null || budget.tokens != null || budget.seconds != null;
      const okAttachments = attachments.filter((a) => a.ok).map((a) => a.path);
      await window.api.spawnAgent({
        projectId,
        role,
        workspace,
        task,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(agentProvider !== provider ? { provider: agentProvider } : {}),
        ...(hasBudget ? { budget } : {}),
        ...(okAttachments.length > 0 ? { attachments: okAttachments } : {}),
        ...(role === 'qa' && qaFlavour === 'playwright'
          ? { subtype: 'playwright' as const }
          : {}),
      });
      onSpawned();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={<b>Spawn agent</b>}
      onClose={busy ? undefined : onCancel}
      footer={
        <>
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={submit}
            disabled={busy}
          >
            <Icon name="play" size={11} /> Spawn
          </button>
        </>
      }
    >
          <div className="field">
            <span className="lbl">Role</span>
            <div className="role-picker">
              {ROLES.map((r) => (
                <button
                  key={r.id}
                  className={'role-chip' + (role === r.id ? ' on' : '')}
                  onClick={() => {
                    setRole(r.id);
                    // P10: reset flavour whenever the role changes —
                    // a Playwright pick only makes sense under qa.
                    if (r.id !== 'qa') setQaFlavour('default');
                  }}
                  style={{ borderColor: role === r.id ? r.tint : undefined }}
                  aria-pressed={role === r.id}
                >
                  <span
                    className="role-tint"
                    style={{ background: r.tint }}
                    aria-hidden="true"
                  />
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {role === 'qa' && (
            <div className="field">
              <span className="lbl">Flavour</span>
              <select
                className="text-input"
                value={qaFlavour}
                onChange={(e) =>
                  setQaFlavour(e.target.value as 'default' | 'playwright')
                }
              >
                <option value="default">Default — run any test runner</option>
                <option value="playwright">
                  Playwright — e2e/browser tests, emits a Tests: N/M KPI
                </option>
              </select>
            </div>
          )}

          <div className="field">
            <span className="lbl">Workspace folder</span>
            <div className="workspace-row">
              <input
                className="text-input"
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                placeholder="C:\path\to\your\repo"
              />
              <button className="tb-btn" onClick={pickWorkspace}>
                Browse…
              </button>
            </div>
          </div>

          <div className="field">
            <span className="lbl">
              Provider · project default is {provider}
            </span>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['claude', 'codex'] as const).map((p) => (
                <button
                  key={p}
                  className={
                    'tb-btn' + (agentProvider === p ? ' primary' : '')
                  }
                  onClick={() => {
                    if (agentProvider === p) return;
                    setAgentProvider(p);
                    // Switching providers invalidates the current model
                    // pick — let the runner cascade to the new
                    // provider's default rather than forcing the user
                    // to re-select.
                    setModel('');
                  }}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div className="field">
            <span className="lbl">Model</span>
            <ModelPicker
              value={model}
              onChange={setModel}
              provider={agentProvider}
            />
          </div>

          {agentProvider === 'claude' && (
            <div className="field">
              <span className="lbl">Reasoning effort</span>
              <EffortPicker value={effort} onChange={setEffort} />
            </div>
          )}

          {role === 'security' && (
            <div className="field">
              <span className="lbl">Presets</span>
              <span className="v" style={{ display: 'flex', gap: 6 }}>
                <button
                  className="tb-btn"
                  onClick={() => setTask(DEPENDENCY_AUDIT_PRESET)}
                  disabled={busy}
                  title="Fill the task field with a comprehensive dependency-audit prompt (npm/pip/cargo/go → SECURITY_AUDIT.md). You can edit before spawning."
                  style={{ height: 22 }}
                >
                  Dependency audit
                </button>
              </span>
            </div>
          )}

          <div className="field">
            <span className="lbl">Task</span>
            <textarea
              className="text-input task-input"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              onPaste={(e: ClipboardEvent<HTMLTextAreaElement>) => {
                void handleAttachmentPaste(e, (info) =>
                  setAttachments((prev) => [...prev, info]),
                );
              }}
              onDragOver={(e: DragEvent<HTMLTextAreaElement>) =>
                e.preventDefault()
              }
              onDrop={(e: DragEvent<HTMLTextAreaElement>) => {
                void handleAttachmentDrop(e, (info) =>
                  setAttachments((prev) => [...prev, info]),
                );
              }}
              placeholder="Describe what you want the agent to do… (paste or drop files to attach)"
              rows={6}
            />
          </div>

          <div className="field">
            <span className="lbl">
              Attachments · optional · text / images / PDF · paste, drop, or pick
            </span>
            <div className="att-row" style={{ marginBottom: 4 }}>
              {attachments.map((a) => (
                <span
                  className={'att-chip' + (a.ok ? '' : ' bad')}
                  key={a.path}
                  title={a.reason ?? a.path}
                >
                  <AttachmentThumb path={a.path} />
                  {a.name}
                  <button
                    className="att-x"
                    onClick={() => removeAttachment(a.path)}
                    title="Remove"
                  >
                    ×
                  </button>
                </span>
              ))}
              <button
                className="tb-btn"
                style={{ height: 22 }}
                onClick={pickAttachments}
              >
                <Icon name="attach" size={11} /> Attach files
              </button>
            </div>
          </div>

          <div className="field">
            <span className="lbl">
              Budget caps · optional · leave blank for defaults
            </span>
            <div className="budget-row">
              <label>
                <span className="budget-prefix">$</span>
                <input
                  className="text-input"
                  value={budgetUsd}
                  onChange={(e) => setBudgetUsd(e.target.value)}
                  placeholder={
                    defaults && defaults.usd > 0
                      ? defaults.usd.toFixed(2)
                      : 'no cap'
                  }
                  inputMode="decimal"
                />
              </label>
              <label>
                <input
                  className="text-input"
                  value={budgetTokens}
                  onChange={(e) => setBudgetTokens(e.target.value)}
                  placeholder={
                    defaults && defaults.tokens > 0
                      ? defaults.tokens.toLocaleString()
                      : 'no cap'
                  }
                  inputMode="numeric"
                />
                <span className="budget-suffix">tokens</span>
              </label>
              <label>
                <input
                  className="text-input"
                  value={budgetSeconds}
                  onChange={(e) => setBudgetSeconds(e.target.value)}
                  placeholder={
                    defaults && defaults.seconds > 0
                      ? defaults.seconds.toString()
                      : 'no cap'
                  }
                  inputMode="numeric"
                />
                <span className="budget-suffix">seconds</span>
              </label>
            </div>
          </div>

          {error && <div className="form-error">{error}</div>}
    </Modal>
  );
}
