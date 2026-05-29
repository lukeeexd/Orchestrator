import { useEffect, useState } from 'react';
import { useSettings } from './useSettings';

type Resolved = 'light' | 'dark';

/**
 * Resolves the effective theme from `settings.theme` ('light' | 'dark' |
 * 'system') and applies it as `data-theme` on <html>. While in 'system' it
 * tracks the OS prefers-color-scheme live (flipping the Windows theme
 * re-themes instantly, no save). Returns the resolved 'light' | 'dark' so
 * callers (e.g. the canvas) can key JS colours off it.
 *
 * `settings?.theme ?? 'system'` is undefined-defensive: a settings.json that
 * predates the `theme` key resolves to 'system' rather than crashing.
 */
export function useTheme(): Resolved {
  const { settings } = useSettings();
  const mode = settings?.theme ?? 'system';

  const [systemDark, setSystemDark] = useState<boolean>(() =>
    typeof window !== 'undefined'
      ? !!window.matchMedia?.('(prefers-color-scheme: dark)').matches
      : false,
  );

  // Only listen to OS changes while we're actually following the system.
  useEffect(() => {
    if (mode !== 'system') return;
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    setSystemDark(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [mode]);

  const resolved: Resolved =
    mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', resolved);
  }, [resolved]);

  return resolved;
}
