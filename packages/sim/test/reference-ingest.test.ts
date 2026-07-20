/**
 * SimWorld cargoOverride seam — verifies the generic dataset-override hook is
 * additive: it REPLACES the synthetic container set and PREPENDS the override
 * events, while keeping every other synthetic domain (rakes, gate transactions)
 * intact, and leaves the default (no-override) path unchanged. The reference
 * ingestion transforms that PRODUCE an override now live in @jnpa/data and are
 * tested there — sim only owns this seam.
 */
import { describe, expect, it } from 'vitest';
import type { CargoEvent, Container } from '@jnpa/schemas';
import { SimWorld } from '../src/sim-world.js';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };

const config = terminalsConfig as unknown as ConstructorParameters<typeof SimWorld>[0];

const override = {
  containers: [{ containerNo: 'REFX1234560' } as unknown as Container],
  events: [{ containerNo: 'REFX1234560', eventType: 'YARD_MOVE' } as unknown as CargoEvent],
};

describe('SimWorld cargoOverride seam', () => {
  it('replaces the synthetic container set but keeps synthetic events flowing', () => {
    const w = new SimWorld(config, { cargoOverride: override });
    expect(w.dataset.containers).toHaveLength(1);
    expect(w.dataset.containers[0]!.containerNo).toBe('REFX1234560');
    // Override event prepended; synthetic gate/rake stream retained for KPIs.
    expect(w.dataset.events[0]!.containerNo).toBe('REFX1234560');
    expect(w.dataset.events.length).toBeGreaterThan(1);
    expect(w.dataset.rakes.length).toBeGreaterThan(0);
    expect(w.dataset.gateTransactions.length).toBeGreaterThan(0);
  });

  it('leaves the default synthetic dataset unchanged when no override is given', () => {
    const w = new SimWorld(config, { seed: 999 });
    expect(w.dataset.containers.length).toBe(400);
  });
});
