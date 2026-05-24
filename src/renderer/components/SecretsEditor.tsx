import { useEffect, useState } from 'react';
import type { Project, SecretListEntry } from '../../shared/types';

interface Props {
  project: Project;
}

const NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,62}$/;

/**
 * F6: edit per-project secrets. The list shows metadata only — values
 * never cross the IPC boundary in bulk. Click "edit" to reveal a single
 * value into a textarea (one round-trip per reveal). Saving the form
 * replaces the value via `setSecret`.
 *
 * Names must match `^[A-Z][A-Z0-9_]{0,62}$` (env-var shape). The main-
 * side validation enforces the same rule; we mirror it here so the
 * Save button can disable proactively.
 */
export function SecretsEditor({ project }: Props) {
  const [entries, setEntries] = useState<SecretListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savingName, setSavingName] = useState<string | null>(null);

  // Add-new form
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');

  // Per-row edit state, keyed by secret name. null = not editing.
  const [editing, setEditing] = useState<Map<string, string>>(new Map());

  const refresh = async () => {
    try {
      const list = await window.api.listSecrets(project.id);
      setEntries(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    setEntries(null);
    setEditing(new Map());
    setError(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const onAdd = async () => {
    if (!NAME_PATTERN.test(newName)) {
      setError(
        'Name must be uppercase letters / digits / underscores (start with a letter), max 63 chars.',
      );
      return;
    }
    setError(null);
    setSavingName(newName);
    try {
      const r = await window.api.setSecret(project.id, newName, newValue);
      if (!r.ok) {
        setError(r.error);
      } else {
        setNewName('');
        setNewValue('');
        await refresh();
      }
    } finally {
      setSavingName(null);
    }
  };

  const onReveal = async (name: string) => {
    const r = await window.api.revealSecret(project.id, name);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setEditing((prev) => {
      const next = new Map(prev);
      next.set(name, r.value);
      return next;
    });
  };

  const onCancelEdit = (name: string) => {
    setEditing((prev) => {
      const next = new Map(prev);
      next.delete(name);
      return next;
    });
  };

  const onSaveEdit = async (name: string) => {
    const value = editing.get(name);
    if (value === undefined) return;
    setError(null);
    setSavingName(name);
    try {
      const r = await window.api.setSecret(project.id, name, value);
      if (!r.ok) {
        setError(r.error);
      } else {
        setEditing((prev) => {
          const next = new Map(prev);
          next.delete(name);
          return next;
        });
        await refresh();
      }
    } finally {
      setSavingName(null);
    }
  };

  const onDelete = async (name: string) => {
    if (
      !window.confirm(
        `Delete secret ${name}? Future spawns won't have ${name} in their env.`,
      )
    ) {
      return;
    }
    await window.api.deleteSecret(project.id, name);
    await refresh();
  };

  const newNameValid = NAME_PATTERN.test(newName);

  return (
    <section className="settings-section">
      <h3 className="settings-h">Project secrets</h3>
      <p className="settings-help">
        Key-value pairs injected as environment variables into every
        spawned agent's child process. Values never appear in the prompt
        or chat history, so the agent's <code>$DATABASE_URL</code> /{' '}
        <code>$GH_TOKEN</code> / etc. stay out of logs and crash
        bundles. Stored as plaintext under <code>userData/</code> —
        matching the existing OAuth-token precedent. Names must be
        env-var shaped: <code>^[A-Z][A-Z0-9_]*$</code>.
      </p>

      {error && (
        <div className="form-error" style={{ marginBottom: 8 }}>
          {error}
        </div>
      )}

      {entries === null ? (
        <div className="inline-empty" style={{ padding: 18 }}>
          Loading…
        </div>
      ) : entries.length === 0 ? (
        <div className="inline-empty" style={{ padding: 18 }}>
          No secrets yet. Add one below.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {entries.map((e) => {
            const editingValue = editing.get(e.name);
            const isEditing = editingValue !== undefined;
            const isSaving = savingName === e.name;
            return (
              <div
                key={e.name}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  padding: '6px 8px',
                  background: 'var(--sub-2)',
                  borderRadius: 4,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <code style={{ fontWeight: 700 }}>{e.name}</code>
                  <span
                    className="dim"
                    style={{ fontSize: 10, marginLeft: 4 }}
                  >
                    {isEditing
                      ? `${editingValue?.length ?? 0} chars`
                      : `••• (${e.valueLength} chars)`}
                  </span>
                  <span className="spacer" />
                  <span className="dim" style={{ fontSize: 10 }}>
                    updated {new Date(e.updatedAt).toLocaleString()}
                  </span>
                  {isEditing ? (
                    <>
                      <button
                        className="tb-btn primary"
                        style={{ height: 20 }}
                        disabled={isSaving}
                        onClick={() => void onSaveEdit(e.name)}
                      >
                        {isSaving ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        className="tb-btn"
                        style={{ height: 20 }}
                        disabled={isSaving}
                        onClick={() => onCancelEdit(e.name)}
                      >
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        className="tb-btn"
                        style={{ height: 20 }}
                        onClick={() => void onReveal(e.name)}
                        title="Reveal the current value into an editable field"
                      >
                        Edit
                      </button>
                      <button
                        className="tb-btn"
                        style={{ height: 20 }}
                        onClick={() => void onDelete(e.name)}
                        title="Delete this secret"
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
                {isEditing && (
                  <textarea
                    value={editingValue}
                    onChange={(ev) =>
                      setEditing((prev) => {
                        const next = new Map(prev);
                        next.set(e.name, ev.target.value);
                        return next;
                      })
                    }
                    style={{
                      width: '100%',
                      minHeight: 60,
                      fontFamily: 'var(--font-mono, monospace)',
                      fontSize: 11,
                    }}
                    spellCheck={false}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}

      <div
        style={{
          marginTop: 12,
          padding: '8px 10px',
          background: 'var(--sub-2)',
          borderRadius: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: 'var(--text-2)',
          }}
        >
          Add secret
        </div>
        <input
          className="text-input"
          placeholder="NAME (e.g. DATABASE_URL)"
          value={newName}
          onChange={(e) => setNewName(e.target.value.toUpperCase())}
          style={{
            width: '100%',
            height: 24,
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
          }}
          spellCheck={false}
        />
        <textarea
          placeholder="value"
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          style={{
            width: '100%',
            minHeight: 50,
            fontFamily: 'var(--font-mono, monospace)',
            fontSize: 11,
          }}
          spellCheck={false}
        />
        <div style={{ display: 'flex', gap: 6 }}>
          <span className="spacer" />
          <button
            className="tb-btn primary"
            style={{ height: 22 }}
            disabled={!newNameValid || !newValue || savingName === newName}
            onClick={() => void onAdd()}
            title={
              !newNameValid
                ? 'Enter an env-var-shaped NAME first'
                : !newValue
                  ? 'Enter a value'
                  : 'Save the new secret'
            }
          >
            {savingName === newName ? 'Saving…' : 'Add'}
          </button>
        </div>
      </div>
    </section>
  );
}
