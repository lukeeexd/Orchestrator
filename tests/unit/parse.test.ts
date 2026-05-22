import { describe, it, expect } from 'vitest';
import { extractDirectives } from '../../src/main/director/parse';

describe('extractDirectives — plan', () => {
  it('parses a valid plan block and strips it from the body', () => {
    const body = `Here's the plan:\n\n\`\`\`orchestrator-plan\n[{"i":1,"role":"coder","name":"alpha","task":"do the thing"}]\n\`\`\`\n\nReady when you are.`;
    const r = extractDirectives(body);
    expect(r.plan).toEqual([
      { i: 1, role: 'coder', name: 'alpha', task: 'do the thing' },
    ]);
    expect(r.text).not.toMatch(/orchestrator-plan/);
    expect(r.text).toMatch(/Ready when you are\./);
  });

  it('rejects unknown roles silently', () => {
    const body = `\`\`\`orchestrator-plan\n[{"i":1,"role":"wizard","name":"x","task":"y"}]\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.plan).toBeNull();
  });

  it('drops unknown provider overrides instead of passing them through', () => {
    const body = `\`\`\`orchestrator-plan\n[{"i":1,"role":"pm","name":"x","task":"y","provider":"openai"}]\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.plan).toEqual([{ i: 1, role: 'pm', name: 'x', task: 'y' }]);
  });
});

describe('extractDirectives — redirect', () => {
  it('parses a valid redirect block', () => {
    const body = `\`\`\`orchestrator-redirect\n{"agent":"alpha","instruction":"focus on tests"}\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.redirect).toEqual({ agent: 'alpha', instruction: 'focus on tests' });
  });

  it('rejects empty fields', () => {
    const body = `\`\`\`orchestrator-redirect\n{"agent":"","instruction":"x"}\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.redirect).toBeNull();
  });
});

describe('extractDirectives — prd (R-A5 regression)', () => {
  it('parses a PRD with problem + at least one populated section', () => {
    const body = `\`\`\`orchestrator-prd\n${JSON.stringify({
      title: 'Title',
      problem: 'Solve X',
      goals: ['Ship the feature'],
      non_goals: [],
      constraints: [],
      open_questions: [],
    })}\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.prd).not.toBeNull();
    expect(r.prd?.problem).toBe('Solve X');
    expect(r.prd?.goals).toEqual(['Ship the feature']);
    expect(r.prd?.title).toBe('Title');
  });

  it('rejects a PRD with problem-only and ALL four section arrays empty (R-A5)', () => {
    const body = `\`\`\`orchestrator-prd\n${JSON.stringify({
      problem: 'Solve X',
      goals: [],
      non_goals: [],
      constraints: [],
      open_questions: [],
    })}\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.prd).toBeNull();
  });

  it('rejects a PRD with no problem', () => {
    const body = `\`\`\`orchestrator-prd\n${JSON.stringify({
      problem: '',
      goals: ['x'],
    })}\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.prd).toBeNull();
  });

  it('drops non-string array entries silently', () => {
    const body = `\`\`\`orchestrator-prd\n${JSON.stringify({
      problem: 'P',
      goals: ['ok', 42, '', null, '  '],
    })}\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.prd?.goals).toEqual(['ok']);
  });
});

describe('extractDirectives — combined / malformed', () => {
  it('returns nulls for body with no fences', () => {
    const r = extractDirectives('just talking, no fences');
    expect(r.plan).toBeNull();
    expect(r.redirect).toBeNull();
    expect(r.prd).toBeNull();
    expect(r.text).toBe('just talking, no fences');
  });

  it('handles malformed JSON inside a fence by leaving the block in place', () => {
    const body = `\`\`\`orchestrator-plan\nnot-json\n\`\`\``;
    const r = extractDirectives(body);
    expect(r.plan).toBeNull();
    // Body retained verbatim — the fence isn't stripped when parse fails.
    expect(r.text).toMatch(/orchestrator-plan/);
  });
});
