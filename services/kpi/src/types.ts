/**
 * Inputs to the KPI engine (prompt §8). The engine is PURE: it takes already-
 * loaded canonical entities + baselines and returns KpiResult[]. No I/O, no
 * clock — callers pass `asOf` so results are deterministic and testable.
 */
import type {
  CargoEvent,
  GateTransaction,
  ITRHOMovement,
  Rake,
  ScanEvent,
  Container,
} from '@jnpa/schemas';

export interface BaselineEntry {
  value: number;
  unit: string;
  scope?: string;
  source?: string;
  justification?: string;
}

export interface BaselinesConfig {
  asOf: string;
  baselines: Record<string, BaselineEntry>;
}

/** Everything the engine needs to compute the full KPI set. */
export interface KpiInputs {
  asOf: string;
  containers: Container[];
  events: CargoEvent[];
  gateTransactions: GateTransaction[];
  rakes: Rake[];
  itrho: ITRHOMovement[];
  scans: ScanEvent[];
  baselines: BaselinesConfig;
  /**
   * Dwell threshold (hours) beyond which a container in CFS/buffer counts as
   * buffer pendency (§8 Buffer Pendency). Configurable.
   */
  bufferDwellThresholdHours?: number;
  /** Number of trend buckets to emit. */
  trendBuckets?: number;
}
