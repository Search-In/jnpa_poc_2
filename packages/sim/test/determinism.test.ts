import { describe, expect, it } from 'vitest';
import { isValidContainerNo, validate } from '@jnpa/schemas';
import { Rng } from '../src/rng.js';
import { SimWorld } from '../src/sim-world.js';
import terminalsConfig from '../../../config/terminals.json' assert { type: 'json' };

const config = terminalsConfig as unknown as ConstructorParameters<typeof SimWorld>[0];

describe('Rng determinism', () => {
  it('produces identical sequences for the same seed', () => {
    const a = new Rng(123);
    const b = new Rng(123);
    const seqA = Array.from({ length: 20 }, () => a.next());
    const seqB = Array.from({ length: 20 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('forks deterministically by label', () => {
    expect(new Rng(1).fork('x').next()).toBe(new Rng(1).fork('x').next());
    expect(new Rng(1).fork('x').next()).not.toBe(new Rng(1).fork('y').next());
  });
});

describe('SimWorld dataset', () => {
  const w1 = new SimWorld(config, { seed: 999 });
  const w2 = new SimWorld(config, { seed: 999 });

  it('is reproducible: same seed → identical event count and first event id', () => {
    expect(w1.dataset.events.length).toBe(w2.dataset.events.length);
    expect(w1.dataset.events[0]!.eventId).toBe(w2.dataset.events[0]!.eventId);
    expect(w1.dataset.containers[0]!.containerNo).toBe(w2.dataset.containers[0]!.containerNo);
  });

  it('builds terminals from config (5 JNPA terminals)', () => {
    const ids = w1.world.terminals.map((t) => t.terminalId).sort();
    expect(ids).toEqual(['BMCT', 'GTI', 'JNPCT', 'NSICT', 'NSIGT']);
  });

  it('generates a non-trivial coherent dataset', () => {
    const d = w1.dataset;
    expect(d.containers.length).toBe(400);
    expect(d.events.length).toBeGreaterThan(800);
    expect(d.rakes.length).toBeGreaterThan(0);
    expect(d.gateTransactions.length).toBeGreaterThan(0);
    expect(d.itrho.length).toBeGreaterThan(0);
    expect(d.scans.length).toBeGreaterThan(0);
  });

  it('events are chronologically ordered (the spine is an ordered stream)', () => {
    const ts = w1.dataset.events.map((e) => e.ts);
    const sorted = [...ts].sort();
    expect(ts).toEqual(sorted);
  });

  it('pins the NLDS/LDB demo container as the first row', () => {
    expect(w1.dataset.containers[0]!.containerNo).toBe('CCLU7468361');
    expect(w1.dataset.containers[0]!.lineOwner).toBe('CCLU');
    expect(w1.dataset.containers[0]!.originStream).toBe('IMPORT_DPD');
  });

  it('every generated container number is a valid ISO 6346 number', () => {
    for (const c of w1.dataset.containers) {
      expect(isValidContainerNo(c.containerNo), c.containerNo).toBe(true);
    }
  });

  it('every generated CargoEvent validates against the JSON-Schema', () => {
    // sample to keep the test fast but representative
    for (const e of w1.dataset.events.slice(0, 200)) {
      const { valid, errors } = validate('jnpa:uc2:CargoEvent', e);
      expect(valid, `${e.eventType} ${errors.join(';')}`).toBe(true);
    }
  });
});
