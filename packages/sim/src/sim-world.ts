/**
 * SimWorld — the single deterministic dataset facade used by the MockAdapter and
 * the demo console. Reads config/terminals.json (the one source of truth for
 * operators/geometry), builds the world + a full cargo dataset for a fixed demo
 * window, and exposes the seed so a run is reproducible (Addendum B.2).
 */
import type { CargoDataset, World } from './generators/index.js';
import { buildWorld, generateCargo, type TerminalsConfig } from './generators/index.js';

/** Fixed demo origin so the dataset is identical every run: 2026-06-15T00:00Z. */
export const DEMO_ORIGIN_MS = Date.UTC(2026, 5, 15, 0, 0, 0);

export interface SimWorldOptions {
  seed?: number;
  windowHours?: number;
  containerCount?: number;
  startMs?: number;
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
    this.dataset = generateCargo(this.world, {
      seed: this.seed,
      startMs: this.startMs,
      windowHours: this.windowHours,
      containerCount: opts.containerCount ?? 400,
    });
  }
}
