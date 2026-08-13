/**
 * Verifies the guided What-If tour engine: starting a scenario drives the sim
 * overrides + map spotlight that the dashboard and ArcGIS map bind to, stepping
 * is cumulative, and stopping resets everything to baseline.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { simStore } from '../src/sim/simStore.js';
import { SCENARIO_SCRIPTS, getScript } from '../src/sim/scenarioPlayer.js';
import { workflowStore } from '../src/workflow/workflowStore.js';

beforeEach(() => {
  simStore.stopScenario();
  simStore.reset();
  workflowStore.clearRuns();
});

describe('scenario tour engine', () => {
  it('exposes the §8.2 scenarios S1–S6 plus the S7 monsoon chain', () => {
    expect(SCENARIO_SCRIPTS.map((s) => s.id)).toEqual(['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7']);
    for (const s of SCENARIO_SCRIPTS) expect(s.steps.length).toBeGreaterThan(0);
  });

  it('resolves legacy CGO/LANE ids to their S-scenario via getScript', () => {
    expect(getScript('CGO-2')?.id).toBe('S2');
    expect(getScript('CGO-3')?.id).toBe('S3');
    expect(getScript('CGO-1')?.id).toBe('S5');
    expect(getScript('LANE-ASSIGN')?.id).toBe('S4');
  });

  it('startScenario applies step 0 and spotlights its assets', () => {
    // do not auto-advance so the test is deterministic
    simStore.startScenario('S2', false);
    const s = simStore.getState();
    expect(s.tour.scenarioId).toBe('S2');
    expect(s.tour.stepIndex).toBe(0);
    // S2 step 0 sets the scan queue and spotlights gate NSICT-G1.
    expect(s.scanQueue).toBe(45);
    expect(s.highlights).toContain('NSICT-G1');
  });

  it('stepping is cumulative — later patches supersede earlier ones', () => {
    simStore.startScenario('S2', false);
    simStore.gotoStep(1); // gate jams
    let s = simStore.getState();
    expect(s.gates['NSICT-G1']?.queueLength).toBe(22);
    simStore.gotoStep(3); // cross-twin defers trucks → queue eases
    s = simStore.getState();
    expect(s.gates['NSICT-G1']?.queueLength).toBe(11);
    expect(s.scanQueue).toBe(30);
  });

  it('jumping back recomputes the board to that step exactly', () => {
    simStore.startScenario('S2', false);
    simStore.gotoStep(3);
    simStore.gotoStep(0);
    const s = simStore.getState();
    // back at step 0: only the scan override, gates clear again
    expect(s.scanQueue).toBe(45);
    expect(s.gates['NSICT-G1']).toBeUndefined();
  });

  it('spotlight follows each step (map + dashboard sync source)', () => {
    simStore.startScenario('S3', false);
    const script = getScript('S3')!;
    for (let i = 0; i < script.steps.length; i++) {
      simStore.gotoStep(i);
      expect(simStore.getState().highlights).toEqual(script.steps[i]!.spotlight);
    }
  });

  it('stepping a scenario fires workflow runs onto the ledger (§8.3, crit 5)', () => {
    // S2 has actions on steps 2 (FORECAST_RERUN) and 3 (CROSS_TWIN_PUSH).
    simStore.startScenario('S2', false);
    simStore.gotoStep(2);
    simStore.gotoStep(3);
    const runs = workflowStore.getState().runs;
    expect(runs.length).toBeGreaterThanOrEqual(2);
    // Newest first; the last action fired is the cross-twin deferral.
    expect(runs[0]!.trigger).toMatch(/deferred-arrival/i);
    expect(runs[0]!.scenarioId).toBe('S2');
    // Revisiting an already-fired step must NOT double-fire (dedup).
    const before = workflowStore.getState().runs.length;
    simStore.gotoStep(2);
    simStore.gotoStep(3);
    expect(workflowStore.getState().runs.length).toBe(before);
  });

  it('AUTO fires immediately; ADVISORY queues for approval', () => {
    workflowStore.setMode('ADVISORY');
    simStore.startScenario('S1', false); // step 0 has no action; step 3 does
    simStore.gotoStep(3);
    const pending = workflowStore.getState().runs.find((r) => r.scenarioId === 'S1');
    expect(pending?.status).toBe('PENDING_APPROVAL');
    workflowStore.approveRun(pending!.id);
    expect(workflowStore.getState().runs.find((r) => r.id === pending!.id)?.status).toBe('APPROVED');
    workflowStore.setMode('AUTO');
  });

  it('stopScenario clears every override back to baseline', () => {
    simStore.startScenario('S5', false);
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
