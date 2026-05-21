import { useState } from 'react';
import type { McpScaffoldResult } from '../../shared/ipc';
import { Modal } from './Modal';

interface Props {
  projectId: string;
  onCancel: () => void;
  onDone: () => void;
}

/**
 * P9 — MCP server scaffold wizard. Walks the user through picking a
 * language + capabilities + name, then asks the main side to write
 * a minimal-but-runnable skeleton under
 * `<workspace>/.mcp-servers/<name>` and patch the project's
 * mcpConfig to register it in stdio mode.
 *
 * Single-page modal (no multi-step), keeps everything visible. After
 * submit, surfaces either the destination + file list (success) or
 * the error text (failure) and the user dismisses.
 */
export function McpScaffoldWizard({ projectId, onCancel, onDone }: Props) {
  const [language, setLanguage] = useState<'typescript' | 'python'>(
    'typescript',
  );
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [tools, setTools] = useState(true);
  const [resources, setResources] = useState(false);
  const [prompts, setPrompts] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<McpScaffoldResult | null>(null);

  const validate = (): string | null => {
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name)) {
      return 'Name must be lowercase letters / digits / dashes, 2-40 chars (starts with a letter or digit).';
    }
    if (!tools && !resources && !prompts) {
      return 'Pick at least one capability — tools, resources, or prompts.';
    }
    return null;
  };

  const submit = async () => {
    const err = validate();
    if (err) {
      setResult({ ok: false, error: err });
      return;
    }
    setBusy(true);
    setResult(null);
    try {
      const res = await window.api.scaffoldMcpServer({
        projectId,
        language,
        name: name.trim(),
        description: description.trim(),
        capabilities: { tools, resources, prompts },
      });
      setResult(res);
    } finally {
      setBusy(false);
    }
  };

  // Success state: show what was written + a Done button.
  if (result?.ok) {
    return (
      <Modal
        title={<b>MCP server scaffolded</b>}
        onClose={onDone}
        maxWidth={560}
        footer={
          <button className="tb-btn primary" onClick={onDone}>
            Done
          </button>
        }
      >
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
          Wrote a {language === 'typescript' ? 'TypeScript' : 'Python'}{' '}
          MCP server skeleton + registered it in this project&apos;s
          mcpConfig.
        </div>
        <div className="field">
          <span className="lbl">Path</span>
          <span className="v">
            <code style={{ fontSize: 11 }}>{result.destination}</code>
          </span>
        </div>
        <div className="field">
          <span className="lbl">Files</span>
          <span className="v">
            <ul
              style={{
                margin: 0,
                padding: '4px 0 0 16px',
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
              }}
            >
              {result.filesWritten?.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </span>
        </div>
        <div
          style={{
            fontSize: 11,
            color: 'var(--muted)',
            marginTop: 10,
            fontStyle: 'italic',
          }}
        >
          {language === 'typescript'
            ? 'Next: run `npm install` + `npm run build` in the new directory. Agents will pick up the server on their next spawn.'
            : 'Next: install the `mcp` package in the new directory (e.g. `pip install -e .`). Agents will pick up the server on their next spawn.'}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      title={<b>Scaffold MCP server</b>}
      onClose={busy ? undefined : onCancel}
      maxWidth={520}
      footer={
        <>
          <button className="tb-btn" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className="tb-btn primary"
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0}
          >
            {busy ? 'Scaffolding…' : 'Scaffold'}
          </button>
        </>
      }
    >
      <div className="field">
        <span className="lbl">Language</span>
        <span className="v" style={{ display: 'flex', gap: 6 }}>
          {(['typescript', 'python'] as const).map((lang) => (
            <button
              key={lang}
              className={'tb-btn' + (language === lang ? ' primary' : '')}
              onClick={() => setLanguage(lang)}
              disabled={busy}
              style={{ height: 24 }}
            >
              {lang === 'typescript' ? 'TypeScript' : 'Python'}
            </button>
          ))}
        </span>
      </div>

      <div className="field">
        <span className="lbl">Name</span>
        <span className="v">
          <input
            className="text-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. weather-api"
            style={{ width: '100%' }}
            autoFocus
          />
        </span>
      </div>

      <div className="field">
        <span className="lbl">Description</span>
        <span className="v">
          <input
            className="text-input"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="One-line summary (optional)"
            style={{ width: '100%' }}
          />
        </span>
      </div>

      <div className="field">
        <span className="lbl">Capabilities</span>
        <span
          className="v"
          style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
        >
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={tools}
              onChange={(e) => setTools(e.target.checked)}
            />
            <span>
              <strong>tools</strong> — functions the agent can call (most
              common; default on)
            </span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={resources}
              onChange={(e) => setResources(e.target.checked)}
            />
            <span>
              <strong>resources</strong> — read-only data the agent can pull
              by URI
            </span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <input
              type="checkbox"
              checked={prompts}
              onChange={(e) => setPrompts(e.target.checked)}
            />
            <span>
              <strong>prompts</strong> — parameterised templates the agent
              can request
            </span>
          </label>
        </span>
      </div>

      <div className="field">
        <span className="lbl">Destination</span>
        <span className="v" style={{ color: 'var(--text-2)', fontSize: 11 }}>
          <code>
            {`<workspace>/.mcp-servers/${name || '<name>'}`}
          </code>
        </span>
      </div>

      {result && !result.ok && (
        <div className="form-error" style={{ marginTop: 8 }}>
          {result.error}
        </div>
      )}
    </Modal>
  );
}
