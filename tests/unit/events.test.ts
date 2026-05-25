import { describe, it, expect } from 'vitest';
import { EventKinds, ALL_EVENT_KINDS } from '../../src/shared/events';

describe('EventKinds enum', () => {
  it('all values are dot-namespaced strings', () => {
    for (const value of Object.values(EventKinds)) {
      expect(typeof value).toBe('string');
      expect(value).toMatch(/^[a-z]+\.[a-z_]+$/);
    }
  });

  it('exposes the agent lifecycle kinds', () => {
    expect(EventKinds.AgentSpawn).toBe('agent.spawn');
    expect(EventKinds.AgentPatch).toBe('agent.patch');
    expect(EventKinds.AgentLog).toBe('agent.log');
    expect(EventKinds.AgentDelete).toBe('agent.delete');
    expect(EventKinds.AgentHandoff).toBe('agent.handoff');
    expect(EventKinds.AgentRedirect).toBe('agent.redirect');
    expect(EventKinds.AgentFork).toBe('agent.fork');
  });

  it('exposes Director + note kinds', () => {
    expect(EventKinds.DirectorMessage).toBe('director.message');
    expect(EventKinds.DirectorMessagePatch).toBe('director.message_patch');
    expect(EventKinds.DirectorPlanAccepted).toBe('director.plan_accepted');
    expect(EventKinds.DirectorWipe).toBe('director.wipe');
    expect(EventKinds.NoteSet).toBe('note.set');
    expect(EventKinds.NoteDelete).toBe('note.delete');
  });

  it('keeps every kind unique', () => {
    const values = Object.values(EventKinds);
    const set = new Set(values);
    expect(set.size).toBe(values.length);
  });

  it('ALL_EVENT_KINDS contains every value', () => {
    for (const v of Object.values(EventKinds)) {
      expect(ALL_EVENT_KINDS.has(v)).toBe(true);
    }
    expect(ALL_EVENT_KINDS.size).toBe(Object.values(EventKinds).length);
  });
});
