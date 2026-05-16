import { useCallback, useEffect, useState } from 'react';
import type { Settings } from '../../shared/ipc';

interface UseSettingsResult {
  settings: Settings | null;
  save: (next: Partial<Settings>) => Promise<Settings>;
}

/**
 * Subscribes to the settings:event:changed broadcast so anything reading
 * settings stays in sync after a save from the Settings screen.
 */
export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    let mounted = true;
    window.api.getSettings().then((s) => {
      if (mounted) setSettings(s);
    });
    const off = window.api.onSettingsChanged((next) => {
      setSettings(next);
    });
    return () => {
      mounted = false;
      off();
    };
  }, []);

  const save = useCallback(async (next: Partial<Settings>) => {
    const merged = await window.api.setSettings(next);
    setSettings(merged);
    return merged;
  }, []);

  return { settings, save };
}
