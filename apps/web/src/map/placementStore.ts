/**
 * placementStore — user overrides for 3D-asset positions, edited by dragging
 * assets in the SceneView (see PortScene edit mode). Each override is keyed by a
 * stable placement key (`crane:NSICT:0`, `vessel:BMCT`, `gate3d:GTI-G1`, …) that
 * the scene3d.ts builders stamp on every graphic. When an override exists for a
 * key, the builder uses its lng/lat (and optional heading) instead of the
 * derived quay-frame position — so an operator can nudge each ship, crane, gate
 * or yard block onto its exact real-world spot.
 *
 * Persistence model (source of truth = the committed JSON file, NOT the browser):
 * `data/positions.json` is imported at BUILD TIME as the seed, so the 3D scene
 * opens with every asset already on its real spot. Edits (drag / rotate / nudge)
 * live in memory for the session; the "Export" button downloads the updated
 * positions.json, and the "Import" button uploads one back to preview it live.
 * To make an edit permanent you commit the exported file to `data/positions.json`
 * — then it's "in code" and every build/user gets it. "Reset" reverts to the
 * seeded file. No localStorage: nothing hidden persists in the browser.
 */
import seededPlacements from '../../../../data/positions.json';

export interface Placement {
  /** EPSG:4326 longitude the asset was dragged to. */
  lng: number;
  /** EPSG:4326 latitude. */
  lat: number;
  /** Optional heading (deg) if the asset was rotated. */
  heading?: number;
  /**
   * Optional ROUTE POLYLINE — an ordered list of [lng, lat] waypoints traced on
   * the satellite imagery (only meaningful for `truckroute:*` keys). When set,
   * the trucks follow this exact path instead of the synthetic quay-frame loop,
   * so they stay on the real roads. `lng`/`lat` above remain the route anchor
   * (first waypoint) for focus/selection.
   */
  path?: [number, number][];
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
    // Baseline = committed real-world placements from data/positions.json.
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
      ...(p.path && p.path.length ? { path: p.path.map((pt) => [round(pt[0]), round(pt[1])] as [number, number]) } : {}),
    });
    this.emit();
  }

  // ---- route polyline editing (truckroute:* keys) --------------------------

  /** Current traced route waypoints for a key, or undefined if none drawn. */
  getPath(key: string): [number, number][] | undefined {
    return this.map.get(key)?.path;
  }

  /**
   * Append a waypoint to a route's traced path. The FIRST waypoint also becomes
   * the route anchor (lng/lat) so focus/selection point at the route start.
   */
  appendWaypoint(key: string, lng: number, lat: number): void {
    const cur = this.map.get(key);
    const path = [...(cur?.path ?? []), [lng, lat] as [number, number]];
    const anchor = path[0]!;
    this.set(key, { lng: anchor[0], lat: anchor[1], ...(cur?.heading != null ? { heading: cur.heading } : {}), path });
  }

  /** Remove the last waypoint (undo one click). Drops the path if it empties. */
  undoWaypoint(key: string): void {
    const cur = this.map.get(key);
    if (!cur?.path?.length) return;
    const path = cur.path.slice(0, -1);
    if (path.length === 0) {
      // No waypoints left → keep the anchor but drop the path entirely.
      this.set(key, { lng: cur.lng, lat: cur.lat, ...(cur.heading != null ? { heading: cur.heading } : {}) });
    } else {
      this.set(key, { lng: path[0]![0], lat: path[0]![1], ...(cur.heading != null ? { heading: cur.heading } : {}), path });
    }
  }

  /** Clear a route's traced path (reverts trucks to the synthetic loop). */
  clearPath(key: string): void {
    const cur = this.map.get(key);
    if (!cur) return;
    this.set(key, { lng: cur.lng, lat: cur.lat, ...(cur.heading != null ? { heading: cur.heading } : {}) });
  }

  /**
   * Set an asset's heading (deg), preserving its position. Needs the asset's
   * CURRENT effective position (`base`) so a first-time rotation (no existing
   * override) still pins the asset where it already is. Called by the rotate dial.
   */
  setHeading(key: string, heading: number, base: [number, number]): void {
    const cur = this.map.get(key);
    const lng = cur?.lng ?? base[0];
    const lat = cur?.lat ?? base[1];
    this.set(key, { lng, lat, heading: ((heading % 360) + 360) % 360 });
  }

  /**
   * Nudge an asset by `metres` toward a compass `dir` (N/S/E/W) from its CURRENT
   * effective position (`base`), preserving heading. A metre step is converted to
   * a lng/lat delta at JNPA's latitude. Called by the N/S/E/W arrow buttons.
   */
  nudge(key: string, dir: 'N' | 'S' | 'E' | 'W', metres: number, base: [number, number]): void {
    const cur = this.map.get(key);
    const lng = cur?.lng ?? base[0];
    const lat = cur?.lat ?? base[1];
    const dLat = metres / 110_574;
    const dLng = metres / (111_320 * Math.cos((lat * Math.PI) / 180));
    const next = {
      N: { lng, lat: lat + dLat },
      S: { lng, lat: lat - dLat },
      E: { lng: lng + dLng, lat },
      W: { lng: lng - dLng, lat },
    }[dir];
    this.set(key, { ...next, ...(cur?.heading != null ? { heading: cur.heading } : {}) });
  }

  /** Remove one override (revert that asset to its derived position). */
  remove(key: string): void {
    if (this.map.delete(key)) this.emit();
  }

  /**
   * Reset ONE asset to its seeded default (data/positions.json) if it has one,
   * else drop the override so it reverts to the derived quay-frame position. The
   * per-asset counterpart of {@link clear}.
   */
  resetKey(key: string): void {
    const s = this.seed[key];
    if (s) this.map.set(key, { ...s });
    else this.map.delete(key);
    this.emit();
  }

  /**
   * Reset to the seeded defaults (data/positions.json) — the "Reset" button.
   * Reverts user edits back to the committed real-world placements. Always emits
   * so the scene rebuilds even when only values changed.
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
      // Preserve a route polyline if present (array of [lng,lat] pairs).
      const path = Array.isArray((v as Placement).path)
        ? (v as Placement).path!.filter(
            (pt): pt is [number, number] => Array.isArray(pt) && typeof pt[0] === 'number' && typeof pt[1] === 'number',
          ).map((pt) => [round(pt[0]), round(pt[1])] as [number, number])
        : undefined;
      out[k] = {
        lng: round(v.lng),
        lat: round(v.lat),
        ...(v.heading != null ? { heading: round(v.heading) } : {}),
        ...(path && path.length ? { path } : {}),
      };
    }
  }
  return out;
}

/** Singleton shared by the scene builders and the edit UI. */
export const placementStore = new PlacementStore();

/**
 * Prompt the user to pick a positions.json and load it into the store (so an
 * exported/hand-edited file can be previewed live before committing it to
 * data/positions.json). Resolves with the number of placements loaded, or
 * rejects on a malformed file. Uses a transient <input type=file>.
 */
export function importPlacements(): Promise<number> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return reject(new Error('No file selected'));
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result)) as PlacementFile;
          const n = Object.keys(readPlacementFile(parsed)).length;
          if (n === 0) return reject(new Error('No valid placements in file'));
          placementStore.loadJSON(parsed);
          resolve(n);
        } catch (e) {
          reject(e instanceof Error ? e : new Error('Invalid JSON'));
        }
      };
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsText(file);
    };
    input.click();
  });
}

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
