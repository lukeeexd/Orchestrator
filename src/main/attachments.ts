import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { isAttachmentAllowed } from './security/attachments';

/**
 * Single source of truth for the temp directory we use to stage
 * pasted-image attachments. The writer (savePastedImage IPC handler)
 * and the startup sweep (cleanupPastedImagesAtStart) both go through
 * here so a folder rename can't drift them apart.
 */
export function pasteTempDir(): string {
  return path.join(app.getPath('temp'), 'orchestrator-paste');
}

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

/**
 * Document extensions → content-block media types. Sent as
 * `{type:'document'}` blocks alongside images via the same stream-json
 * input pipeline. PDF only for now — DOC/DOCX would need server-side
 * conversion.
 */
const DOCUMENT_MEDIA_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
};

/** Max bytes per inlined text file; over the cap is truncated with a note. */
const MAX_TEXT_BYTES = 100 * 1024; // 100 KiB

/**
 * M3: belt-and-braces caps across a single spawn's attachment set.
 * The per-file caps above (text/image/document) already prevent any
 * one file from running away, but a renderer that handed in 1000
 * 100-KiB text files would still produce a 100 MiB prompt over
 * stdin. These two caps stop that.
 *
 * The text-total cap is set well above the per-file cap so a single
 * legitimate near-cap file still inlines while still rejecting
 * blatant bulk submission. The 32-file count cap matches user-
 * realistic usage (the picker dialog struggles past a few dozen
 * anyway).
 */
const MAX_TOTAL_INLINED_BYTES = 2 * 1024 * 1024; // 2 MiB
const MAX_ATTACHMENTS_PER_CALL = 32;

/**
 * Max bytes per image attachment. Anthropic's vision API accepts up to
 * ~5 MiB per image; oversized images get skipped (not truncated — a
 * cropped image is meaningfully different from the original).
 */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * Max bytes per PDF attachment. Anthropic accepts up to 32 MiB per
 * document, but most user PDFs are well under 10 MiB and the larger
 * cap costs serious tokens — keep it conservative.
 */
const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;

/** Reverse map for pasted-image handling — clipboard MIME → file ext we recognize. */
const MEDIA_TYPE_TO_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpeg',
  'image/jpg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export type AttachmentKind = 'text' | 'image' | 'document' | 'unsupported';

/**
 * Union of every extension we recognize at attachment time. Exported so
 * the IPC's file-picker dialog can hide unsupported types upfront
 * instead of letting the user pick a file that will just chip-as-bad.
 * Returns lowercased ext without the leading dot (the format Electron's
 * dialog filter expects).
 */
export function supportedAttachmentExtensions(): string[] {
  const all = new Set<string>();
  for (const e of TEXT_EXTS) all.add(e.slice(1));
  for (const e of Object.keys(IMAGE_MEDIA_TYPES)) all.add(e.slice(1));
  for (const e of Object.keys(DOCUMENT_MEDIA_TYPES)) all.add(e.slice(1));
  return [...all].sort();
}

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
  if (ext in DOCUMENT_MEDIA_TYPES) return 'document';
  return 'unsupported';
}

/**
 * Classify a file path by its extension, using the same rules the
 * inline-prompt pipeline applies. Exported so security/attachments.ts
 * can deny renderer-supplied drop paths whose extension isn't one
 * the pipeline knows how to handle anyway (R-Vuln1-2026-05-28).
 */
export function classifyAttachmentPath(absPath: string): AttachmentKind {
  return classifyExt(path.extname(absPath).toLowerCase());
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
      if (kind === 'document' && stat.size > MAX_DOCUMENT_BYTES) {
        const mib = (stat.size / (1024 * 1024)).toFixed(1);
        return {
          path: p,
          name,
          ok: false,
          reason: `PDF too large (${mib} MiB, cap 10 MiB)`,
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
  documentPaths: string[];
} {
  const textPaths: string[] = [];
  const imagePaths: string[] = [];
  const documentPaths: string[] = [];
  for (const p of paths) {
    const ext = path.extname(p).toLowerCase();
    const kind = classifyExt(ext);
    if (kind === 'text') textPaths.push(p);
    else if (kind === 'image') imagePaths.push(p);
    else if (kind === 'document') documentPaths.push(p);
  }
  return { textPaths, imagePaths, documentPaths };
}

/**
 * Render a list of text attachment paths as a single block suitable for
 * prepending to a prompt. Image / unsupported paths are filtered out by
 * the caller via splitAttachments — anything that slips through is
 * skipped with a note so the LLM at least sees something didn't make it.
 *
 * M3: enforces a 2 MiB total inlined cap across all text files. Any
 * file that would push the running total over is skipped with a
 * note — keeps a malicious renderer from chaining 1000 ≤100-KiB
 * text files into a 100 MiB stdin prompt.
 */
export function inlineAttachments(paths: string[]): string {
  if (paths.length === 0) return '';
  const parts: string[] = ['[attachments]'];
  let runningBytes = 0;
  for (const p of paths) {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const kind = classifyExt(ext);
    if (kind !== 'text') {
      const note =
        kind === 'image'
          ? 'image — sent as a separate content block'
          : kind === 'document'
            ? 'PDF — sent as a separate document content block'
            : 'unsupported type';
      parts.push(`\n--- ${name} (skipped: ${note}) ---`);
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
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (runningBytes + contentBytes > MAX_TOTAL_INLINED_BYTES) {
      parts.push(
        `\n--- ${name} (skipped: cumulative inlined size would exceed ${(MAX_TOTAL_INLINED_BYTES / (1024 * 1024)).toFixed(0)} MiB cap) ---`,
      );
      continue;
    }
    runningBytes += contentBytes;
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
 * Same shape as ImageContentBlock — the difference is the content-block
 * type emitted on the wire ('document' instead of 'image'). Kept as a
 * separate interface so call sites can't accidentally cross the streams.
 */
export interface DocumentContentBlock {
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
 * Mirror of readImagesForApi for PDFs. Same shape, different output —
 * the runner caller emits these as `{type:'document'}` blocks instead
 * of `{type:'image'}`. Failures are dropped silently into the `skipped`
 * array; callers surface them as `warn` log lines so the user sees
 * what didn't make it.
 */
export function readDocumentsForApi(paths: string[]): {
  blocks: DocumentContentBlock[];
  skipped: { name: string; reason: string }[];
} {
  const blocks: DocumentContentBlock[] = [];
  const skipped: { name: string; reason: string }[] = [];
  for (const p of paths) {
    const name = path.basename(p);
    const ext = path.extname(p).toLowerCase();
    const mediaType = DOCUMENT_MEDIA_TYPES[ext];
    if (!mediaType) {
      skipped.push({ name, reason: `unsupported document type (${ext})` });
      continue;
    }
    try {
      const buf = fs.readFileSync(p);
      if (buf.length > MAX_DOCUMENT_BYTES) {
        const mib = (buf.length / (1024 * 1024)).toFixed(1);
        skipped.push({ name, reason: `PDF too large (${mib} MiB, cap 10 MiB)` });
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
 * images + PDFs for the API, and produces human-readable warn lines for
 * any file that didn't make it (oversize, unreadable, or sent to a
 * provider that doesn't support that kind). Callers emit `warnLines`
 * as `warn`-kind log entries so the user sees what was dropped.
 *
 * For codex, image AND document paths are dropped with a provider note
 * — codex exec has no equivalent vision/document inputs. Text
 * attachments still inline so the user's prompt isn't silently halved.
 */
export function prepareAttachments(
  paths: string[] | undefined,
  provider: 'claude' | 'codex',
): {
  textInline: string;
  images: ImageContentBlock[];
  documents: DocumentContentBlock[];
  warnLines: string[];
} {
  if (!paths || paths.length === 0) {
    return { textInline: '', images: [], documents: [], warnLines: [] };
  }

  const warnLines: string[] = [];

  // M3: cap attachment count per call. The picker dialog tops out
  // before this in practice, but a renderer driving the IPC
  // directly could pass an arbitrary list.
  let working = paths;
  if (working.length > MAX_ATTACHMENTS_PER_CALL) {
    const dropped = working.length - MAX_ATTACHMENTS_PER_CALL;
    working = working.slice(0, MAX_ATTACHMENTS_PER_CALL);
    warnLines.push(
      `${dropped} attachment${dropped === 1 ? '' : 's'} dropped — cap of ${MAX_ATTACHMENTS_PER_CALL} per call`,
    );
  }

  // M2: reject any path the user didn't surface via a picker/paste/
  // drop. Without this, a compromised renderer can pass arbitrary
  // local paths and get them inlined into the LLM prompt (i.e.
  // exfil). Allow-listed paths come from real user gestures only.
  const allowed: string[] = [];
  let denied = 0;
  for (const p of working) {
    if (isAttachmentAllowed(p)) {
      allowed.push(p);
    } else {
      denied += 1;
    }
  }
  if (denied > 0) {
    warnLines.push(
      `${denied} attachment${denied === 1 ? '' : 's'} rejected — path not in this session's allow-list (must be picked, pasted, or dropped via the composer)`,
    );
  }
  if (allowed.length === 0) {
    return { textInline: '', images: [], documents: [], warnLines };
  }

  const { textPaths, imagePaths, documentPaths } = splitAttachments(allowed);
  const textInline = textPaths.length > 0 ? inlineAttachments(textPaths) : '';
  let images: ImageContentBlock[] = [];
  let documents: DocumentContentBlock[] = [];

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

  if (documentPaths.length > 0) {
    if (provider === 'codex') {
      warnLines.push(
        `${documentPaths.length} PDF attachment${
          documentPaths.length === 1 ? '' : 's'
        } skipped — codex provider doesn't support document content blocks yet`,
      );
    } else {
      const { blocks, skipped } = readDocumentsForApi(documentPaths);
      documents = blocks;
      for (const s of skipped) {
        warnLines.push(`PDF ${s.name} skipped: ${s.reason}`);
      }
    }
  }

  return { textInline, images, documents, warnLines };
}

/**
 * Write a base64-encoded image (typically from a clipboard paste) to a
 * temp file under `tempDir` and return an AttachmentInfo describing it.
 * The downstream runner reads the same temp file and re-encodes for the
 * vision content block — slightly wasteful but keeps the pipeline
 * uniform with file-picker attachments. Temp files live for the OS to
 * clean up; for v0.7 we don't actively prune them.
 *
 * Returns an `ok: false` result (with a `reason`) for unsupported media
 * types, invalid base64, or oversized payloads.
 */
export function savePastedImage(
  tempDir: string,
  base64: string,
  mediaType: string,
): AttachmentInfo {
  const ext = MEDIA_TYPE_TO_EXT[mediaType.toLowerCase()];
  if (!ext) {
    return {
      path: '',
      name: 'pasted',
      ok: false,
      reason: `unsupported pasted image type: ${mediaType || '(empty)'}`,
    };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(base64, 'base64');
  } catch {
    return {
      path: '',
      name: `pasted${ext}`,
      ok: false,
      reason: 'invalid base64 payload',
      kind: 'image',
    };
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    const mib = (bytes.length / (1024 * 1024)).toFixed(1);
    return {
      path: '',
      name: `pasted${ext}`,
      ok: false,
      reason: `image too large (${mib} MiB, cap 5 MiB)`,
      kind: 'image',
    };
  }
  try {
    fs.mkdirSync(tempDir, { recursive: true });
  } catch (e) {
    return {
      path: '',
      name: `pasted${ext}`,
      ok: false,
      reason: e instanceof Error ? e.message : 'failed to create temp dir',
      kind: 'image',
    };
  }
  // Filename: pasted-2026-05-18_14-30-57.png. Sortable, collision-free
  // for one-paste-per-second; we add a short random suffix in case the
  // user pastes two images in the same second.
  const ts = new Date()
    .toISOString()
    .replace(/[:.]/g, '-')
    .replace('T', '_')
    .slice(0, 19);
  const suffix = Math.random().toString(36).slice(2, 6);
  const name = `pasted-${ts}-${suffix}${ext}`;
  const fullPath = path.join(tempDir, name);
  try {
    fs.writeFileSync(fullPath, bytes);
  } catch (e) {
    return {
      path: '',
      name,
      ok: false,
      reason: e instanceof Error ? e.message : 'write failed',
      kind: 'image',
    };
  }
  // describeAttachments re-stats the file we just wrote, which catches
  // any sneaky failure (zero-byte write, permission issue) and gives us
  // the same shape every other call site already handles. Override the
  // basename-derived `name` with a short, user-friendly label so the
  // chip in the UI reads as "screenshot.png" rather than a long unique
  // filename — keeps the chip compact and the × button findable.
  const info = describeAttachments([fullPath])[0];
  return { ...info, name: `screenshot${ext}` };
}

/**
 * Best-effort delete of a file inside our managed paste-temp subdir.
 * Refuses to touch anything outside `tempDir` so a renderer that calls
 * this for every chip removal can't accidentally delete a picked file
 * the user actually owns. Silent on missing-file / permission failures —
 * the OS's eventual %TEMP% reap is our fallback.
 *
 * M2: realpath-resolves both sides of the containment check so a
 * junction inside %TEMP% can't redirect the unlink to a file
 * outside the managed dir. If either side fails to resolve, refuse
 * the delete.
 *
 * Returns true if a delete attempt was made; false if the path was
 * outside the managed dir (i.e. not ours to delete).
 */
export function disposePastedFile(tempDir: string, target: string): boolean {
  if (!target) return false;
  // We need realpath of both. The paste-temp dir always exists
  // (we mkdirSync on first save), so realpath should succeed. The
  // target may already be gone — if so, refuse.
  let parentReal: string;
  let childReal: string;
  try {
    parentReal = fs.realpathSync(tempDir);
    childReal = fs.realpathSync(target);
  } catch {
    return false;
  }
  const isWin = process.platform === 'win32';
  const sep = path.sep;
  const inside = isWin
    ? childReal.toLowerCase().startsWith(parentReal.toLowerCase() + sep)
    : childReal.startsWith(parentReal + sep);
  if (!inside) return false;
  try {
    fs.unlinkSync(childReal);
  } catch {
    /* already gone, permission denied, etc. — best-effort */
  }
  return true;
}

/**
 * Read an image attachment off disk and return it as a `data:` URL the
 * renderer can stuff straight into an `<img>` tag. Refuses anything
 * outside the image extension whitelist so this can't be used to
 * exfiltrate arbitrary file contents to the renderer. Returns an empty
 * string for missing / oversize / unreadable / non-image paths — the
 * UI treats that as "show the generic icon instead".
 */
export function readAttachmentAsDataUrl(absPath: string): string {
  try {
    if (!absPath) return '';
    const ext = path.extname(absPath).toLowerCase();
    const mediaType = IMAGE_MEDIA_TYPES[ext];
    if (!mediaType) return '';
    if (!fs.existsSync(absPath)) return '';
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return '';
    if (stat.size > MAX_IMAGE_BYTES) return '';
    const buf = fs.readFileSync(absPath);
    return `data:${mediaType};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/**
 * One-shot sweep used at app startup to drop any pasted-image files
 * left behind from previous sessions. Files are non-sensitive once their
 * agent run has completed, so a wholesale wipe is fine and keeps the
 * temp dir from accumulating across long stretches of use. Errors are
 * swallowed — startup must never fail because of cleanup hygiene.
 */
export function cleanupPastedImagesAtStart(tempDir: string): void {
  try {
    if (!fs.existsSync(tempDir)) return;
    for (const entry of fs.readdirSync(tempDir)) {
      try {
        fs.unlinkSync(path.join(tempDir, entry));
      } catch {
        /* ignore individual failures */
      }
    }
  } catch {
    /* ignore — sweep is best-effort */
  }
}
