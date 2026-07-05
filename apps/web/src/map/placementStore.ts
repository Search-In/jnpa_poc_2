/**
 * placementStore — user overrides for 3D-asset positions, edited by dragging
 * assets in the SceneView (see PortScene edit mode). Each override is keyed by a
 * stable placement key (`crane:NSICT:0`, `vessel:BMCT`, `gate3d:GTI-G1`, …) that
 * the scene3d.ts builders stamp on every graphic. When an override exists for a
 * key, the builder uses its lng/lat (and optional heading) instead of the
 * derived quay-frame position — so an operator can nudge each ship, crane, gate
 * or yard block onto its exact real-world spot.
 *
 * Persistence model (chosen by the user): NOT auto-saved. Edits live in memory
 * for the session; the "Export placements" button downloads a positions.json
 * that can be committed to the repo (or handed back) and loaded via `loadJSON`.
 * A tiny pub/sub lets the scene re-render as drags land.
 *
 * Seed baseline: `data/positions.json` (hand-corrected real-world placements
 * exported from the editor) is imported at build time and loaded as the default
 * overrides, so the 3D scene opens with assets already on their real spots. The
 * editor still layers on top (drag to further nudge); "Reset" reverts to these
 * seeded defaults rather than wiping to the derived quay-frame positions.
 */
import seededPlacements from '../../../../data/positions.json';

export interface Placement {
  /** EPSG:4326 longitude the asset was dragged to. */
  lng: number;
  /** EPSG:4326 latitude. */
  lat: number;
  /** Optional heading (deg) if the asset was rotated. */
  heading?: number;
}

/** The full export shape (positions.json). */
export interface PlacementFile {
  version: 1;
  note?: string;
  placements: Record<string, Placement>;
}

type Listener = () => void;

class PlacementStore {
  private map = new Map<string, Placement>();
  private listeners = new Set<Listener>();
  /** The seeded default overrides (from data/positions.json) — the Reset target. */
  private readonly seed: Record<string, Placement>;

  constructor() {
    // Load the committed real-world placements as the baseline. loadInto() is a
    // pure fill (no emit) since there are no subscribers yet at construction.
    this.seed = readPlacementFile(seededPlacements as unknown);
    for (const [k, v] of Object.entries(this.seed)) this.map.set(k, v);
  }

  /** Current override for a placement key, if seeded or the user moved that asset. */
  get(key: string): Placement | undefined {
    return this.map.get(key);
  }

  /** All overrides (read-only snapshot). */
  all(): Record<string, Placement> {
    return Object.fromEntries(this.map);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  count(): number {
    return this.map.size;
  }

  /** Set/replace an asset's placement and notify subscribers. */
  set(key: string, p: Placement): void {
    this.map.set(key, {
      lng: round(p.lng),
      lat: round(p.lat),
      ...(p.heading != null ? { heading: Math.round(p.heading) } : {}),
    });
    this.emit();
  }

  /** Remove one override (revert that asset to its derived position). */
  remove(key: string): void {
    if (this.map.delete(key)) this.emit();
  }

  /**
   * Reset to the seeded defaults (data/positions.json) — the "Reset" button.
   * This reverts user drags back to the committed real-world placements, NOT to
   * the derived quay-frame positions (an empty store). Always emits so the scene
   * rebuilds even when only values changed.
   */
  clear(): void {
    this.map = new Map(Object.entries(this.seed).map(([k, v]) => [k, { ...v }]));
    this.emit();
  }

  /** Load overrides from a parsed positions.json (merges over current). */
  loadJSON(file: PlacementFile): void {
    const placements = readPlacementFile(file);
    for (const [k, v] of Object.entries(placements)) this.map.set(k, v);
    this.emit();
  }

  /** Serialise to the export shape. */
  toJSON(note?: string): PlacementFile {
    return { version: 1, note, placements: this.all() };
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.listeners.forEach((l) => l());
  }
}

function round(v: number): number {
  return Math.round(v * 1e6) / 1e6; // ~0.1 m precision
}

/**
 * Validate + normalise a parsed positions.json into a rounded placement map.
 * Tolerant: a malformed file / entry is skipped, not thrown — the scene falls
 * back to derived positions for any key it can't read.
 */
function readPlacementFile(file: unknown): Record<string, Placement> {
  const out: Record<string, Placement> = {};
  const f = file as Partial<PlacementFile> | null;
  if (!f || f.version !== 1 || typeof f.placements !== 'object' || f.placements == null) return out;
  for (const [k, v] of Object.entries(f.placements)) {
    if (v && typeof v.lng === 'number' && typeof v.lat === 'number') {
      out[k] = { lng: round(v.lng), lat: round(v.lat), ...(v.heading != null ? { heading: round(v.heading) } : {}) };
    }
  }
  return out;
}

/** Singleton shared by the scene builders and the edit UI. */
export const placementStore = new PlacementStore();

/** Trigger a browser download of the current placements as positions.json. */
export function downloadPlacements(note?: string): void {
  const data = JSON.stringify(placementStore.toJSON(note), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'positions.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
