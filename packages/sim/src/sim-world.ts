/**
 * SimWorld — the single deterministic dataset facade used by the MockAdapter and
 * the demo console. Reads config/terminals.json (the one source of truth for
 * operators/geometry), builds the world + a full cargo dataset for a fixed demo
 * window, and exposes the seed so a run is reproducible (Addendum B.2).
 */
import type { CargoEvent, Container } from '@jnpa/schemas';
import type { CargoDataset, World } from './generators/index.js';
import { buildWorld, generateCargo, type TerminalsConfig } from './generators/index.js';

/** Fixed demo origin so the dataset is identical every run: 2026-06-15T00:00Z. */
export const DEMO_ORIGIN_MS = Date.UTC(2026, 5, 15, 0, 0, 0);

/**
 * A container/event slice that can replace the synthetic cargo in the dataset.
 * Kept generic here (no dependency on any specific ingestion) so the reference
 * data layer in @jnpa/data — or any other source — can supply it. Structurally
 * identical to @jnpa/data's ReferenceCargoOverride.
 */
export interface CargoDatasetOverride {
  containers: Container[];
  events: CargoEvent[];
}

export interface SimWorldOptions {
  seed?: number;
  windowHours?: number;
  containerCount?: number;
  startMs?: number;
  /**
   * Reference-data cargo override (JNPA reference package → canonical model).
   * When provided with at least one container, the synthetic container set is
   * REPLACED by the reference containers and the reference events are PREPENDED
   * to the synthetic event stream. Everything else (gate transactions, rakes,
   * scans, empty pools) stays synthetic, so the rail/gate/KPI panels are
   * undisturbed while Container Movement reflects the reference data. Absent →
   * the dataset is byte-for-byte the synthetic default.
   */
  cargoOverride?: CargoDatasetOverride;
}

export class SimWorld {
  readonly seed: number;
  readonly world: World;
  readonly dataset: CargoDataset;
  readonly startMs: number;
  readonly windowHours: number;

  constructor(config: TerminalsConfig, opts: SimWorldOptions = {}) {
    this.seed = opts.seed ?? 20260615;
    this.startMs = opts.startMs ?? DEMO_ORIGIN_MS;
    this.windowHours = opts.windowHours ?? 48;
    this.world = buildWorld(config, this.seed);
    const dataset = generateCargo(this.world, {
      seed: this.seed,
      startMs: this.startMs,
      windowHours: this.windowHours,
      containerCount: opts.containerCount ?? 400,
    });
    const override = opts.cargoOverride;
    if (override && override.containers.length > 0) {
      dataset.containers = override.containers;
      dataset.events = [...override.events, ...dataset.events];
    }
    this.dataset = dataset;
  }
}
