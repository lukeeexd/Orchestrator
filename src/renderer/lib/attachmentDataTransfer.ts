import type { ClipboardEvent, DragEvent } from 'react';
import type { PastedImageInfo } from '../../shared/ipc';

/**
 * Read a Blob into a base64 string (no `data:` prefix). Used for image
 * blobs that came over the clipboard or as in-memory drops — we don't
 * have a real disk path for those, so we save them to a temp file via
 * the savePastedImage IPC.
 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () =>
      reject(new Error('failed to read attachment blob'));
    reader.readAsDataURL(blob);
  });
}

type CollectedItem =
  | { kind: 'image-blob'; blob: Blob; mediaType: string; name: string }
  | { kind: 'file-path'; file: File };

/**
 * Walk a DataTransfer (works for both ClipboardEvent.clipboardData and
 * DragEvent.dataTransfer — they expose the same interface) and split
 * the contained files into two routes:
 *
 *   - image MIME types → keep the blob in memory; we'll save it to a
 *     temp file via the savePastedImage IPC (paste from screenshot tools
 *     and browser drags that don't have a real disk path go here).
 *   - everything else → keep the File reference; we'll resolve the disk
 *     path via webUtils.getPathForFile in the preload, then validate
 *     through describeAttachmentPaths.
 *
 * Non-file items (text, urls) are ignored — the caller falls through to
 * the textarea's default paste/drop behaviour for those.
 */
function collectItems(data: DataTransfer | null): CollectedItem[] {
  if (!data) return [];
  const items = data.items;
  if (!items) return [];
  const out: CollectedItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (item.type.startsWith('image/')) {
      out.push({
        kind: 'image-blob',
        blob: file,
        mediaType: item.type,
        name: file.name,
      });
    } else {
      out.push({ kind: 'file-path', file });
    }
  }
  return out;
}

async function processItems(
  items: CollectedItem[],
  onAttached: (info: PastedImageInfo) => void,
): Promise<void> {
  // Image blobs: base64 → main → temp file → AttachmentInfo. Same path
  // as before, just routed through this collector.
  for (const it of items) {
    if (it.kind !== 'image-blob') continue;
    try {
      const base64 = await blobToBase64(it.blob);
      const info = await window.api.savePastedImage(base64, it.mediaType);
      onAttached(info);
    } catch (err) {
      onAttached({
        path: '',
        name: it.name || 'pasted',
        ok: false,
        reason: err instanceof Error ? err.message : 'paste/drop failed',
      });
    }
  }

  // File-path items: resolve each via webUtils.getPathForFile (sync,
  // preload-side), batch-validate through describeAttachmentPaths.
  // Paths that the preload returns empty for (in-memory blobs, browser
  // drags without a backing file) chip-as-bad so the user sees them.
  const resolvedPaths: string[] = [];
  for (const it of items) {
    if (it.kind !== 'file-path') continue;
    try {
      const p = window.api.getDroppedFilePath(it.file);
      if (p && p.length > 0) {
        resolvedPaths.push(p);
      } else {
        onAttached({
          path: '',
          name: it.file.name || 'dropped file',
          ok: false,
          reason: 'no disk path — drop a saved file, not a browser preview',
        });
      }
    } catch (err) {
      onAttached({
        path: '',
        name: it.file.name || 'dropped file',
        ok: false,
        reason: err instanceof Error ? err.message : 'drop failed',
      });
    }
  }
  if (resolvedPaths.length > 0) {
    try {
      const infos = await window.api.describeAttachmentPaths(resolvedPaths);
      for (const info of infos) onAttached(info);
    } catch (err) {
      // Fallback: emit one bad chip per path so the user isn't left
      // wondering where their drop went.
      const reason = err instanceof Error ? err.message : 'describe failed';
      for (const p of resolvedPaths) {
        onAttached({
          path: p,
          name: p.split(/[/\\]/).pop() || p,
          ok: false,
          reason,
        });
      }
    }
  }
}

/**
 * Paste-event handler. Image blobs save to temp; other file types
 * resolve via webUtils path. Both flows funnel into the same
 * `onAttached` callback. Returns true if any file item was handled
 * (and preventDefault fired) so the caller knows the textarea's
 * default text-paste was suppressed; false for plain text pastes.
 */
export async function handleAttachmentPaste(
  e: ClipboardEvent<HTMLTextAreaElement>,
  onAttached: (info: PastedImageInfo) => void,
): Promise<boolean> {
  const items = collectItems(e.clipboardData);
  if (items.length === 0) return false;
  e.preventDefault();
  await processItems(items, onAttached);
  return true;
}

/**
 * Drop-event handler. Same routing as paste — pair with
 * onDragOver={(e) => e.preventDefault()} so the browser allows the drop
 * in the first place.
 */
export async function handleAttachmentDrop(
  e: DragEvent<HTMLTextAreaElement>,
  onAttached: (info: PastedImageInfo) => void,
): Promise<boolean> {
  const items = collectItems(e.dataTransfer);
  if (items.length === 0) return false;
  e.preventDefault();
  await processItems(items, onAttached);
  return true;
}
