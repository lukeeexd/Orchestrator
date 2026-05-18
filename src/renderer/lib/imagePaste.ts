import type { ClipboardEvent } from 'react';
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
  const items = e.clipboardData?.items;
  if (!items) return false;
  const blobs: { blob: Blob; mediaType: string }[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const file = item.getAsFile();
      if (file) blobs.push({ blob: file, mediaType: item.type });
    }
  }
  if (blobs.length === 0) return false;
  e.preventDefault();
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
  return true;
}
