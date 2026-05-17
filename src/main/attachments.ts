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

/**
 * Image extensions → vision content-block media types. Sent as separate
 * `{type:'image'}` blocks via `claude --input-format stream-json`; not
 * inlined into the text prompt.
 */
const IMAGE_MEDIA_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

/** Max bytes per inlined text file; over the cap is truncated with a note. */
const MAX_TEXT_BYTES = 100 * 1024; // 100 KiB

/**
 * Max bytes per image attachment. Anthropic's vision API accepts up to
 * ~5 MiB per image; oversized images get skipped (not truncated — a
 * cropped image is meaningfully different from the original).
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export type AttachmentKind = 'text' | 'image' | 'unsupported';

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
  /** Set whenever the extension was recognized — even if the file then failed validation. Lets the UI render an image-glyph chip even on an oversized PNG. */
  kind?: AttachmentKind;
}

function classifyExt(ext: string): AttachmentKind {
  if (TEXT_EXTS.has(ext)) return 'text';
  if (ext in IMAGE_MEDIA_TYPES) return 'image';
  return 'unsupported';
}

export function describeAttachments(paths: string[]): AttachmentInfo[] {
  return paths.map((p) => {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const kind = classifyExt(ext);
    if (kind === 'unsupported') {
      return {
        path: p,
        name,
        ok: false,
        reason: `unsupported type (${ext || 'no ext'})`,
        kind,
      };
    }
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) {
        return { path: p, name, ok: false, reason: 'not a regular file', kind };
      }
      if (kind === 'image' && stat.size > MAX_IMAGE_BYTES) {
        const mib = (stat.size / (1024 * 1024)).toFixed(1);
        return {
          path: p,
          name,
          ok: false,
          reason: `image too large (${mib} MiB, cap 5 MiB)`,
          kind,
        };
      }
      return { path: p, name, ok: true, kind };
    } catch (e) {
      return {
        path: p,
        name,
        ok: false,
        reason: e instanceof Error ? e.message : 'read failed',
        kind,
      };
    }
  });
}

/**
 * Split a flat list of attachment paths into text vs image paths. Anything
 * with an unsupported extension is dropped on the floor — the renderer
 * already filtered ok-marked-only before calling, so unsupported paths
 * shouldn't reach us in practice. This helper is paranoid about it
 * anyway so a future call site can safely pass the raw `req.attachments`.
 */
export function splitAttachments(paths: string[]): {
  textPaths: string[];
  imagePaths: string[];
} {
  const textPaths: string[] = [];
  const imagePaths: string[] = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    const kind = classifyExt(ext);
    if (kind === 'text') textPaths.push(p);
    else if (kind === 'image') imagePaths.push(p);
  }
  return { textPaths, imagePaths };
}

/**
 * Render a list of text attachment paths as a single block suitable for
 * prepending to a prompt. Image / unsupported paths are filtered out by
 * the caller via splitAttachments — anything that slips through is
 * skipped with a note so the LLM at least sees something didn't make it.
 */
export function inlineAttachments(paths: string[]): string {
  if (paths.length === 0) return '';
  const parts: string[] = ['[attachments]'];
  for (const p of paths) {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const kind = classifyExt(ext);
    if (kind !== 'text') {
      parts.push(
        `\n--- ${name} (skipped: ${
          kind === 'image' ? 'image — sent as a separate content block' : 'unsupported type'
        }) ---`,
      );
      continue;
    }
    let content: string;
    let truncated = false;
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > MAX_TEXT_BYTES) {
        content = buf.subarray(0, MAX_TEXT_BYTES).toString('utf8');
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

export interface ImageContentBlock {
  name: string;
  mediaType: string;
  base64: string;
}

/**
 * Read each image path off disk and base64-encode it for sending as a
 * vision content block. Failures (file gone, unreadable, somehow
 * oversize) are dropped silently — describeAttachments already validated
 * by the time the renderer let the user submit, and a hard error here
 * would lose the rest of the spawn for one bad file.
 *
 * Returns a parallel array of "skipped" reasons so the runner can surface
 * a warn log for any image that didn't make it.
 */
export function readImagesForApi(paths: string[]): {
  blocks: ImageContentBlock[];
  skipped: { name: string; reason: string }[];
} {
  const blocks: ImageContentBlock[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const p of paths) {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) {
      skipped.push({ name, reason: `unsupported image type (${ext})` });
      continue;
    }
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > MAX_IMAGE_BYTES) {
        const mib = (buf.length / (1024 * 1024)).toFixed(1);
        skipped.push({ name, reason: `image too large (${mib} MiB, cap 5 MiB)` });
        continue;
      }
      blocks.push({ name, mediaType, base64: buf.toString('base64') });
    } catch (e) {
      skipped.push({
        name,
        reason: e instanceof Error ? e.message : 'read failed',
      });
    }
  }
  return { blocks, skipped };
}

/**
 * One-shot prep used by every spawn/fork/redirect/Director site that
 * accepts user attachments. Splits the path list, inlines text, encodes
 * images for the API, and produces human-readable warn lines for any
 * file that didn't make it (oversize, unreadable, or sent to a provider
 * that doesn't support that kind). Callers emit `warnLines` as
 * `warn`-kind log entries so the user sees what was dropped.
 *
 * For codex, image paths are dropped with a "codex doesn't support
 * vision content blocks" note — we still inline any text attachments so
 * the user's prompt isn't silently halved.
 */
export function prepareAttachments(
  paths: string[] | undefined,
  provider: 'claude' | 'codex',
): {
  textInline: string;
  images: ImageContentBlock[];
  warnLines: string[];
} {
  if (!paths || paths.length === 0) {
    return { textInline: '', images: [], warnLines: [] };
  }
  const { textPaths, imagePaths } = splitAttachments(paths);
  const textInline = textPaths.length > 0 ? inlineAttachments(textPaths) : '';

  const warnLines: string[] = [];
  let images: ImageContentBlock[] = [];

  if (imagePaths.length > 0) {
    if (provider === 'codex') {
      warnLines.push(
        `${imagePaths.length} image attachment${
          imagePaths.length === 1 ? '' : 's'
        } skipped — codex provider doesn't support vision content blocks yet`,
      );
    } else {
      const { blocks, skipped } = readImagesForApi(imagePaths);
      images = blocks;
      for (const s of skipped) {
        warnLines.push(`Image ${s.name} skipped: ${s.reason}`);
      }
    }
  }

  return { textInline, images, warnLines };
}
