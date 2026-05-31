import { scrubSecrets } from './secretScrubber';
import { stripOrchestratorFences } from './sanitize';
import type { BlackboardEntry } from '../shared/types';

/**
 * N6 — formats the run-scoped blackboard into a compact, size-bounded prose
 * digest that gets injected into a later agent's spawn prompt, so the chain
 * builds on prior work instead of rediscovering it.
 *
 * Kept PURE (no DB / Electron — only types + the regex-only secretScrubber) so
 * it unit-tests without mocks, per the project's test convention. The DB-backed
 * wrapper that resolves the active run lives in `blackboard.buildInjectionDigest`.
 */

/** Most-recent entries shown (oldest-first within the window). */
const DIGEST_MAX_ENTRIES = 8;
/** Per-entry summary cap (chars). */
const DIGEST_SUMMARY_MAX = 160;
/** How many file paths to list before collapsing to a count. */
const DIGEST_FILES_SHOWN = 5;
/** Hard ceiling on the whole block so a chatty run can't blow out context. */
const DIGEST_TOTAL_MAX = 2500;

function truncate(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}

/**
 * Render `entries` (oldest-first, as `listEntries` returns them) into the
 * injection block. Returns '' for no entries. Shows the most-recent
 * DIGEST_MAX_ENTRIES, truncates each summary, secret-scrubs the whole block,
 * and hard-caps the total length.
 */
export function formatRunDigest(entries: BlackboardEntry[]): string {
  if (entries.length === 0) return '';
  const shown = entries.slice(-DIGEST_MAX_ENTRIES);
  const lines = shown.map((e) => {
    const files =
      e.filesTouched.length > 0
        ? `${e.filesTouched.length} file${
            e.filesTouched.length === 1 ? '' : 's'
          } (${e.filesTouched.slice(0, DIGEST_FILES_SHOWN).join(', ')}${
            e.filesTouched.length > DIGEST_FILES_SHOWN ? ', …' : ''
          })`
        : 'no files';
    const tests = e.testsRun
      ? `tests ${e.testsRun.pass}✓/${e.testsRun.fail}✗`
      : null;
    const errs =
      e.errors.length > 0
        ? `${e.errors.length} error${e.errors.length === 1 ? '' : 's'}`
        : null;
    const facts = [files, tests, errs].filter(Boolean).join(', ');
    // Strip orchestrator-* fences from the raw summary BEFORE truncate (which
    // collapses newlines) — the fence regex needs the newlines intact to match.
    const summary = e.summary
      ? ` — ${truncate(stripOrchestratorFences(e.summary), DIGEST_SUMMARY_MAX)}`
      : '';
    return `- @${e.agentName} (${e.role}): ${facts}${summary}`;
  });
  const block = [
    '## Prior steps in this run',
    'Earlier agents in this run already ran (most recent last). Build on their results — review what they changed and any failing tests, and avoid redoing work that is already done:',
    '',
    ...lines,
  ].join('\n');
  // Redact secrets across the whole block BEFORE length-capping (so a secret
  // near the boundary is already masked, not half-truncated past the env
  // pattern). scrubSecrets' patterns are single-line, so they still match after
  // truncate() collapsed each summary's whitespace. Reserve the footer's length
  // so the result stays at or under DIGEST_TOTAL_MAX. (Fence-stripping already
  // ran per-summary above, while newlines were intact.)
  const safe = scrubSecrets(block);
  const FOOTER = '\n…[older steps omitted]';
  return safe.length > DIGEST_TOTAL_MAX
    ? safe.slice(0, DIGEST_TOTAL_MAX - FOOTER.length) + FOOTER
    : safe;
}
