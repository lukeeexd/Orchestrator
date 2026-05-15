import { useEffect, useState } from 'react';
import type { Settings } from '../../shared/ipc';

export function useSettings(): Settings | null {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let mounted = true;
    window.api.getSettings().then((s) => {
      if (mounted) setSettings(s);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return settings;
}
