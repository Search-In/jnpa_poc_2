/**
 * @jnpa/kpi — pure KPI engine (prompt §8). `computeAllKpis` returns the seven
 * KPIs plus dashboard rollups. No I/O; deterministic given inputs.
 */
import type { KpiResult } from '@jnpa/schemas';
import type { KpiInputs } from './types.js';
import {
  bufferPendency,
  containerDwell,
  containerPendency,
  gateThroughput,
  gateTransactionTime,
  interTerminalTransferTat,
  mixedTrainOptimization,
  rakeTurnaroundTime,
  scannerTurnaroundTime,
  trailerTurnaroundTime,
  transshipmentTrailerTat,
} from './kpis.js';

export * from './types.js';
export * from './helpers.js';
export * from './kpis.js';

/** The seven primary KPIs (§8) in dashboard-strip order. */
export function computeSevenKpis(inp: KpiInputs): KpiResult[] {
  return [
    rakeTurnaroundTime(inp),
    interTerminalTransferTat(inp),
    trailerTurnaroundTime(inp),
    scannerTurnaroundTime(inp),
    transshipmentTrailerTat(inp),
    bufferPendency(inp),
    mixedTrainOptimization(inp),
  ];
}

/**
 * Dashboard rollups (bid §8.4.4) + the supporting dwell KPI (WS4 #9). Dwell is a
 * rollup rather than one of the seven: the tender names seven primary measures,
 * and `computeSevenKpis` must keep returning exactly those.
 */
export function computeRollups(inp: KpiInputs): KpiResult[] {
  return [gateThroughput(inp), gateTransactionTime(inp), containerPendency(inp), containerDwell(inp)];
}

/** Everything: seven KPIs + rollups. */
export function computeAllKpis(inp: KpiInputs): KpiResult[] {
  return [...computeSevenKpis(inp), ...computeRollups(inp)];
}
