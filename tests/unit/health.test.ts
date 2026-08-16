import { describe, expect, it } from 'vitest';
import { ReadinessState } from '../../src/health.js';

function readyExcept(): ReadinessState {
  const readiness = new ReadinessState();
  for (const component of ['configuration', 'database', 'claude', 'mcp', 'discord'] as const) {
    readiness.set(component, 'ready');
  }
  return readiness;
}

describe('ReadinessState', () => {
  it('starts unready while components are still starting', () => {
    expect(new ReadinessState().isReady()).toBe(false);
  });

  it('is ready once every component reports ready', () => {
    expect(readyExcept().isReady()).toBe(true);
  });

  it('treats a disabled component as satisfied but keeps it visible', () => {
    const readiness = readyExcept();
    readiness.set('mcp', 'disabled');
    expect(readiness.isReady()).toBe(true);
    expect(readiness.summary()).toContain('mcp: disabled');
  });

  it.each(['unhealthy', 'stopped', 'starting'] as const)('stays unready when %s', (status) => {
    const readiness = readyExcept();
    readiness.set('mcp', status);
    expect(readiness.isReady()).toBe(false);
  });
});
