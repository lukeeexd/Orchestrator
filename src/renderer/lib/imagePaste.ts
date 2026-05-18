import type { ClipboardEvent, DragEvent } from 'react';
import type { PastedImageInfo } from '../../shared/ipc';

/**
 * Read a clipboard Blob into a base64 string (no `data:` prefix). Uses
 * FileReader so we don't need a Node-side Buffer polyfill in the renderer.
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
      reject(new Error('failed to read pasted image blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Pull every image File out of a DataTransfer-shaped source (works for
 * both ClipboardEvent.clipboardData and DragEvent.dataTransfer — they
 * expose the same DataTransfer interface).
 */
function extractImageFiles(
  data: DataTransfer | null,
): { blob: Blob; mediaType: string }[] {
  if (!data) return [];
  const items = data.items;
  if (!items) return [];
  const out: { blob: Blob; mediaType: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) out.push({ blob: file, mediaType: item.type });
    }
  }
  return out;
}

async function saveAll(
  blobs: { blob: Blob; mediaType: string }[],
  onAttached: (info: PastedImageInfo) => void,
): Promise<void> {
  for (const { blob, mediaType } of blobs) {
    try {
      const base64 = await blobToBase64(blob);
      const info = await window.api.savePastedImage(base64, mediaType);
      onAttached(info);
    } catch (err) {
      onAttached({
        path: '',
        name: 'pasted',
        ok: false,
        reason: err instanceof Error ? err.message : 'paste failed',
      });
    }
  }
}

/**
 * Paste-event handler for any textarea that wants to accept pasted
 * images as attachments. When the clipboard contains image files,
 * intercept the paste, save each image to a temp file via main, and
 * invoke `onAttached` once per image with the resulting AttachmentInfo.
 * Returns true if at least one image was handled (so the caller knows
 * to skip the default text paste). Plain-text pastes return false and
 * fall through to the textarea's default behaviour untouched.
 */
export async function handleImagePaste(
  e: ClipboardEvent<HTMLTextAreaElement>,
  onAttached: (info: PastedImageInfo) => void,
): Promise<boolean> {
  const blobs = extractImageFiles(e.clipboardData);
  if (blobs.length === 0) return false;
  e.preventDefault();
  await saveAll(blobs, onAttached);
  return true;
}

/**
 * Drop-event handler for the same textareas. Mirrors handleImagePaste
 * for image files dragged onto the field — pairs naturally with
 * onDragOver={(e) => e.preventDefault()} so the browser allows the drop.
 * Non-image drops fall through (handler returns false without
 * preventDefault).
 */
export async function handleImageDrop(
  e: DragEvent<HTMLTextAreaElement>,
  onAttached: (info: PastedImageInfo) => void,
): Promise<boolean> {
  const blobs = extractImageFiles(e.dataTransfer);
  if (blobs.length === 0) return false;
  e.preventDefault();
  await saveAll(blobs, onAttached);
  return true;
}
