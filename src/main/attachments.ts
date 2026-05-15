import fs from 'node:fs';
import path from 'node:path';

/**
 * Whitelist of text-ish file extensions. Anything outside this list is
 * skipped at inline time with a warning so we don't try to embed
 * binaries / big assets in the prompt.
 */
const TEXT_EXTS = new Set([
  '.md', '.txt', '.markdown', '.rst',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.conf', '.env',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.cs',
  '.html', '.css', '.scss', '.sass', '.less',
  '.xml', '.svg',
  '.sql', '.sh', '.bash', '.ps1', '.bat', '.cmd',
  '.lock', '.gitignore', '.dockerignore', '.editorconfig',
  '.dockerfile',
]);

/** Max bytes per attached file; anything over gets truncated with a note. */
const MAX_BYTES = 100 * 1024; // 100 KiB

function langTag(p: string): string {
  const ext = path.extname(p).slice(1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
      return 'typescript';
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'py':
      return 'python';
    case 'rb':
      return 'ruby';
    case 'sh':
    case 'bash':
      return 'bash';
    case 'ps1':
      return 'powershell';
    case 'md':
    case 'markdown':
      return 'markdown';
    case 'yml':
    case 'yaml':
      return 'yaml';
    default:
      return ext;
  }
}

export interface AttachmentInfo {
  path: string;
  name: string;
  ok: boolean;
  reason?: string;
}

export function describeAttachments(paths: string[]): AttachmentInfo[] {
  return paths.map((p) => {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      return { path: p, name, ok: false, reason: `unsupported type (${ext || 'no ext'})` };
    }
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) {
        return { path: p, name, ok: false, reason: 'not a regular file' };
      }
      return { path: p, name, ok: true };
    } catch (e) {
      return {
        path: p,
        name,
        ok: false,
        reason: e instanceof Error ? e.message : 'read failed',
      };
    }
  });
}

/**
 * Render a list of attachment paths as a single block of text suitable
 * for prepending to a prompt. Files outside the text whitelist are
 * skipped (a one-line "skipped: X" note is included so the LLM knows).
 * Files over 100 KiB are truncated and tagged.
 */
export function inlineAttachments(paths: string[]): string {
  if (paths.length === 0) return '';
  const parts: string[] = ['[attachments]'];
  for (const p of paths) {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    if (!TEXT_EXTS.has(ext)) {
      parts.push(`\n--- ${name} (skipped: unsupported type ${ext || 'no ext'}) ---`);
      continue;
    }
    let content: string;
    let truncated = false;
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > MAX_BYTES) {
        content = buf.subarray(0, MAX_BYTES).toString('utf8');
        truncated = true;
      } else {
        content = buf.toString('utf8');
      }
    } catch (e) {
      parts.push(
        `\n--- ${name} (skipped: ${e instanceof Error ? e.message : 'read failed'}) ---`,
      );
      continue;
    }
    const lang = langTag(p);
    parts.push(`\n--- ${name}${truncated ? ' (truncated to 100 KiB)' : ''} ---`);
    parts.push('```' + lang);
    parts.push(content);
    parts.push('```');
  }
  parts.push('\n[/attachments]\n\n');
  return parts.join('\n');
}
