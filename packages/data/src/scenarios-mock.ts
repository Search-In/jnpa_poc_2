/**
 * Deterministic what-if scenarios for mock mode (prompt §12 + Appendix C req 6).
 * Each scenario:
 *   - recomputes KPIs before/after (visible delta panel),
 *   - fires an automated action (notification / recommendation / cross-twin push),
 *   - returns a spatial mapOverlay payload for the ArcGIS what-if rendering (A.2).
 * Seeded for repeatability. The services/scenarios microservice (Phase 7) hosts
 * the same logic over the live event backbone; this is the offline implementation.
 */
import type { KpiResult } from '@jnpa/schemas';
import type { CargoDataset, World } from '@jnpa/sim';
import { Rng } from '@jnpa/sim';
import type { BaselinesConfig } from '@jnpa/kpi';
import { computeAllKpis } from '@jnpa/kpi';
import type { ScenarioParams, ScenarioResultDTO } from './interface.js';

export interface ScenarioContext {
  dataset: CargoDataset;
  world: World;
  baselines: BaselinesConfig;
  asOf: string;
  seed: number;
}

function baseKpis(ctx: ScenarioContext): KpiResult[] {
  return computeAllKpis({
    asOf: ctx.asOf,
    containers: ctx.dataset.containers,
    events: ctx.dataset.events,
    gateTransactions: ctx.dataset.gateTransactions,
    rakes: ctx.dataset.rakes,
    itrho: ctx.dataset.itrho,
    scans: ctx.dataset.scans,
    baselines: ctx.baselines,
    bufferDwellThresholdHours: 24,
  });
}

/** Apply a multiplicative tweak to one KPI's value + recompute improvement. */
function tweak(kpis: KpiResult[], key: string, factor: number): KpiResult[] {
  return kpis.map((k) => {
    if (k.key !== key) return k;
    const value = Math.round(k.value * factor * 100) / 100;
    const raw = k.higherIsBetter
      ? (value - k.baseline) / k.baseline
      : (k.baseline - value) / k.baseline;
    return { ...k, value, improvementPct: Math.round(raw * 1000) / 10 };
  });
}

export function runMockScenario(
  id: string,
  params: ScenarioParams,
  ctx: ScenarioContext,
): ScenarioResultDTO {
  const rng = new Rng(ctx.seed).fork(`scenario:${id}`);
  const before = baseKpis(ctx);

  switch (id) {
    case 'CGO-1': {
      // CFS Pendency Spike → alert TERMINAL_OPS, show downstream rake-departure
      // impact, recommend re-sequencing.
      const cfs = (params.facilityId as string) ?? 'CFS-PUNE';
      const threshold = (params.threshold as number) ?? 50;
      // pendency worsens, rake TAT degrades downstream
      let after = tweak(before, 'bufferPendency', 1.6);
      after = tweak(after, 'rakeTurnaroundTime', 1.12);
      return {
        scenarioId: id,
        seed: rng.next() * 0, // deterministic marker
        before,
        after,
        actions: [
          { kind: 'NOTIFICATION', detail: `CFS pendency at ${cfs} crossed ${threshold} — alert raised`, target: 'TERMINAL_OPS' },
          { kind: 'RECOMMENDATION', detail: 'Re-sequence rake loading to drain CFS buffer before next departure' },
        ],
        mapOverlay: { type: 'pendency-spike', facilityId: cfs, severity: 'high' },
      };
    }

    case 'CGO-2': {
      // Customs Flag Surge (cross-twin → UC3): surge → re-run gate-queue
      // forecaster → push deferred-arrival window to UC3 Trucking App.
      const surge = (params.surgeCount as number) ?? 40;
      const gateId = (params.gateId as string) ?? 'NSICT-G1';
      // more scans queue → scanner TAT and gate txn time rise; deferral helps
      let after = tweak(before, 'scannerTurnaroundTime', 1.25);
      after = tweak(after, 'gateTransactionTime', 1.18);
      const deferFrom = ctx.asOf;
      const deferTo = new Date(new Date(ctx.asOf).getTime() + 90 * 60_000).toISOString();
      return {
        scenarioId: id,
        seed: rng.next() * 0,
        before,
        after,
        actions: [
          { kind: 'FORECAST_RERUN', detail: `Gate-queue forecaster re-run for ${gateId} after surge of ${surge}` },
          {
            kind: 'CROSS_TWIN_PUSH',
            detail: `Deferred-arrival window ${deferFrom}–${deferTo} pushed to UC3 Trucking App`,
            target: 'UC3',
          },
        ],
        mapOverlay: { type: 'customs-surge', gateId, deferralWindow: { from: deferFrom, to: deferTo } },
      };
    }

    case 'CGO-3': {
      // Inter-Terminal Trans-shipment Optimisation → 8–12% empty-rake-TAT
      // reduction → Mixed-Train Optimization improvement.
      const reductionPct = rng.float(0.08, 0.12);
      let after = tweak(before, 'interTerminalTransferTat', 1 - reductionPct);
      after = tweak(after, 'rakeTurnaroundTime', 1 - reductionPct * 0.6);
      after = tweak(after, 'mixedTrainOptimization', 1 + reductionPct);
      return {
        scenarioId: id,
        seed: rng.next() * 0,
        before,
        after,
        actions: [
          { kind: 'OPTIMISATION', detail: `ITRHO re-routing yields ${(reductionPct * 100).toFixed(1)}% empty-rake-TAT reduction` },
          { kind: 'RECOMMENDATION', detail: 'Consolidate mixed-terminal containers onto shared outbound rakes' },
        ],
        mapOverlay: { type: 'itrho-optimisation', reductionPct: Math.round(reductionPct * 1000) / 10 },
      };
    }

    case 'LANE-ASSIGN': {
      // Appendix C req 6: road-congestion / gate-operational sim → dynamic lane
      // assignment recommendation.
      const congestedGate = (params.gateId as string) ?? 'GTI-G2';
      const after = tweak(before, 'gateTransactionTime', 0.82);
      return {
        scenarioId: id,
        seed: rng.next() * 0,
        before,
        after,
        actions: [
          { kind: 'LANE_ASSIGNMENT', detail: `Divert 2 lanes from ${congestedGate} to adjacent gate; reroute trailers` },
          { kind: 'RECOMMENDATION', detail: 'Dynamic lane reassignment cuts avg gate transaction time ~18%' },
        ],
        mapOverlay: { type: 'lane-assignment', congestedGate, rerouteLines: true },
      };
    }

    default:
      return {
        scenarioId: id,
        seed: 0,
        before,
        after: before,
        actions: [{ kind: 'NOOP', detail: `Unknown scenario "${id}"` }],
      };
  }
}
