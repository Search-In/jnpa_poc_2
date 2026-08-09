/**
 * SimAdapter is the OUTERMOST decorator — every panel holds it, never the
 * adapter it wraps. It re-declares each method by hand, so a capability added
 * to the inner Poc3CargoAdapter is invisible to the UI until it is forwarded
 * here. That is not theoretical: the JNPA Port-Data feed card shipped reporting
 * "no backend connected" in every mode because these three were missing.
 *
 * These tests pin BOTH directions, since only both together are the contract:
 * present when the base can serve it, ABSENT when it cannot. A forwarded method
 * that always exists and rejects would make a mock build look like a live
 * backend that is broken.
 */
import { describe, expect, it } from 'vitest';
import type { DataAdapter, JnpaApiHealth } from '@jnpa/data';
import { SimAdapter } from '../src/sim/SimAdapter.js';

const HEALTH: JnpaApiHealth = {
  configured: true,
  mode: 'LIVE',
  api_url: 'https://dt.jnpa.in/poc-api-data-access',
  groups: [{ group: 'customs', kind: 'indexed', watermark_ts: null, last_status: 'OK', updated_at: null }],
};

/** A stand-in base with only the members these tests exercise. */
function baseWith(extra: Partial<DataAdapter>): DataAdapter {
  return { mode: 'mock', ...extra } as unknown as DataAdapter;
}

describe('SimAdapter — JNPA feed delegation preserves capability', () => {
  it('exposes the feed methods when the wrapped adapter has them', async () => {
    const sim = new SimAdapter(baseWith({
      getJnpaApiHealth: async () => HEALTH,
      getJnpaApiRuns: async () => [],
      getJnpaApiDefects: async () => [],
    }));

    expect(typeof sim.getJnpaApiHealth).toBe('function');
    expect(typeof sim.getJnpaApiRuns).toBe('function');
    expect(typeof sim.getJnpaApiDefects).toBe('function');
    await expect(sim.getJnpaApiHealth!()).resolves.toEqual(HEALTH);
  });

  it('leaves them ABSENT when the wrapped adapter cannot serve them', () => {
    const sim = new SimAdapter(baseWith({}));

    // Not "present but throwing" — the panel branches on existence, so absence
    // is what tells it there is no poller rather than a failing one.
    expect(typeof sim.getJnpaApiHealth).not.toBe('function');
    expect(typeof sim.getJnpaApiRuns).not.toBe('function');
    expect(typeof sim.getJnpaApiDefects).not.toBe('function');
  });

  it('passes the caller’s limit through rather than silently defaulting it', async () => {
    let seen: number | undefined = -1;
    const sim = new SimAdapter(baseWith({
      getJnpaApiRuns: async (limit?: number) => { seen = limit; return []; },
    }));

    await sim.getJnpaApiRuns!(50);

    expect(seen).toBe(50);
  });
});
