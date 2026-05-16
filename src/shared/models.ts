/**
 * Canonical model ids the UI offers in dropdowns. The list is shared
 * between the Settings screen, the Director pane, the spawn form, and
 * the Drawer's redirect form so the user gets consistent options.
 *
 * Custom values typed into settings.json (or saved by older app
 * versions) are preserved at runtime — the pickers add them as a
 * "(custom)" entry rather than silently dropping them.
 */
export const KNOWN_MODELS: readonly string[] = [
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
];
