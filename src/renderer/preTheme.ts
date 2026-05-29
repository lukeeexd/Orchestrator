// Sets data-theme on <html> BEFORE first paint so launching in dark mode
// doesn't flash a light frame. This is only the boot guess (matches the OS);
// useTheme applies the real persisted choice once settings load. A module
// imported first in index.tsx — not an inline <script> — because the page CSP
// is script-src 'self'.
const prefersDark =
  typeof window !== 'undefined' &&
  !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
document.documentElement.setAttribute('data-theme', prefersDark ? 'dark' : 'light');

export {};
