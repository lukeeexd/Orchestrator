import { useEffect, useState } from 'react';
import type { Provider } from '../../shared/types';
import { Icon } from './Icon';
import { Modal } from './Modal';

interface ProviderInfo {
  binName: string;
  productName: string;
  installCommand: string;
  installUrl: string;
}

const PROVIDER_INFO: Record<Provider, ProviderInfo> = {
  claude: {
    binName: 'claude',
    productName: 'Claude Code',
    installCommand: 'npm install -g @anthropic-ai/claude-code',
    installUrl: 'https://docs.claude.com/en/docs/claude-code',
  },
  codex: {
    binName: 'codex',
    productName: 'OpenAI Codex CLI',
    installCommand: 'npm install -g @openai/codex',
    installUrl: 'https://platform.openai.com/docs/codex',
  },
};

/**
 * Blocking overlay shown when the CLI required by the active project's
 * provider isn't on PATH. Probes every 5s so a fresh install unlocks
 * the gate without restarting the app.
 *
 * Provider-aware: a claude-only user creating a codex project will see
 * the codex install prompt, and vice versa. Defaults to claude when
 * called without a provider (legacy callers / no-project state).
 */
export function CliMissingGate({
  provider,
  onResolved,
}: {
  provider: Provider;
  onResolved: () => void;
}) {
  const info = PROVIDER_INFO[provider];
  const [version, setVersion] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      setChecking(true);
      try {
        const status = await window.api.getCliStatus(provider);
        if (!alive) return;
        if (status.available) {
          setVersion(status.version);
          // Brief celebration before clearing — feels less abrupt than
          // a hard cut, and confirms the version they just installed.
          setTimeout(() => {
            if (alive) onResolved();
          }, 400);
        }
      } finally {
        if (alive) setChecking(false);
      }
    };
    void check();
    const t = setInterval(() => void check(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [provider, onResolved]);

  // Blocking gate — no onClose. Modal still gets focus trap +
  // dialog role + restored focus so a sighted-keyboard user
  // doesn't tab out into the (visually hidden, but DOM-present)
  // main app behind it.
  return (
    <Modal title={<b>{info.productName} CLI not found</b>}>
      <p style={{ margin: 0, color: 'var(--text)', fontSize: 13 }}>
        This project&apos;s runtime is <strong>{provider}</strong> —
        Orchestrator shells out to the{' '}
        <code>{info.binName}</code> command, which isn&apos;t on your
        PATH right now.
      </p>
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 12 }}>
        Install {info.productName}, then leave this window open —
        it&apos;ll detect the CLI within a few seconds and unlock
        itself.
      </p>
      <div
        className="field"
        style={{
          padding: 12,
          background: 'var(--sub)',
          border: '1px solid var(--border)',
          borderRadius: 6,
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
        }}
      >
        <div style={{ color: 'var(--muted)', marginBottom: 6 }}>
          Quick install:
        </div>
        <div>{info.installCommand}</div>
        <div
          style={{
            color: 'var(--muted-2)',
            marginTop: 8,
            fontSize: 11,
          }}
        >
          or visit <code>{info.installUrl}</code> for the official
          installer.
        </div>
      </div>
      {version && (
        <div
          style={{
            padding: 8,
            background: 'rgba(74, 222, 128, 0.08)',
            border: '1px solid rgba(74, 222, 128, 0.3)',
            borderRadius: 6,
            color: 'var(--accent)',
            fontSize: 12,
          }}
        >
          <Icon name="check" size={11} /> Detected: <code>{version}</code>
        </div>
      )}
      <span
        className="meta"
        style={{
          color: 'var(--muted)',
          marginTop: 8,
          fontSize: 12,
          alignSelf: 'flex-start',
        }}
      >
        {checking ? 'Checking…' : 'Auto-rechecks every 5s'}
      </span>
    </Modal>
  );
}
