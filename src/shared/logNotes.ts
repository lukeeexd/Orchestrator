import type { LogLine, ToolCall } from './types';

/**
 * F12: stable per-log-line key. Notes are pinned to this hash so
 * they survive log re-hydration (the same line content always maps
 * to the same key) without depending on positional `seq` numbers
 * that could shift if logs were ever back-edited / replayed.
 *
 * Hash function: FNV-1a 32-bit, hex-encoded. Pure JS (no node:crypto
 * import) so this file stays renderer-safe per LAYERS.md. Collision
 * space per (agent, log) is small enough (~2000 lines) that 32-bit
 * is overkill statistically — birthday-bound is ~77k lines before a
 * single collision becomes likely. We layer the agent_id as a
 * row-level discriminator at the DB level so cross-agent collisions
 * don't matter.
 *
 * Hashed content: ts + '\x00' + kind + '\x00' + msg-serialised.
 * Tool calls collapse to `<fn>(<k>=<v>,...)` so the same tool call
 * with the same args always hashes the same way regardless of object
 * identity.
 */

const FNV_PRIME = 0x01000193;
const FNV_OFFSET = 0x811c9dc5;

function fnv1aHex(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Use Math.imul for 32-bit signed multiplication so the result
    // wraps the same way on every JS engine.
    hash = Math.imul(hash, FNV_PRIME);
  }
  // >>> 0 forces unsigned 32-bit, then 8-char hex pad.
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function serializeToolCall(t: ToolCall): string {
  // Sort args by key so the same logical call hashes the same way
  // regardless of arg insertion order. Stable separators (no quotes
  // around values) keep the hash deterministic.
  const sorted = t.args.slice().sort((a, b) => a.k.localeCompare(b.k));
  const argsPart = sorted.map((a) => `${a.k}=${a.v}`).join(',');
  return `${t.fn}(${argsPart})`;
}

export function computeLogLineKey(line: LogLine): string {
  const msgPart =
    typeof line.msg === 'string' ? line.msg : serializeToolCall(line.msg);
  return fnv1aHex(`${line.ts}\x00${line.kind}\x00${msgPart}`);
}
