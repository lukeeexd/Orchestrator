import type { LogLine, ToolCall } from '../../shared/types';

export function nowTs(): string {
  const d = new Date();
  const h = d.getHours().toString().padStart(2, '0');
  const m = d.getMinutes().toString().padStart(2, '0');
  const s = d.getSeconds().toString().padStart(2, '0');
  const ms = d.getMilliseconds().toString().padStart(3, '0');
  return `${h}:${m}:${s}.${ms}`;
}

const MAX_ARG_LEN = 200;

function truncate(v: string): string {
  if (v.length <= MAX_ARG_LEN) return v;
  return v.slice(0, MAX_ARG_LEN) + '…';
}

function toToolCall(name: string, input: unknown): ToolCall {
  if (input == null || typeof input !== 'object') {
    return { fn: name, args: [] };
  }
  const args = Object.entries(input as Record<string, unknown>).map(([k, v]) => ({
    k,
    v: truncate(typeof v === 'string' ? v : JSON.stringify(v)),
  }));
  return { fn: name, args };
}

function stringifyResult(content: unknown): string {
  if (typeof content === 'string') return truncate(content);
  if (Array.isArray(content)) {
    // Content blocks from tool_result: extract text blocks, summarise binary
    const parts = content
      .map((b) => {
        if (b && typeof b === 'object' && 'type' in b) {
          const block = b as { type: string; text?: string };
          if (block.type === 'text' && typeof block.text === 'string') {
            return block.text;
          }
          return `[${block.type}]`;
        }
        return JSON.stringify(b);
      })
      .join(' ');
    return truncate(parts);
  }
  return truncate(JSON.stringify(content));
}

/**
 * Convert one SDKMessage into zero or more LogLines per the design's 7 kinds.
 */
export function classify(event: unknown): LogLine[] {
  if (event == null || typeof event !== 'object' || !('type' in event)) return [];
  const ev = event as { type: string; [k: string]: unknown };
  const lines: LogLine[] = [];

  if (ev.type === 'assistant') {
    const message = ev.message as { content?: unknown[] } | undefined;
    const blocks = message?.content ?? [];
    for (const raw of blocks) {
      if (raw == null || typeof raw !== 'object' || !('type' in raw)) continue;
      const block = raw as { type: string; text?: string; name?: string; input?: unknown };
      if (block.type === 'text' && typeof block.text === 'string') {
        const text = block.text.trim();
        if (text) lines.push({ ts: nowTs(), kind: 'thought', msg: text });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        lines.push({
          ts: nowTs(),
          kind: 'tool',
          msg: toToolCall(block.name, block.input),
        });
      }
    }
    if (ev.error) {
      lines.push({
        ts: nowTs(),
        kind: 'error',
        msg: `assistant error: ${String(ev.error)}`,
      });
    }
  } else if (ev.type === 'user') {
    const message = ev.message as { content?: unknown[] } | undefined;
    const blocks = message?.content ?? [];
    for (const raw of blocks) {
      if (raw == null || typeof raw !== 'object' || !('type' in raw)) continue;
      const block = raw as { type: string; content?: unknown; is_error?: boolean };
      if (block.type === 'tool_result') {
        const kind = block.is_error ? 'warn' : 'result';
        lines.push({
          ts: nowTs(),
          kind,
          msg: stringifyResult(block.content),
        });
      }
    }
  }

  return lines;
}
