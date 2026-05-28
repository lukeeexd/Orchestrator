import fs from 'node:fs';
import path from 'node:path';

/**
 * Read-only markdown file browser backing the Docs rail screen.
 *
 * Two operations:
 *   - `listDirectory(absPath)` returns directory entries + filtered
 *     markdown files at the given path (and its parent if not the
 *     filesystem root).
 *   - `readMarkdownFile(absPath)` returns the raw markdown content.
 *
 * Path-gating philosophy: the renderer is trusted (single-user
 * local app). We still apply two cheap guards:
 *   1. Reject paths that fail `fs.realpathSync` — catches typos and
 *      dangling symlinks but doesn't try to enforce a sandbox.
 *   2. Reject reads of files that don't have a markdown extension —
 *      keeps the UI honest (the user picked a `.md` file in the
 *      tree, the handler shouldn't be a back-door for arbitrary
 *      file reads).
 *
 * Size cap: 5 MiB. Larger files are read as a truncated preview
 * with a header note. Stops a runaway tail from wedging the
 * renderer if someone clicks a multi-megabyte markdown dump.
 */

export interface MarkdownDirEntry {
  name: string;
  /** Absolute path on disk — what the renderer passes back for navigation. */
  path: string;
  isDirectory: boolean;
  /** True for .md / .markdown files (case-insensitive). */
  isMarkdown: boolean;
}

export interface MarkdownListing {
  /** Absolute path of the directory that was listed. */
  path: string;
  /** Parent directory's absolute path; null when we're at the filesystem root. */
  parent: string | null;
  /** Directories first (alpha), then markdown files (alpha). Non-markdown files are filtered out. */
  entries: MarkdownDirEntry[];
}

export interface MarkdownFileContent {
  path: string;
  content: string;
  /** True if the file exceeded MAX_BYTES and `content` is a head-of-file slice. */
  truncated: boolean;
}

const MAX_BYTES = 5 * 1024 * 1024; // 5 MiB

function hasMarkdownExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** Common no-noise hides — `.git` etc. are useful to elide. Pure cosmetic. */
const HIDDEN_DIR_NAMES = new Set<string>([
  '.git',
  '.svn',
  '.hg',
  'node_modules',
  '.vite',
  '.next',
  '.cache',
  '.parcel-cache',
  '.turbo',
  'out',
  'dist',
  'build',
]);

function isHiddenDir(name: string): boolean {
  if (HIDDEN_DIR_NAMES.has(name)) return true;
  // Hide other dotfiles by default; the user's `.orchestrator/`
  // memory dir is the one we DO want surfaced, so we whitelist
  // that explicitly.
  if (name === '.orchestrator') return false;
  return name.startsWith('.');
}

/**
 * List a directory's contents. Throws on non-existent / non-directory
 * input so the IPC handler can surface a sensible error to the
 * renderer.
 */
export function listDirectory(absPath: string): MarkdownListing {
  let realPath: string;
  try {
    realPath = fs.realpathSync(absPath);
  } catch (err) {
    throw new Error(
      `Cannot read directory "${absPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  const stat = fs.statSync(realPath);
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${realPath}`);
  }

  const names = fs.readdirSync(realPath);
  const entries: MarkdownDirEntry[] = [];
  for (const name of names) {
    let entryStat: fs.Stats;
    try {
      entryStat = fs.statSync(path.join(realPath, name));
    } catch {
      // Broken symlink, permission error — skip silently. The user
      // can't act on these anyway.
      continue;
    }
    const isDir = entryStat.isDirectory();
    if (isDir && isHiddenDir(name)) continue;
    if (!isDir && !hasMarkdownExtension(name)) continue;
    entries.push({
      name,
      path: path.join(realPath, name),
      isDirectory: isDir,
      isMarkdown: !isDir && hasMarkdownExtension(name),
    });
  }
  // Directories first, then markdown files; alphabetical within each group.
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parsed = path.parse(realPath);
  const parent = parsed.dir && parsed.dir !== realPath ? parsed.dir : null;
  return { path: realPath, parent, entries };
}

/**
 * Read a markdown file. Rejects non-markdown extensions even if the
 * renderer passes a typo'd path — the tree only surfaces markdown
 * files in the first place, so getting here with a non-markdown path
 * means something downstream is broken.
 */
export function readMarkdownFile(absPath: string): MarkdownFileContent {
  // R-Vuln4-2026-05-28: realpath FIRST, then re-check the extension on
  // the resolved path. Pre-fix order was extension-check-then-realpath:
  // a symlink named `foo.md` pointing at `~/.ssh/config` (or any other
  // sensitive non-markdown file) passed the link-name extension gate,
  // then realpath silently followed to the target, and the function
  // happily returned the target's content up to the 5 MiB cap. Same
  // shape applies to listDirectory below, but that path realpaths
  // before any name filter already.
  let realPath: string;
  try {
    realPath = fs.realpathSync(absPath);
  } catch (err) {
    throw new Error(
      `Cannot read file "${absPath}": ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  if (!hasMarkdownExtension(realPath)) {
    throw new Error(
      `Refusing to read non-markdown file: ${path.basename(realPath)}`,
    );
  }
  const stat = fs.statSync(realPath);
  if (!stat.isFile()) {
    throw new Error(`Not a file: ${realPath}`);
  }

  if (stat.size > MAX_BYTES) {
    // Read just the first MAX_BYTES and label as truncated.
    const fd = fs.openSync(realPath, 'r');
    try {
      const buf = Buffer.alloc(MAX_BYTES);
      fs.readSync(fd, buf, 0, MAX_BYTES, 0);
      return {
        path: realPath,
        content: buf.toString('utf8'),
        truncated: true,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  const content = fs.readFileSync(realPath, 'utf8');
  return { path: realPath, content, truncated: false };
}
