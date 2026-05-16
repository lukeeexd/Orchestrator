import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/ipc';
import { Icon } from './Icon';

const KNOWN_MODELS = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];

export function SettingsScreen() {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [original, setOriginal] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealApi, setRevealApi] = useState(false);
  const [revealOauth, setRevealOauth] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [version, setVersion] = useState<string>('');
  const savedTimer = useRef<number | null>(null);

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setDraft(s);
      setOriginal(s);
    });
    void window.api.ping().then((p) => setVersion(p.version));
    return () => {
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
    };
  }, []);

  if (!draft || !original) {
    return (
      <div className="pane" style={{ flex: 1 }}>
        <div className="pane-head">
          <span className="title">
            <b>Settings</b>
          </span>
        </div>
      </div>
    );
  }

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(original);

  const patch = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const save = async () => {
    setSaving(true);
    try {
      const merged = await window.api.setSettings(draft);
      setOriginal(merged);
      setDraft(merged);
      setSavedFlash(true);
      if (savedTimer.current) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setSavedFlash(false), 2000);
    } finally {
      setSaving(false);
    }
  };

  const revert = () => setDraft(original);

  const parseNum = (raw: string): number => {
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  };

  return (
    <div className="pane settings-pane" style={{ flex: 1 }}>
      <div className="pane-head">
        <span className="title">
          <b>Settings</b>
        </span>
        <span className="spacer" />
        {dirty && (
          <span className="meta" style={{ color: 'var(--waiting)' }}>
            unsaved changes
          </span>
        )}
        {savedFlash && !dirty && (
          <span className="meta" style={{ color: 'var(--accent)' }}>
            saved
          </span>
        )}
      </div>

      <div className="settings-body">
        <section className="settings-section">
          <h3 className="settings-h">Auth</h3>
          <p className="settings-help">
            If both fields are blank, the SDK auto-discovers your Claude
            Code login from <code>~/.claude/</code>. Pro and Team plans
            should leave the API key empty.
          </p>

          <div className="field">
            <span className="lbl">Anthropic API key</span>
            <div className="settings-input-row">
              <input
                className="text-input"
                type={revealApi ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(e) => patch('apiKey', e.target.value)}
                placeholder="sk-ant-…"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="tb-btn"
                onClick={() => setRevealApi((v) => !v)}
                title={revealApi ? 'Hide' : 'Show'}
              >
                {revealApi ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="field">
            <span className="lbl">OAuth token</span>
            <div className="settings-input-row">
              <input
                className="text-input"
                type={revealOauth ? 'text' : 'password'}
                value={draft.oauthToken}
                onChange={(e) => patch('oauthToken', e.target.value)}
                placeholder="generate with: claude setup-token"
                spellCheck={false}
                autoComplete="off"
              />
              <button
                className="tb-btn"
                onClick={() => setRevealOauth((v) => !v)}
                title={revealOauth ? 'Hide' : 'Show'}
              >
                {revealOauth ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">Model</h3>
          <p className="settings-help">
            Default model used by the Director and any new agent spawn.
            Per-agent overrides aren&apos;t in v1 yet.
          </p>

          <div className="field">
            <span className="lbl">Default model</span>
            <input
              className="text-input"
              list="known-models"
              value={draft.defaultModel}
              onChange={(e) => patch('defaultModel', e.target.value)}
              spellCheck={false}
              autoComplete="off"
            />
            <datalist id="known-models">
              {KNOWN_MODELS.map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">Budget defaults</h3>
          <p className="settings-help">
            Per-agent caps applied when a spawn doesn&apos;t override them.{' '}
            <strong>0 means no cap.</strong> Hit the cap and the agent is
            aborted with status &quot;Budget exceeded&quot;.
          </p>

          <div className="settings-budget-grid">
            <div className="field">
              <span className="lbl">Max cost</span>
              <div className="settings-input-row">
                <span className="settings-unit">$</span>
                <input
                  className="text-input"
                  inputMode="decimal"
                  value={draft.defaultBudgetUsd}
                  onChange={(e) =>
                    patch('defaultBudgetUsd', parseNum(e.target.value))
                  }
                />
                <span className="settings-unit-trail">USD</span>
              </div>
            </div>

            <div className="field">
              <span className="lbl">Max tokens</span>
              <div className="settings-input-row">
                <input
                  className="text-input"
                  inputMode="numeric"
                  value={draft.defaultBudgetTokens}
                  onChange={(e) =>
                    patch('defaultBudgetTokens', parseNum(e.target.value))
                  }
                />
                <span className="settings-unit-trail">tokens</span>
              </div>
            </div>

            <div className="field">
              <span className="lbl">Max wall-clock</span>
              <div className="settings-input-row">
                <input
                  className="text-input"
                  inputMode="numeric"
                  value={draft.defaultBudgetSeconds}
                  onChange={(e) =>
                    patch('defaultBudgetSeconds', parseNum(e.target.value))
                  }
                />
                <span className="settings-unit-trail">seconds</span>
              </div>
            </div>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">About</h3>
          <div className="field">
            <span className="lbl">Version</span>
            <span className="v">
              <code>{version || '—'}</code>
            </span>
          </div>
          <div className="field">
            <span className="lbl">Settings file</span>
            <div className="settings-input-row">
              <span className="v" style={{ flex: 1 }}>
                <code>
                  %APPDATA%\Orchestrator\settings.json
                </code>
              </span>
              <button
                className="tb-btn"
                onClick={() => void window.api.showSettingsFile()}
                title="Reveal in Explorer"
              >
                <Icon name="file" size={11} /> Show in Explorer
              </button>
            </div>
          </div>
        </section>
      </div>

      <div className="settings-foot">
        <span className="spacer" />
        <button className="tb-btn" onClick={revert} disabled={!dirty || saving}>
          Revert
        </button>
        <button
          className="tb-btn primary"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          <Icon name="check" size={11} />
          {saving ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </div>
  );
}
