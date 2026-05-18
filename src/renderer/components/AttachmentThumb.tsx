import { useEffect, useState } from 'react';
import { Icon } from './Icon';

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

function isImagePath(p: string): boolean {
  const ext = p.toLowerCase().split('.').pop();
  return !!ext && IMAGE_EXTS.has(ext);
}

/**
 * Tiny inline thumbnail for an attachment chip. For image paths we ask
 * main to base64-encode the file and render it as `<img src=data:...>`;
 * for everything else (text, PDF, paths that have been swept off disk)
 * we fall back to the generic attach icon. Same dimensions either way
 * so the chip layout doesn't reflow when the thumbnail loads.
 */
export function AttachmentThumb({ path }: { path: string }) {
  const wantImage = isImagePath(path);
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    if (!wantImage || !path) {
      setSrc(null);
      return;
    }
    let cancelled = false;
    void window.api.readAttachmentThumb(path).then((url) => {
      if (!cancelled) setSrc(url || null);
    });
    return () => {
      cancelled = true;
    };
  }, [path, wantImage]);

  if (!src) return <Icon name="attach" size={10} />;
  return (
    <img
      src={src}
      alt=""
      style={{
        width: 14,
        height: 14,
        objectFit: 'cover',
        borderRadius: 2,
        verticalAlign: 'middle',
        flexShrink: 0,
      }}
    />
  );
}
