/**
 * Verifies the guided What-If tour engine: starting a scenario drives the sim
 * overrides + map spotlight that the dashboard and ArcGIS map bind to, stepping
 * is cumulative, and stopping resets everything to baseline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { simStore } from '../src/sim/simStore.js';
import { SCENARIO_SCRIPTS, getScript } from '../src/sim/scenarioPlayer.js';

beforeEach(() => {
  simStore.stopScenario();
  simStore.reset();
});

describe('scenario tour engine', () => {
  it('exposes the four §8.4.5 scenarios', () => {
    expect(SCENARIO_SCRIPTS.map((s) => s.id)).toEqual(['CGO-1', 'CGO-2', 'CGO-3', 'LANE-ASSIGN']);
    for (const s of SCENARIO_SCRIPTS) expect(s.steps.length).toBeGreaterThan(0);
  });

  it('startScenario applies step 0 and spotlights its assets', () => {
    // do not auto-advance so the test is deterministic
    simStore.startScenario('CGO-2', false);
    const s = simStore.getState();
    expect(s.tour.scenarioId).toBe('CGO-2');
    expect(s.tour.stepIndex).toBe(0);
    // CGO-2 step 0 sets the scan queue and spotlights gate NSICT-G1.
    expect(s.scanQueue).toBe(45);
    expect(s.highlights).toContain('NSICT-G1');
  });

  it('stepping is cumulative — later patches supersede earlier ones', () => {
    simStore.startScenario('CGO-2', false);
    simStore.gotoStep(1); // gate jams
    let s = simStore.getState();
    expect(s.gates['NSICT-G1']?.queueLength).toBe(22);
    simStore.gotoStep(3); // cross-twin defers trucks → queue eases
    s = simStore.getState();
    expect(s.gates['NSICT-G1']?.queueLength).toBe(11);
    expect(s.scanQueue).toBe(30);
  });

  it('jumping back recomputes the board to that step exactly', () => {
    simStore.startScenario('CGO-2', false);
    simStore.gotoStep(3);
    simStore.gotoStep(0);
    const s = simStore.getState();
    // back at step 0: only the scan override, gates clear again
    expect(s.scanQueue).toBe(45);
    expect(s.gates['NSICT-G1']).toBeUndefined();
  });

  it('spotlight follows each step (map + dashboard sync source)', () => {
    simStore.startScenario('CGO-3', false);
    const script = getScript('CGO-3')!;
    for (let i = 0; i < script.steps.length; i++) {
      simStore.gotoStep(i);
      expect(simStore.getState().highlights).toEqual(script.steps[i]!.spotlight);
    }
  });

  it('stopScenario clears every override back to baseline', () => {
    simStore.startScenario('CGO-1', false);
    simStore.gotoStep(2);
    expect(Object.keys(simStore.getState().pendency).length).toBeGreaterThan(0);
    simStore.stopScenario();
    const s = simStore.getState();
    expect(s.tour.scenarioId).toBeNull();
    expect(s.pendency).toEqual({});
    expect(s.rail).toEqual({});
    expect(s.gates).toEqual({});
    expect(s.scanQueue).toBeNull();
    expect(s.highlights).toEqual([]);
  });
});
