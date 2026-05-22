import { describe, it, expect } from 'vitest';
import {
  encodeWorkspacePath,
  parseMemoryIndex,
  parseMemoryFile,
} from '../../src/main/claudeCodeMemory';

describe('encodeWorkspacePath', () => {
  it('encodes a Windows drive path with --', () => {
    expect(encodeWorkspacePath('D:\\ClaudeCode\\orchestrator')).toBe(
      'D--ClaudeCode-orchestrator',
    );
  });

  it('encodes a nested Windows path', () => {
    expect(
      encodeWorkspacePath('C:\\Users\\Luke\\Projects\\my-app'),
    ).toBe('C--Users-Luke-Projects-my-app');
  });

  it('handles mixed slashes (forward and back)', () => {
    expect(encodeWorkspacePath('D:/ClaudeCode/orchestrator')).toBe(
      'D--ClaudeCode-orchestrator',
    );
  });

  it('encodes a POSIX path', () => {
    expect(encodeWorkspacePath('/home/luke/projects/foo')).toBe(
      'home-luke-projects-foo',
    );
  });
});

describe('parseMemoryIndex', () => {
  it('extracts every .md target from a typical index', () => {
    const index = `# Memory index

## Project — Orchestrator
- [Project overview](project_overview.md) — Electron desktop app
- [Public repo](repo_public.md) — \`lukeeexd/Orchestrator\`, v0.17.0
- [Auto-update](auto_update.md) — polls update.electronjs.org

## Feedback
- [Don't push main](feedback_no_push_main.md) — explicit instruction required
`;
    const refs = parseMemoryIndex(index);
    expect(refs).toEqual([
      'project_overview.md',
      'repo_public.md',
      'auto_update.md',
      'feedback_no_push_main.md',
    ]);
  });

  it('skips external URLs and absolute paths', () => {
    const index = `
- [GitHub](https://github.com/foo.md)
- [Absolute](/etc/passwd.md)
- [Relative](real.md)
`;
    expect(parseMemoryIndex(index)).toEqual(['real.md']);
  });

  it('skips the index itself if linked', () => {
    expect(parseMemoryIndex('- [Index](MEMORY.md)')).toEqual([]);
  });

  it('returns empty for an empty / link-free index', () => {
    expect(parseMemoryIndex('')).toEqual([]);
    expect(parseMemoryIndex('# Just a heading')).toEqual([]);
  });
});

describe('parseMemoryFile', () => {
  it('extracts type from nested metadata block', () => {
    const raw = `---
name: foo
description: bar
metadata:
  node_type: memory
  type: project
  originSessionId: abc-123
---

The body of the memory.`;
    const r = parseMemoryFile(raw);
    expect(r.type).toBe('project');
    expect(r.body).toBe('The body of the memory.');
  });

  it('extracts type from a flat type: field', () => {
    const raw = `---
name: foo
type: reference
description: bar
---
Body here.`;
    const r = parseMemoryFile(raw);
    expect(r.type).toBe('reference');
    expect(r.body).toBe('Body here.');
  });

  it('returns null type when frontmatter has no recognised type', () => {
    const raw = `---
name: foo
description: bar
---
Body.`;
    const r = parseMemoryFile(raw);
    expect(r.type).toBeNull();
  });

  it('returns null type when no frontmatter at all', () => {
    const r = parseMemoryFile('Just body text, no frontmatter');
    expect(r.type).toBeNull();
    expect(r.body).toBe('Just body text, no frontmatter');
  });

  it('handles all four valid type values', () => {
    for (const t of ['user', 'feedback', 'project', 'reference']) {
      const raw = `---\nmetadata:\n  type: ${t}\n---\nbody`;
      expect(parseMemoryFile(raw).type).toBe(t);
    }
  });

  it('rejects unrecognised type values', () => {
    const raw = `---\nmetadata:\n  type: bogus\n---\nbody`;
    expect(parseMemoryFile(raw).type).toBeNull();
  });
});
