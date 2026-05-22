import { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type {
  MarkdownDirEntry,
  MarkdownListing,
  Project,
} from '../../shared/types';
import { Icon } from './Icon';

/**
 * Docs rail screen — two-pane markdown viewer.
 *
 *   ┌── tree (sortable) ──┬── rendered markdown ──┐
 *   │ ../                 │                       │
 *   │ src/                │  # README             │
 *   │ docs/               │  ...                  │
 *   │ README.md           │                       │
 *   └─────────────────────┴───────────────────────┘
 *
 * Tree shows directories + `.md` / `.markdown` files only — common
 * build / VCS dirs (`.git`, `node_modules`, `out`, `dist`, etc.) are
 * filtered out by `src/main/markdownBrowser.ts:listDirectory`.
 *
 * Root defaults to the active project's workspace; the user can
 * change it via "Pick folder" (calls `docsPickFolder` IPC). Pick
 * lives in localStorage so the choice survives across sessions but
 * we still seed from the project workspace each project switch.
 *
 * View-only — no edit affordances. Edit is a separate slice.
 */

interface Props {
  activeProject: Project | null | undefined;
}

const STORAGE_KEY = 'orchestrator.docsRoot';

export function DocsScreen({ activeProject }: Props) {
  const [root, setRoot] = useState<string | null>(() => {
    return localStorage.getItem(STORAGE_KEY);
  });
  const [listing, setListing] = useState<MarkdownListing | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<MarkdownDirEntry | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);

  // Seed root from the active project's workspace when nothing is
  // stored, OR when the stored root is unreadable. Keeps first-use
  // useful without forcing a folder picker.
  useEffect(() => {
    if (root) return;
    if (activeProject?.workspace) {
      setRoot(activeProject.workspace);
      localStorage.setItem(STORAGE_KEY, activeProject.workspace);
    }
  }, [activeProject?.workspace, root]);

  // Load the listing whenever root changes. If the saved root has
  // gone missing (deleted, moved, machine swap), fall back to the
  // active project's workspace.
  useEffect(() => {
    if (!root) {
      setListing(null);
      return;
    }
    let alive = true;
    void window.api.docsListDirectory(root).then((res) => {
      if (!alive) return;
      if (res.ok) {
        setListing(res.listing);
        setListError(null);
      } else {
        setListing(null);
        setListError(res.error);
      }
    });
    return () => {
      alive = false;
    };
  }, [root]);

  const openDirectory = (absPath: string) => {
    setSelected(null);
    setContent(null);
    setReadError(null);
    void window.api.docsListDirectory(absPath).then((res) => {
      if (res.ok) {
        setListing(res.listing);
        setListError(null);
      } else {
        setListError(res.error);
      }
    });
  };

  const openFile = (entry: MarkdownDirEntry) => {
    setSelected(entry);
    setContent(null);
    setTruncated(false);
    setReadError(null);
    void window.api.docsReadFile(entry.path).then((res) => {
      if (res.ok) {
        setContent(res.file.content);
        setTruncated(res.file.truncated);
      } else {
        setReadError(res.error);
      }
    });
  };

  const pickFolder = async () => {
    const result = await window.api.docsPickFolder();
    if (!result.path) return;
    localStorage.setItem(STORAGE_KEY, result.path);
    setRoot(result.path);
    setSelected(null);
    setContent(null);
  };

  return (
    <div className="docs-screen">
      <div className="docs-pane-tree">
        <div className="docs-tree-head">
          <span className="docs-tree-path" title={listing?.path ?? root ?? ''}>
            {listing?.path ?? root ?? '—'}
          </span>
          <button
            className="tb-btn"
            onClick={() => void pickFolder()}
            title="Pick a different folder as the Docs root"
          >
            <Icon name="file" size={11} /> Pick folder
          </button>
        </div>

        {listError && <div className="docs-tree-error">{listError}</div>}

        {listing && (
          <div className="docs-tree-list">
            {listing.parent && (
              <button
                className="docs-tree-row dir"
                onClick={() =>
                  listing.parent && openDirectory(listing.parent)
                }
              >
                <Icon name="chevron" size={11} />
                <span className="docs-tree-name">..</span>
              </button>
            )}
            {listing.entries.map((entry) => (
              <button
                key={entry.path}
                className={
                  'docs-tree-row ' +
                  (entry.isDirectory ? 'dir' : 'file') +
                  (selected?.path === entry.path ? ' selected' : '')
                }
                onClick={() =>
                  entry.isDirectory
                    ? openDirectory(entry.path)
                    : openFile(entry)
                }
              >
                <Icon
                  name={entry.isDirectory ? 'chevron' : 'file'}
                  size={11}
                />
                <span className="docs-tree-name">{entry.name}</span>
              </button>
            ))}
            {listing.entries.length === 0 && (
              <div className="docs-tree-empty">
                No markdown files in this folder.
              </div>
            )}
          </div>
        )}
      </div>

      <div className="docs-pane-content">
        {!selected && !content && !readError && (
          <div className="docs-empty">
            <div className="docs-empty-glyph">
              <Icon name="file" size={28} color="var(--muted)" stroke={1.2} />
            </div>
            <div className="docs-empty-title">Pick a markdown file</div>
            <div className="docs-empty-body">
              Browse the tree on the left and click any{' '}
              <code>.md</code> file to render it here.
            </div>
          </div>
        )}

        {readError && <div className="docs-read-error">{readError}</div>}

        {selected && content !== null && (
          <>
            <div className="docs-content-head">
              <span
                className="docs-content-path"
                title={selected.path}
              >
                {selected.path}
              </span>
              {truncated && (
                <span
                  className="docs-truncated-badge"
                  title="File exceeded 5 MiB — only the first 5 MiB is rendered."
                >
                  truncated
                </span>
              )}
            </div>
            <div className="md-body docs-content-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {content}
              </ReactMarkdown>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
