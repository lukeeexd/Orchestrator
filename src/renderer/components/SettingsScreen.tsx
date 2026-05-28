import { useEffect, useRef, useState } from 'react';
import type { Settings } from '../../shared/ipc';
import { Icon } from './Icon';
import { ModelPicker } from './ModelPicker';
import { EffortPicker } from './EffortPicker';
import { UpdaterPanel } from './UpdaterPanel';

export function SettingsScreen() {
  const [draft, setDraft] = useState<Settings | null>(null);
  const [original, setOriginal] = useState<Settings | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealApi, setRevealApi] = useState(false);
  const [revealOauth, setRevealOauth] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [version, setVersion] = useState<string>('');
  const [crashes, setCrashes] = useState<
    import('../../shared/types').CrashEntry[] | null
  >(null);
  // F9: opt-in secret-scrub toggle for the crash-bundle export. Defaults
  // to on because the bundle is the "shareable" version of the crash;
  // user can untick if they need a fully-faithful copy for local triage.
  const [exportScrub, setExportScrub] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const savedTimer = useRef<number | null>(null);

  const refreshCrashes = () => {
    void window.api.listCrashes().then(setCrashes);
  };

  useEffect(() => {
    void window.api.getSettings().then((s) => {
      setDraft(s);
      setOriginal(s);
    });
    void window.api.ping().then((p) => setVersion(p.version));
    refreshCrashes();
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
          <h3 className="settings-h">Model &amp; effort</h3>
          <p className="settings-help">
            Defaults used when a project hasn&apos;t picked its own values.
            The Director gets a heavier model out of the box (Opus 4.8 1M,
            xhigh) since it has to hold the whole fleet + conversation in
            its head; agents default to Sonnet 4.6 at <code>high</code>.
            Effort levels mirror Claude Code:&nbsp;
            <code>low</code>/<code>medium</code>/<code>high</code> on all
            models, <code>xhigh</code>/<code>max</code> on the Opus + Sonnet
            tiers.
          </p>

          <div className="field">
            <span className="lbl">Director model</span>
            <ModelPicker
              value={draft.defaultDirectorModel}
              onChange={(v) => patch('defaultDirectorModel', v)}
            />
          </div>

          <div className="field">
            <span className="lbl">Director effort</span>
            <EffortPicker
              value={draft.defaultDirectorEffort}
              onChange={(v) => patch('defaultDirectorEffort', v)}
            />
          </div>

          <div className="field">
            <span className="lbl">Agent model</span>
            <ModelPicker
              value={draft.defaultModel}
              onChange={(v) => patch('defaultModel', v)}
            />
          </div>

          <div className="field">
            <span className="lbl">Agent effort</span>
            <EffortPicker
              value={draft.defaultEffort}
              onChange={(v) => patch('defaultEffort', v)}
            />
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">Marketplace</h3>
          <div className="field">
            <label
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 8,
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={draft.copyGlobalSubsToNewProjects}
                onChange={(e) =>
                  patch('copyGlobalSubsToNewProjects', e.target.checked)
                }
                style={{ marginTop: 3 }}
              />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 12 }}>
                  Copy global subscriptions to new projects
                </div>
                <div
                  className="settings-help"
                  style={{
                    fontSize: 11,
                    color: 'var(--muted)',
                    marginTop: 2,
                  }}
                >
                  When a new project is created, snapshot every current
                  global marketplace subscription as a project-scoped
                  clone in the new project. Lets you customize per
                  project (different roles / skills) from a global
                  baseline. Off by default — global subs already apply
                  to every project automatically.
                </div>
              </div>
            </label>
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-h">Crashes</h3>
          <div className="field">
            <span className="lbl">Captured</span>
            <div className="settings-input-row">
              <span className="v" style={{ flex: 1 }}>
                {crashes === null ? (
                  '—'
                ) : crashes.length === 0 ? (
                  <span className="dim">No crashes captured.</span>
                ) : (
                  <>
                    <code>{crashes.length}</code> crash
                    {crashes.length === 1 ? '' : 'es'}
                    {crashes[0] && (
                      <span className="dim" style={{ marginLeft: 8 }}>
                        latest: {crashes[0].kind} ·{' '}
                        {new Date(crashes[0].ts).toLocaleString()}
                      </span>
                    )}
                  </>
                )}
              </span>
              <button
                className="tb-btn"
                onClick={() => void window.api.openCrashesFolder()}
                title="Reveal the crashes folder in Explorer"
              >
                <Icon name="file" size={11} /> Open folder
              </button>
              <button
                className="tb-btn"
                onClick={async () => {
                  if (!crashes || crashes.length === 0 || exporting) return;
                  setExporting(true);
                  setExportError(null);
                  try {
                    const res = await window.api.exportCrashBundle(
                      crashes[0].id,
                      { scrubSecrets: exportScrub },
                    );
                    if (!res.ok) setExportError(res.error);
                  } finally {
                    setExporting(false);
                  }
                }}
                disabled={!crashes || crashes.length === 0 || exporting}
                title="Bundle the latest crash + recent forensics into a single .zip and reveal it in Explorer"
              >
                <Icon name="file" size={11} />{' '}
                {exporting ? 'Exporting…' : 'Export latest as .zip'}
              </button>
              <button
                className="tb-btn"
                onClick={async () => {
                  if (!crashes || crashes.length === 0) return;
                  await window.api.clearCrashes();
                  refreshCrashes();
                }}
                disabled={!crashes || crashes.length === 0}
                title="Delete every crash JSON in the crashes folder"
              >
                <Icon name="x" size={11} /> Clear all
              </button>
            </div>
          </div>
          <div className="field">
            <span className="lbl"></span>
            <span className="v" style={{ fontSize: 11 }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  cursor: 'pointer',
                  userSelect: 'none',
                  color: 'var(--text-2)',
                }}
                title="Mask common secret shapes (Anthropic / GitHub / AWS keys, bearer JWTs, env-style assignments) inside the exported bundle. The raw crash JSON on disk is unchanged."
              >
                <input
                  type="checkbox"
                  checked={exportScrub}
                  onChange={(e) => setExportScrub(e.target.checked)}
                  style={{ margin: 0 }}
                  disabled={exporting}
                />
                Scrub secrets in export
              </label>
              {exportError && (
                <span
                  className="dim"
                  style={{ marginLeft: 8, color: 'var(--error)' }}
                >
                  Export failed: {exportError}
                </span>
              )}
            </span>
          </div>
          <div className="field">
            <span className="lbl"></span>
            <span className="v dim" style={{ fontSize: 11 }}>
              Captured locally; nothing is uploaded. Reveal the folder
              if you need to copy a crash into a bug report.
            </span>
          </div>
          <div className="field">
            <span className="lbl">Debug</span>
            <div className="settings-input-row">
              <button
                className="tb-btn"
                onClick={() => {
                  // setTimeout escape so the throw lands in
                  // window.onerror (proving the global listener)
                  // rather than tearing down the React tree via the
                  // boundary.
                  setTimeout(() => {
                    throw new Error('S5 test crash from Settings');
                  }, 0);
                  // The IPC write is async — refresh after a short
                  // delay so the new file shows up in the count.
                  setTimeout(refreshCrashes, 300);
                }}
                title="Throw a renderer error to verify the capture pipeline. Lands in window.onerror, not the React boundary, so the UI stays mounted."
              >
                <Icon name="play" size={11} /> Trigger test crash
              </button>
            </div>
          </div>
        </section>

        <UpdaterPanel />

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
