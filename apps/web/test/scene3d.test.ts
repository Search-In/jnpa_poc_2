/**
 * scene3d — geometry invariants of the 3D port scene.
 *
 * These guard the two properties that are easy to break by eye and impossible to
 * eyeball reliably in a 3D view:
 *   1. crane CLUSTERS: every surveyed anchor keeps its exact coordinate, each
 *      anchor grows into 3–4 cranes, and no two cranes anywhere overlap;
 *   2. GATE sides: each terminal's IN gate is right of / OUT gate left of the
 *      inbound travel direction (see the gate notes in scene3d.ts).
 */
import { describe, expect, it } from 'vitest';
import type { Terminal } from '@jnpa/schemas';
import terminalsConfig from '../../../config/terminals.json';
import positions from '../../../data/positions.json';
import {
  railTrackLayer,
  cranePlacements,
  gateRoles,
  graphicsFor3d,
  quayHeadings,
  pkeyPosition,
  pkeyHeading,
  resetTrafficState,
  yardHighlightGraphics,
  yardAssetPosition,
  yardPkeyFromAssetId,
} from '../src/map/scene3d.js';
import { graphicsFor } from '../src/map/layers.js';
import { buildSceneAnim } from '../src/map/sceneAnim.js';
import { placementStore } from '../src/map/placementStore.js';

const terminals = (terminalsConfig as unknown as { terminals: Terminal[] }).terminals;
const placements = (
  positions as unknown as {
    placements: Record<string, { lng: number; lat: number; heading?: number; path?: [number, number][] }>;
  }
).placements;

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((18.945 * Math.PI) / 180);
const metres = (a: [number, number], b: [number, number]) =>
  Math.hypot((b[0] - a[0]) * M_PER_DEG_LON, (b[1] - a[1]) * M_PER_DEG_LAT);

/** Along-rail footprint of the STS crane model (see CRANE_BODY_M in scene3d.ts). */
const CRANE_FOOTPRINT_M = 7.5;

describe('scene3d crane clusters', () => {
  const cranes = cranePlacements(terminals);

  it('keeps every surveyed anchor at its exact committed coordinate', () => {
    const byPkey = new Map(cranes.map((c) => [c.pkey, c] as const));
    const anchorKeys = Object.keys(placements).filter((k) => /^crane:[^:]+:\d+$/.test(k));
    expect(anchorKeys.length).toBeGreaterThan(0);
    for (const key of anchorKeys) {
      const seeded = placements[key]!;
      const rendered = byPkey.get(key);
      expect(rendered, `anchor ${key} is rendered`).toBeTruthy();
      expect(rendered!.pos[0]).toBe(seeded.lng);
      expect(rendered!.pos[1]).toBe(seeded.lat);
    }
  });

  /** Cranes grouped by their anchor pkey. */
  const groups = (() => {
    const byAnchor = new Map<string, typeof cranes>();
    for (const c of cranes) {
      const anchor = c.pkey.split(':').slice(0, 3).join(':');
      byAnchor.set(anchor, [...(byAnchor.get(anchor) ?? []), c]);
    }
    return byAnchor;
  })();

  it('groups the cranes into the sizes seen in the JNPA reference photos', () => {
    expect(groups.size).toBe(22); // 3 NSICT + 3 NSIGT + 4 GTI + 9 BMCT + 3 JNPCT
    const sizes = [...groups.values()].map((g) => g.length);
    for (const [anchor, g] of groups) {
      expect(g.length, `${anchor} group size`).toBeGreaterThanOrEqual(1);
      expect(g.length, `${anchor} group size`).toBeLessThanOrEqual(4);
    }
    // The reference shows a MIX — lone cranes, pairs, threes and fours. A run of
    // one repeated size everywhere is the artificial look this replaced.
    expect(new Set(sizes).size, 'distinct group sizes').toBeGreaterThanOrEqual(3);
    expect(sizes.filter((n) => n === 1).length, 'lone cranes standing apart').toBeGreaterThan(0);
    expect(sizes.filter((n) => n === 4).length, 'full four-crane berths').toBeGreaterThan(0);
  });

  it('never spaces the groups on one uniform pitch', () => {
    const pitches: number[] = [];
    for (const g of groups.values()) {
      if (g.length < 2) continue;
      const spread = g
        .map((c) => metres(g[0]!.pos, c.pos) * (c.pkey === g[0]!.pkey ? 0 : 1))
        .sort((a, b) => a - b);
      for (let i = 1; i < spread.length; i++) pitches.push(Math.round(spread[i]! - spread[i - 1]!));
    }
    expect(pitches.length).toBeGreaterThan(10);
    // Real cranes park 30–50 m apart and never at one exact repeated pitch.
    expect(new Set(pitches).size, 'distinct crane pitches').toBeGreaterThan(pitches.length / 2);
  });

  it('never places two cranes closer than the model footprint', () => {
    let closest = Infinity;
    let pair = '';
    for (let i = 0; i < cranes.length; i++) {
      for (let j = i + 1; j < cranes.length; j++) {
        const d = metres(cranes[i]!.pos, cranes[j]!.pos);
        if (d < closest) {
          closest = d;
          pair = `${cranes[i]!.pkey} ↔ ${cranes[j]!.pkey}`;
        }
      }
    }
    // Every crane keeps a clear air gap from every other crane, in its own
    // cluster or the neighbouring one.
    expect(closest, `closest pair ${pair}`).toBeGreaterThan(CRANE_FOOTPRINT_M * 1.5);
  });

  it("keeps each cluster sibling on its anchor's rail (perpendicular to the boom)", () => {
    const byPkey = new Map(cranes.map((c) => [c.pkey, c] as const));
    for (const c of cranes) {
      const parts = c.pkey.split(':');
      if (parts.length !== 4) continue; // anchors have nothing to compare against
      const anchor = byPkey.get(parts.slice(0, 3).join(':'))!;
      const e = (c.pos[0] - anchor.pos[0]) * M_PER_DEG_LON;
      const n = (c.pos[1] - anchor.pos[1]) * M_PER_DEG_LAT;
      const brg = ((Math.atan2(e, n) * 180) / Math.PI + 360) % 360;
      // The rail is anchor.heading ± 90°; allow a degree of float for rounding.
      const rail = (anchor.heading + 90) % 360;
      const delta = Math.min(Math.abs(brg - rail), 360 - Math.abs(brg - rail));
      const reverse = Math.abs(delta - 180);
      expect(Math.min(delta, reverse), `${c.pkey} sits on the rail`).toBeLessThan(1);
      expect(c.heading, `${c.pkey} shares the anchor heading`).toBe(anchor.heading);
    }
  });
});

describe('quay line — nothing standing in the water', () => {
  const headings = quayHeadings(terminals);
  const cranes = cranePlacements(terminals);
  /**
   * How far seaward of a terminal's quay line a point lies, in metres. The quay
   * line is the median of that terminal's surveyed crane anchors along its own
   * fitted normal; positive = out over the water.
   */
  function seawardOfQuay(terminalId: string, p: [number, number]): number {
    const heading = headings.get(terminalId)!;
    const anchors = cranes.filter((c) => c.terminalId === terminalId && c.pkey.split(':').length === 3);
    const origin = anchors[0]!.pos;
    const nE = Math.sin((heading * Math.PI) / 180);
    const nN = Math.cos((heading * Math.PI) / 180);
    const project = (q: [number, number]) =>
      (q[0] - origin[0]) * M_PER_DEG_LON * nE + (q[1] - origin[1]) * M_PER_DEG_LAT * nN;
    const line = anchors.map((a) => project(a.pos)).sort((a, b) => a - b);
    return project(p) - line[Math.floor(line.length / 2)]!;
  }

  it('keeps every crane on its own quay rail', () => {
    // Two BMCT anchors used to sit 294 m and 398 m out in the channel; the rest
    // of each terminal's anchors fit a straight line to within a few metres.
    for (const c of cranes) {
      expect(Math.abs(seawardOfQuay(c.terminalId, c.pos)), `${c.pkey} is on the quay`).toBeLessThan(25);
    }
  });

  it('gives every crane on a terminal the same quay-square heading', () => {
    for (const t of terminals) {
      const mine = cranes.filter((c) => c.terminalId === t.terminalId);
      expect(new Set(mine.map((c) => c.heading)).size, `${t.terminalId} heading consistency`).toBe(1);
      // Fitted from the terminal's own anchors, so it must differ from the
      // port-wide 298° default wherever that quay runs on its own bearing.
      expect(mine[0]!.heading, `${t.terminalId} heading`).toBe(headings.get(t.terminalId));
    }
  });

  it('keeps every container stack inside the terminal, landward of the quay', () => {
    for (const [key, v] of Object.entries(placements)) {
      const match = key.match(/^yard:([^:]+):/);
      if (!match) continue;
      const off = seawardOfQuay(match[1]!, [v.lng, v.lat]);
      expect(off, `${key} is landward of the quay`).toBeLessThan(0);
    }
  });



  it('keeps each terminal\'s containers in ONE compact yard, not spread over the apron', () => {
    for (const t of terminals) {
      const blocks = Object.entries(placements)
        .filter(([k]) => k.startsWith(`yard:${t.terminalId}:`))
        .map(([, v]) => [v.lng, v.lat] as [number, number]);
      expect(blocks.length).toBe(12);
      const cx = blocks.reduce((s, p) => s + p[0], 0) / blocks.length;
      const cy = blocks.reduce((s, p) => s + p[1], 0) / blocks.length;
      const radius = Math.max(...blocks.map((p) => metres(p, [cx, cy])));
      // The JNPA reference shows one dense yard, not blocks scattered across the
      // open marked apron. Before compaction this radius was 87–133 m.
      expect(radius, `${t.terminalId} yard cluster radius`).toBeLessThan(80);
    }
  });

});

describe('JNPA gate layout', () => {
  /** The five JNPA gates — one per terminal, nothing else exists. */
  const REAL_GATES = ['North Gate', 'NSIGT Parking Gate', 'Central Gate', 'BMCT Out Gate', 'South Gate'];
  const ids = terminals.flatMap((t) => t.gates);
  const gateOps = ids.map((gateId) => ({
    gateId,
    terminalId: terminals.find((t) => t.gates.includes(gateId))!.terminalId,
    queueLength: 5,
    transactions: [],
    avgTxnTimeMin: 4,
  }));
  const rendered = graphicsFor3d.gates(gateOps as never, terminals);

  it('has exactly the 5 gates, with no duplicates or extras', () => {
    expect(ids.length, 'gates in config').toBe(5);
    expect(new Set(ids).size, 'no duplicate ids').toBe(5);
    expect(rendered.length, 'gates rendered').toBe(5);
    const names = rendered.map((g) => (g.attributes as { gateName: string }).gateName);
    expect(new Set(names)).toEqual(new Set(REAL_GATES));
    // Retired gates are gone from config AND from the placements — a lingering
    // gate3d:* override would be an orphan the placement store still resolves.
    for (const retired of ['GTI-G1', 'BMCT-G2', 'JNPCT-G2', 'NSICT-G2', 'BMCT-G3']) {
      expect(ids, `${retired} retired from config`).not.toContain(retired);
      expect(placements[`gate3d:${retired}`], `${retired} placement removed`).toBeUndefined();
    }
    // Every terminal keeps exactly one gate: the sim picks with
    // rng.pick(terminal.gates), which yields undefined on an empty array.
    for (const t of terminals) {
      expect(t.gates.length, `${t.terminalId} gate count`).toBe(1);
    }
  });

  it('leaves no gate id referenced elsewhere without a definition', () => {
    // These ids are hard-coded in causalGraph.ts, the sim registry, the CODECO
    // fixtures and the scenario/KPI/gateway tests, so they must keep existing.
    for (const referenced of ['NSICT-G1', 'NSIGT-G1', 'GTI-G2', 'BMCT-G1', 'JNPCT-G1']) {
      expect(ids, `${referenced} is defined`).toContain(referenced);
      expect(placements[`gate3d:${referenced}`], `${referenced} has a placement`).toBeTruthy();
    }
    // …and no placement exists for a gate the config does not declare.
    const placed = Object.keys(placements).filter((k) => k.startsWith('gate3d:')).map((k) => k.slice('gate3d:'.length));
    expect(new Set(placed)).toEqual(new Set(ids));
  });

  /**
   * The surveyed checkpoint each gate now stands on, taken from the red-circled
   * buildings in the reference screenshots. These are real checkpoint structures,
   * NOT points derived from the model's own geometry, so they are asserted
   * exactly — a drift here means someone moved a gate off its checkpoint.
   */
  const CHECKPOINTS: Record<string, [number, number]> = {
    'North Gate': [18.952950, 72.960450],
    'NSIGT Parking Gate': [18.931437, 72.964438],
    'Central Gate': [18.935800, 72.950530],
    'BMCT Out Gate': [18.928423, 72.951902],
    'South Gate': [18.931123, 72.953597],
  };

  it('stands every gate on its surveyed checkpoint, never in water or mangrove', () => {
    // Gates are pinned to the checkpoint buildings circled in the reference
    // screenshots. That corridor runs 0.9–2.3 km inland of the modelled truck
    // routes, so "on a traced route" is deliberately NOT asserted any more — see
    // the traffic-coupling test below, which measures what that costs.
    const water = Object.entries(placements)
      .filter(([k]) => k.startsWith('vessel:'))
      .map(([, v]) => [v.lng, v.lat] as [number, number]);
    for (const g of rendered) {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const a = g.attributes as { gateName: string; roleLabel: string };
      const p: [number, number] = [geo.longitude, geo.latitude];
      const want = CHECKPOINTS[a.gateName];
      expect(want, `${a.gateName} has a surveyed checkpoint`).toBeTruthy();
      expect(geo.latitude, `${a.gateName} latitude`).toBeCloseTo(want![0], 6);
      expect(geo.longitude, `${a.gateName} longitude`).toBeCloseTo(want![1], 6);
      expect(Math.min(...water.map((w) => metres(p, w))), `${a.gateName} is clear of the water`).toBeGreaterThan(200);
      // The 3D label must carry the real name, not the internal id.
      expect(a.roleLabel, `${a.gateName} label`).toContain(a.gateName);
    }
  });

  it('connects every checkpoint to the truck-route network', () => {
    // Each truck route now runs from its terminal out to that terminal's gate, so
    // every gate sits ON its carriageway. That is what keeps the traffic overlay
    // alive: the gate-queue term falls off as (1 − d/170)^1.6, so a gate even
    // 110 m off the road drops it to 20% and the Green/Orange/Red indicators go
    // flat. It also means the indicators — drawn on these same paths — reach the
    // gates instead of stopping short at the terminal.
    const roads = Object.entries(placements)
      .filter(([k, v]) => k.startsWith('truckroute:') && Array.isArray(v.path))
      .map(([, v]) => v.path!);
    for (const g of rendered) {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const p: [number, number] = [geo.longitude, geo.latitude];
      const d = Math.min(
        ...roads.flatMap((path) =>
          path.slice(1).map((w, i) => {
            const a = path[i]!;
            const ax = (a[0] - p[0]) * M_PER_DEG_LON;
            const ay = (a[1] - p[1]) * M_PER_DEG_LAT;
            const dx = (w[0] - a[0]) * M_PER_DEG_LON;
            const dy = (w[1] - a[1]) * M_PER_DEG_LAT;
            const len = dx * dx + dy * dy || 1;
            const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
            return Math.hypot(ax + u * dx, ay + u * dy);
          }),
        ),
      );
      expect(d, `${(g.attributes as { gateName: string }).gateName} is on its truck route`).toBeLessThan(1);
    }
  });

  it('keeps every gate inside the port estate and off the stacks', () => {
    for (const g of rendered) {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const a = g.attributes as { gateName: string; terminalId: string };
      const p: [number, number] = [geo.longitude, geo.latitude];
      const yards = Object.entries(placements)
        .filter(([k]) => k.startsWith('yard:'))
        .map(([, v]) => [v.lng, v.lat] as [number, number]);
      const cranes = cranePlacements(terminals).map((c) => c.pos);
      expect(Math.min(...yards.map((y) => metres(p, y))), `${a.gateName} clears the stacks`).toBeGreaterThan(150);
      expect(Math.min(...cranes.map((c) => metres(p, c))), `${a.gateName} clears the crane runs`).toBeGreaterThan(150);
    }
  });

  it('puts every gate within the estate access corridor', () => {
    for (const g of rendered) {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const a = g.attributes as { gateName: string; terminalId: string };
      const yards = Object.entries(placements)
        .filter(([k]) => k.startsWith(`yard:${a.terminalId}:`))
        .map(([, v]) => [v.lng, v.lat] as [number, number]);
      const d = Math.min(...yards.map((y) => metres([geo.longitude, geo.latitude], y)));
      // The checkpoints line the estate access road, which runs inland of the
      // wharf — so a gate is 0.4–3.5 km from the stacks it serves, not adjacent
      // to them. This still catches a gate flung right out of the port.
      expect(d, `${a.gateName} is in the ${a.terminalId} access corridor`).toBeLessThan(3600);
    }
  });

  it('renders each gate at the SAME coordinate in 2D and in 3D', () => {
    // The 2D map used to derive gate positions from its own GATE_OFFSET table —
    // terminal centroid + a hard-coded degree offset — and never read
    // data/positions.json, which only the 3D scene consulted. Every surveyed
    // correction therefore moved the 3D gate and left the 2D marker behind:
    // they diverged by 106 m (BMCT-G1) up to 2290 m (JNPCT-G1), and the 2D
    // markers landed inside the container stacks. Both views now resolve through
    // pkeyPosition, and this test fails the moment anything forks them again.
    const flat = graphicsFor.gates(gateOps as never, terminals);
    expect(flat.length, '2D gates rendered').toBe(rendered.length);
    const by2d = new Map(
      flat.map((g) => {
        const geo = g.geometry as unknown as { longitude: number; latitude: number };
        return [(g.attributes as { gateId: string }).gateId, [geo.longitude, geo.latitude] as [number, number]];
      }),
    );
    for (const g of rendered) {
      const a = g.attributes as { gateId: string; gateName: string };
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const two = by2d.get(a.gateId);
      expect(two, `${a.gateName} exists on the 2D map`).toBeTruthy();
      expect(metres(two!, [geo.longitude, geo.latitude]), `${a.gateName} 2D↔3D divergence`).toBeLessThan(0.5);
    }
  });

  it('keeps every gate out of the container stacks and the crane runs', () => {
    // A gate is a road structure at the terminal boundary, never on the stacks.
    // NSIGT-G1 stood 36 m from a yard-block centre — inside the block grid.
    const yards = Object.entries(placements)
      .filter(([k]) => k.startsWith('yard:'))
      .map(([, v]) => [v.lng, v.lat] as [number, number]);
    const cranes = cranePlacements(terminals).map((c) => c.pos);
    for (const g of rendered) {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const a = g.attributes as { gateName: string };
      const p: [number, number] = [geo.longitude, geo.latitude];
      expect(Math.min(...yards.map((y) => metres(p, y))), `${a.gateName} clears the stacks`).toBeGreaterThan(75);
      expect(Math.min(...cranes.map((c) => metres(p, c))), `${a.gateName} clears the crane runs`).toBeGreaterThan(180);
    }
  });

  it('keeps every gate editable — position and heading both resolve', () => {
    // The transform panel bails out when pkeyPosition returns null, which is what
    // made Edit appear dead on gates.
    for (const id of ids) {
      expect(pkeyPosition(`gate3d:${id}`, terminals), `${id} resolves a position`).toBeTruthy();
      expect(Number.isFinite(pkeyHeading(`gate3d:${id}`, terminals)), `${id} resolves a heading`).toBe(true);
    }
  });

  it('identifies a clicked gate as the GATE, not its terminal', () => {
    // resolveHit()'s rule, mirrored: a gate graphic carries both gateId and
    // terminalId, and reporting the terminal selected an unmovable tree row and
    // closed the transform panel.
    for (const g of rendered) {
      const a = g.attributes as Record<string, unknown>;
      const pkey = a.pkey as string;
      expect(pkey.startsWith('gate3d:')).toBe(true);
      expect(pkey.slice('gate3d:'.length), 'reported id is the gate').toBe(a.gateId);
      expect(a.gateId).not.toBe(a.terminalId);
    }
  });
});

describe('scene3d gate directions', () => {
  const roles = gateRoles(terminals);

  it('designates exactly one IN and one OUT gate per multi-gate terminal', () => {
    for (const t of terminals) {
      const mine = t.gates.map((g) => roles.get(g));
      if (t.gates.length === 1) {
        expect(mine, `${t.terminalId} single gate is bidirectional`).toEqual(['BOTH']);
        continue;
      }
      expect(mine.filter((r) => r === 'IN').length, `${t.terminalId} IN gates`).toBe(1);
      expect(mine.filter((r) => r === 'OUT').length, `${t.terminalId} OUT gates`).toBe(1);
    }
  });

  it('puts the IN gate right of, and the OUT gate left of, the inbound direction', () => {
    // Inbound travel is seaward (≈298°); its right-hand side is ≈028°, the
    // NEGATIVE end of the 208° along-quay axis. So along(IN) < along(OUT).
    const alongE = Math.sin((208 * Math.PI) / 180);
    const alongN = Math.cos((208 * Math.PI) / 180);
    const gatePos = new Map(
      graphicsFor3d
        .gates(
          [...roles.keys()].map((gateId) => ({
            gateId,
            terminalId: gateId.split('-')[0]!,
            queueLength: 4,
            transactions: [],
            avgTxnTimeMin: 4,
          })) as never,
          terminals,
        )
        .map((g) => {
          const geo = g.geometry as unknown as { longitude: number; latitude: number };
          return [g.attributes.gateId as string, [geo.longitude, geo.latitude] as [number, number]] as const;
        }),
    );
    for (const t of terminals) {
      if (t.gates.length < 2) continue;
      const [clng, clat] = (t.geom as { coordinates: [number, number] }).coordinates;
      const along = (id: string) => {
        const p = gatePos.get(id)!;
        return (p[0] - clng) * M_PER_DEG_LON * alongE + (p[1] - clat) * M_PER_DEG_LAT * alongN;
      };
      const inGate = t.gates.find((g) => roles.get(g) === 'IN')!;
      const outGate = t.gates.find((g) => roles.get(g) === 'OUT')!;
      expect(along(inGate), `${t.terminalId}: ${inGate} is right of ${outGate}`).toBeLessThan(along(outGate));
    }
  });
});

describe('scene3d gate truck queues', () => {
  const roles = gateRoles(terminals);
  // A worst-case full queue at every gate.
  const gateOps = [...roles.keys()].map((gateId) => ({
    gateId,
    terminalId: gateId.split('-')[0]!,
    queueLength: 12,
    transactions: [],
    avgTxnTimeMin: 4,
  }));
  const trucks = graphicsFor3d.trucks(gateOps as never, terminals).map((g) => {
    const geo = g.geometry as unknown as { longitude: number; latitude: number };
    return { pos: [geo.longitude, geo.latitude] as [number, number], attrs: g.attributes as Record<string, unknown> };
  });
  const gates = new Map(
    graphicsFor3d.gates(gateOps as never, terminals).map((g) => {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      return [g.attributes.gateId as string, [geo.longitude, geo.latitude] as [number, number]] as const;
    }),
  );

  it('stops every truck clear of the toll-naka structure', () => {
    // The canopy is 36 m across × 14 m deep, so it reaches 7 m from the gate
    // point; the longest vehicle is ~23 m, i.e. 11.5 m from its own centre.
    for (const tr of trucks) {
      const d = metres(tr.pos, gates.get(tr.attrs.gateId as string)!);
      expect(d, `truck at ${tr.attrs.gateId} clears the gate`).toBeGreaterThan(7 + 11.5);
      // …and stays on the gate approach rather than trailing off across the port.
      expect(d, `truck at ${tr.attrs.gateId} stays on the approach`).toBeLessThan(125);
    }
  });

  it('never overlaps two queued trucks', () => {
    for (let i = 0; i < trucks.length; i++) {
      for (let j = i + 1; j < trucks.length; j++) {
        const d = metres(trucks[i]!.pos, trucks[j]!.pos);
        // Lane pitch is the tightest case (7 m) against a 4.4 m vehicle width.
        expect(d, `${trucks[i]!.attrs.gateId} queue spacing`).toBeGreaterThan(5);
      }
    }
  });

  it('faces departing traffic opposite to arriving traffic', () => {
    for (const tr of trucks) {
      const expected = roles.get(tr.attrs.gateId as string) === 'OUT' ? 180 : 0;
      expect(tr.attrs.headingDelta, `${tr.attrs.gateId} heading`).toBe(expected);
    }
  });
});

describe('yard-area highlight', () => {
  const ringOf = (assetId: string) => {
    const g = yardHighlightGraphics(assetId, terminals);
    return (g[0]!.geometry as unknown as { rings: [number, number][][] }).rings[0]!;
  };

  it('outlines only the yard block that was selected', () => {
    for (const id of ['NSICT-Y1', 'GTI-Y7', 'JNPCT-Y12']) {
      const g = yardHighlightGraphics(id, terminals);
      expect(g.length, `${id} produces exactly one outline`).toBe(1);
      const ring = ringOf(id);
      expect(ring.length, 'closed rectangle').toBe(5);
      // Centred on the block it belongs to.
      const centre = yardAssetPosition(id, terminals)!;
      const mid: [number, number] = [(ring[0]![0] + ring[2]![0]) / 2, (ring[0]![1] + ring[2]![1]) / 2];
      expect(metres(centre, mid), `${id} outline is centred on its block`).toBeLessThan(0.5);
    }
  });

  it('never bleeds into the neighbouring bay', () => {
    for (const id of ['NSICT-Y1', 'GTI-Y7', 'JNPCT-Y12']) {
      const centre = yardAssetPosition(id, terminals)!;
      const terminalId = id.split('-')[0]!;
      let nearest = Infinity;
      for (let i = 0; i < 12; i++) {
        const p = pkeyPosition(`yard:${terminalId}:${i}`, terminals);
        if (p && metres(p, centre) > 0.1) nearest = Math.min(nearest, metres(p, centre));
      }
      const reach = Math.max(...ringOf(id).map((c) => metres(centre, c)));
      expect(reach, `${id} stays inside its own bay`).toBeLessThan(nearest);
    }
  });

  it('produces nothing for assets that are not yard blocks', () => {
    // The caller hands it any selected id, so a terminal / gate / crane / mover
    // must fall through to the normal pick ring instead of drawing an area.
    for (const id of ['NSICT', 'NSICT-G1', 'NSICT-STS1', 'tug', 'channel', 'route:GTI']) {
      expect(yardHighlightGraphics(id, terminals).length, `${id} is not a yard`).toBe(0);
      expect(yardPkeyFromAssetId(id), `${id} maps to no yard pkey`).toBeNull();
    }
    expect(yardPkeyFromAssetId('NSICT-Y3')).toBe('yard:NSICT:2');
  });
});

describe('live traffic overlay', () => {
  const ops = (queue: number) =>
    [...gateRoles(terminals).keys()].map((gateId) => ({
      gateId,
      terminalId: terminals.find((t) => t.gates.includes(gateId))!.terminalId,
      queueLength: queue,
      transactions: [],
      avgTxnTimeMin: 4,
    }));
  /** Run the overlay to a steady state at a given queue depth. */
  const settle = (queue: number, vehicles: [number, number][] = []) => {
    resetTrafficState();
    let out = graphicsFor3d.traffic(ops(queue) as never, terminals, vehicles);
    for (let i = 0; i < 40; i++) out = graphicsFor3d.traffic(ops(queue) as never, terminals, vehicles);
    return out.map((g) => g.attributes as { congestion: number; level: string; routeId: string });
  };

  it('draws only the declared routes, each one continuous', () => {
    // The overlay is a fixed set of explicit road-true routes (TRAFFIC_ROUTES in
    // scene3d.ts), the same shape UC-3 uses. It used to be cut from all five
    // `truckroute:*` paths, which produced disjoint ribbons over yards and open
    // ground. Today: the north line plus Central Gate → South Gate.
    const segs = graphicsFor3d.traffic(ops(4) as never, terminals, []);
    expect(segs.length).toBeGreaterThan(10);
    const routes = [...new Set(segs.map((g) => (g.attributes as { routeId: string }).routeId))];
    expect(routes.sort(), 'the declared traffic routes, and nothing else').toEqual([
      'JNPT-CENTRAL-SOUTH', 'JNPT-MAIN',
    ]);
    // Each route's pieces are end-to-end, so each reads as one unbroken ribbon.
    for (const id of routes) {
      const paths = segs
        .filter((g) => (g.attributes as { routeId: string }).routeId === id)
        .map((g) => (g.geometry as unknown as { paths: [number, number][][] }).paths[0]!);
      expect(paths.length, `${id} is segmented`).toBeGreaterThan(4);
      for (let i = 0; i < paths.length - 1; i++) {
        const end = paths[i]![paths[i]!.length - 1]!;
        const start = paths[i + 1]![0]!;
        const gap = Math.hypot(
          (start[0] - end[0]) * M_PER_DEG_LON,
          (start[1] - end[1]) * M_PER_DEG_LAT,
        );
        expect(gap, `${id}: piece ${i} joins piece ${i + 1}`).toBeLessThan(1);
      }
    }
  });

  it('is driven by vehicles, not randomness — empty roads stay green', () => {
    const quiet = settle(0);
    expect(quiet.every((s) => s.congestion === 0), 'an empty port is entirely free flowing').toBe(true);
    expect(new Set(quiet.map((s) => s.level))).toEqual(new Set(['Free flowing']));
    // Same input twice must give the same output — no random component.
    const again = settle(0);
    expect(again.map((s) => s.congestion)).toEqual(quiet.map((s) => s.congestion));
  });

  it('escalates green → moderate → heavy → severe as queues grow', () => {
    const mean = (q: number) => {
      const s = settle(q);
      return s.reduce((a, b) => a + b.congestion, 0) / s.length;
    };
    const m0 = mean(0);
    const m3 = mean(3);
    const m7 = mean(7);
    const m12 = mean(12);
    expect(m0).toBe(0);
    expect(m3).toBeGreaterThan(m0);
    expect(m7).toBeGreaterThan(m3);
    expect(m12).toBeGreaterThan(m7);
    // A busy port shows every band at once — multiple hotspots, not one flat colour.
    const busy = new Set(settle(12).map((s) => s.level));
    expect(busy.size, 'several congestion levels visible together').toBeGreaterThanOrEqual(3);
  });

  it('counts moving vehicles, not just gate queues', () => {
    const segs = graphicsFor3d.traffic(ops(0) as never, terminals, []);
    const first = (segs[0]!.geometry as unknown as { paths: [number, number][][] }).paths[0]![0]!;
    const quiet = settle(0)[0]!.congestion;
    const busy = settle(0, [first, first, first, first, first])[0]!.congestion;
    expect(quiet).toBe(0);
    expect(busy, 'trucks parked on a segment colour it').toBeGreaterThan(0.2);
  });

  it('never leaves an isolated red island in a green road', () => {
    const busy = settle(12);
    const byRoad = new Map<string, number[]>();
    for (const s of busy) byRoad.set(s.routeId, [...(byRoad.get(s.routeId) ?? []), s.congestion]);
    for (const [road, vals] of byRoad) {
      for (let i = 1; i < vals.length - 1; i++) {
        const above = vals[i]! - Math.max(vals[i - 1]!, vals[i + 1]!);
        expect(above, `${road} segment ${i} is not a lone spike`).toBeLessThan(0.2);
      }
    }
  });

  it('tails congestion back up the approach rather than stopping at the gate', () => {
    const busy = settle(12);
    const byRoad = new Map<string, number[]>();
    for (const s of busy) byRoad.set(s.routeId, [...(byRoad.get(s.routeId) ?? []), s.congestion]);
    // The longest approach must show a real gradient — a hot end and a cool end —
    // not one hot segment at the gate with everything behind it green.
    const longest = [...byRoad.values()].sort((a, b) => b.length - a.length)[0]!;
    expect(longest.length).toBeGreaterThan(6);
    expect(Math.max(...longest) - Math.min(...longest), 'gradient along the approach').toBeGreaterThan(0.25);
    // …and the decay is monotone-ish: no neighbour jumps a whole colour band.
    for (let i = 1; i < longest.length; i++) {
      expect(Math.abs(longest[i]! - longest[i - 1]!), 'smooth tail-back').toBeLessThan(0.2);
    }
  });

  it('clears more slowly than it builds, so roads fade red → orange → green', () => {
    resetTrafficState();
    for (let i = 0; i < 60; i++) graphicsFor3d.traffic(ops(14) as never, terminals, []);
    const peak = (gs: ReturnType<typeof graphicsFor3d.traffic>) =>
      Math.max(...gs.map((g) => (g.attributes as { congestion: number }).congestion));
    const jammed = peak(graphicsFor3d.traffic(ops(14) as never, terminals, []));
    // Queues vanish; the road must ease down over several updates, not snap green.
    const r1 = peak(graphicsFor3d.traffic(ops(0) as never, terminals, []));
    const r2 = peak(graphicsFor3d.traffic(ops(0) as never, terminals, []));
    expect(r1).toBeLessThan(jammed);
    expect(r2).toBeLessThan(r1);
    expect(r1, 'recovery is gradual, not instant').toBeGreaterThan(jammed * 0.6);
  });

  it('ignores truck routes — a traced path adds no traffic line', () => {
    // The overlay is the ROAD route, not the truck paths. Tracing a truck route
    // must no longer add a ribbon: those paths run into yards and over gate
    // aprons, and drawing traffic along them is what put green/amber lines on
    // open ground. The trucks themselves still follow them (sceneAnim.ts).
    const before = settle(6);
    placementStore.set('truckroute:NEW-ROAD', {
      lng: 72.945,
      lat: 18.946,
      path: [
        [72.945, 18.946],
        [72.947, 18.944],
        [72.949, 18.942],
      ],
    });
    try {
      const after = settle(6);
      expect(new Set(after.map((s) => s.routeId)).has('NEW-ROAD'), 'truck route is not a traffic road').toBe(false);
      expect(after.length, 'the overlay is unchanged by a traced truck route').toBe(before.length);
    } finally {
      placementStore.remove('truckroute:NEW-ROAD');
      resetTrafficState();
    }
  });

  it('transitions gradually in space and in time', () => {
    // Spatial: neighbouring segments of one road must not jump bands at a joint.
    const busy = settle(12);
    const byRoad = new Map<string, number[]>();
    for (const s of busy) byRoad.set(s.routeId, [...(byRoad.get(s.routeId) ?? []), s.congestion]);
    for (const [road, vals] of byRoad) {
      for (let i = 1; i < vals.length; i++) {
        expect(Math.abs(vals[i]! - vals[i - 1]!), `${road} steps smoothly`).toBeLessThan(0.35);
      }
    }
    // Temporal: a sudden jam ramps in over several updates rather than snapping.
    resetTrafficState();
    for (let i = 0; i < 40; i++) graphicsFor3d.traffic(ops(0) as never, terminals, []);
    const peak = (gs: ReturnType<typeof graphicsFor3d.traffic>) =>
      Math.max(...gs.map((g) => (g.attributes as { congestion: number }).congestion));
    const step1 = peak(graphicsFor3d.traffic(ops(16) as never, terminals, []));
    const step2 = peak(graphicsFor3d.traffic(ops(16) as never, terminals, []));
    const settled = Math.max(...settle(16).map((s) => s.congestion));
    expect(step1).toBeLessThan(settled * 0.6);
    expect(step2).toBeGreaterThan(step1);
    expect(step2).toBeLessThan(settled);
  });
});

describe('trucks never overlap', () => {
  // Rendered footprints at the 8 m symbol height, from the node-transformed glTF
  // bounds. truck-realistic is the WIDE one — 7.5 m across, wider than the old
  // 7 m lane pitch, which is why neighbouring lanes interpenetrated.
  const DIM: Record<string, { L: number; W: number }> = {
    'container-truck': { L: 12.0 * (8 / 4.15), W: 2.29 * (8 / 4.15) },
    'truck-realistic': { L: 5.256 * (8 / 2.884), W: 2.709 * (8 / 2.884) },
  };
  const gateOps = [...gateRoles(terminals).keys()].map((gateId) => ({
    gateId,
    terminalId: gateId.split('-')[0]!,
    queueLength: 12,
    transactions: [],
    avgTxnTimeMin: 4,
  }));

  it('leaves no two queued trucks interpenetrating at any gate', () => {
    const queued = graphicsFor3d.trucks(gateOps as never, terminals).map((g) => {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      const a = g.attributes as { model: string; gateId: string; headingDelta: number };
      return {
        pos: [geo.longitude, geo.latitude] as [number, number],
        model: a.model,
        gateId: a.gateId,
        heading: (298 + 180 + (a.headingDelta ?? 0)) % 360,
      };
    });
    expect(queued.length).toBe(5 * 12); // 5 JNPA gates × the 12-truck cap
    for (let i = 0; i < queued.length; i++) {
      for (let j = i + 1; j < queued.length; j++) {
        const a = queued[i]!;
        const b = queued[j]!;
        if (a.gateId !== b.gateId) continue;
        // Both trucks in a queue share a heading, so their boxes overlap exactly
        // when they are too close BOTH along the lane and across it.
        const rad = (a.heading * Math.PI) / 180;
        const uE = Math.sin(rad);
        const uN = Math.cos(rad);
        const dE = (b.pos[0] - a.pos[0]) * M_PER_DEG_LON;
        const dN = (b.pos[1] - a.pos[1]) * M_PER_DEG_LAT;
        const along = Math.abs(dE * uE + dN * uN);
        const across = Math.abs(dE * -uN + dN * uE);
        const needAlong = (DIM[a.model]!.L + DIM[b.model]!.L) / 2;
        const needAcross = (DIM[a.model]!.W + DIM[b.model]!.W) / 2;
        expect(
          along >= needAlong || across >= needAcross,
          `${a.gateId}: ${a.model} and ${b.model} overlap (along ${along.toFixed(1)}/${needAlong.toFixed(
            1,
          )}, across ${across.toFixed(1)}/${needAcross.toFixed(1)})`,
        ).toBe(true);
      }
    }
  });

  it('keeps the moving trucks apart for a full circuit', () => {
    // Each circuit is an out-and-back along one corridor, so its two trucks meet
    // head-on every lap. They were measured 0.8 m apart — driving through one
    // another — before each was held to its own side of the centreline.
    const anim = buildSceneAnim(terminals, gateOps as never);
    const cars = anim.layers.find((l) => l.title === '3D · Trucks (live)')!.graphics.toArray();
    expect(cars.length).toBe(8);
    let closest = Infinity;
    for (let t = 0; t <= 1200; t += 4) {
      anim.tick(t, 4);
      const pts = cars.map((c) => {
        const geo = c.geometry as unknown as { longitude: number; latitude: number };
        return [geo.longitude, geo.latitude] as [number, number];
      });
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) closest = Math.min(closest, metres(pts[i]!, pts[j]!));
      }
    }
    // The widest pairing needs (7.5 + 4.4) / 2 ≈ 6 m of separation.
    expect(closest, 'closest moving pair over a full circuit').toBeGreaterThan(8);
    anim.destroy();
  });
});

describe('drawn truck routes', () => {
  // Yard stacks render ~12 m along their long axis (the 298° quay heading) × 5.8 m
  // across; a driving truck is ~4.4 m wide. So a route clears a stack when it
  // passes more than 6 + 2.2 m off its end OR 2.9 + 2.2 m off its side.
  const STACK_HALF_LEN_M = 6;
  const STACK_HALF_WID_M = 2.9;
  const TRUCK_HALF_WID_M = 2.2;
  const heading = (298 * Math.PI) / 180;
  const longAxis = [Math.sin(heading), Math.cos(heading)] as const;
  const crossAxis = [Math.sin(heading + Math.PI / 2), Math.cos(heading + Math.PI / 2)] as const;

  /** Vector (m) from `p` to the closest point on segment a–b. */
  function toSegment(p: [number, number], a: [number, number], b: [number, number]) {
    const ax = (a[0] - p[0]) * M_PER_DEG_LON;
    const ay = (a[1] - p[1]) * M_PER_DEG_LAT;
    const bx = (b[0] - p[0]) * M_PER_DEG_LON;
    const by = (b[1] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
    return [ax + u * dx, ay + u * dy] as const;
  }

  it('never drives a truck through a container stack', () => {
    const yards = Object.entries(placements).filter(([k]) => k.startsWith('yard:'));
    const routes = Object.entries(placements)
      .filter(([k, v]) => k.startsWith('truckroute:') && Array.isArray(v.path))
      .map(([k, v]) => [k, v.path!] as const);
    expect(routes.length).toBeGreaterThan(0);
    for (const [routeKey, path] of routes) {
      for (const [yardKey, yard] of yards) {
        for (let i = 0; i < path.length - 1; i++) {
          const v = toSegment([yard.lng, yard.lat], path[i]!, path[i + 1]!);
          const alongStack = Math.abs(v[0] * longAxis[0] + v[1] * longAxis[1]);
          const acrossStack = Math.abs(v[0] * crossAxis[0] + v[1] * crossAxis[1]);
          const clears =
            alongStack > STACK_HALF_LEN_M + TRUCK_HALF_WID_M || acrossStack > STACK_HALF_WID_M + TRUCK_HALF_WID_M;
          expect(clears, `${routeKey} segment ${i} clears ${yardKey}`).toBe(true);
        }
      }
    }
  });
});

describe('rail corridor — JNPCT-G2 into the terminal', () => {
  const gateOps = [...gateRoles(terminals).keys()].map((gateId) => ({
    gateId,
    terminalId: gateId.split('-')[0]!,
    queueLength: 6,
    transactions: [],
    avgTxnTimeMin: 4,
  }));
  const gates = new Map(
    graphicsFor3d.gates(gateOps as never, terminals).map((g) => {
      const geo = g.geometry as unknown as { longitude: number; latitude: number };
      return [g.attributes.gateId as string, [geo.longitude, geo.latitude] as [number, number]] as const;
    }),
  );
  /** The DRAWN rail lines, keyed by siding (T2's rails are left to the basemap). */
  const lines = new Map(
    railTrackLayer(terminals).graphics.toArray().map((g) => {
      const path = (g.geometry as unknown as { paths: [number, number][][] }).paths[0]!;
      return [g.attributes.siding as string, { start: path[0]!, end: path[path.length - 1]! }] as const;
    }),
  );

  /**
   * The axis each RAKE runs on, drawn or not — for T1 that is its rails, for T2 it
   * is the seeded anchor projected along its own heading.
   */
  const axes = new Map(
    ['T1', 'T2'].map((siding) => {
      const drawn = lines.get(siding);
      if (drawn) return [siding, drawn] as const;
      const seed = placements[`rake:${siding}`]!;
      const rad = ((seed.heading ?? 0) * Math.PI) / 180;
      // Same extents the drawn lines use: the rake trails 144 m of wagons behind
      // its anchor, so the axis has to start behind it too.
      const at = (d: number): [number, number] => [
        seed.lng + (Math.sin(rad) * d) / M_PER_DEG_LON,
        seed.lat + (Math.cos(rad) * d) / M_PER_DEG_LAT,
      ];
      return [siding, { start: at(-200), end: at(800) }] as const;
    }),
  );

  /** Distance (m) from `p` to a given line's axis. */
  function toLine(siding: string, p: [number, number]): number {
    const { start, end } = axes.get(siding)!;
    const ax = (start[0] - p[0]) * M_PER_DEG_LON;
    const ay = (start[1] - p[1]) * M_PER_DEG_LAT;
    const bx = (end[0] - p[0]) * M_PER_DEG_LON;
    const by = (end[1] - p[1]) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy || 1;
    const u = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len));
    return Math.hypot(ax + u * dx, ay + u * dy);
  }

  it('draws rails ONLY for the corridor the basemap does not already show', () => {
    // The satellite imagery already carries the central-yard siding's permanent
    // way, so drawing T2's rails over it rendered a duplicate double track. T2 is
    // rake-only; its train rides the track that is already in the imagery.
    expect(lines.size, 'one drawn rail line').toBe(1);
    expect(lines.has('T1'), 'reference corridor is drawn').toBe(true);
    expect(lines.has('T2'), 'siding rails are left to the basemap').toBe(false);
  });

  it('keeps T1 on the reference corridor', () => {
    const { start, end } = lines.get('T1')!;
    // Pinned to the corridor's own geometry, not to a gate: the rail alignment is
    // fixed in positions.json, and the gates have since been re-sited to the real
    // JNPA layout, so JNPCT-G2 is no longer at the corridor's end.
    expect(start[0]).toBeCloseTo(72.9426, 3);
    expect(start[1]).toBeCloseTo(18.9395, 3);
    expect(end[0]).toBeCloseTo(72.9518, 3);
    expect(end[1]).toBeCloseTo(18.9291, 3);
    expect(metres(start, end), 'T1 length').toBeGreaterThan(1400);
    expect(metres(start, end), 'T1 length').toBeLessThan(1600);
  });

  it('keeps T2 at the original siding alignment', () => {
    const seeded = placements['rake:T2']!;
    // The anchor rake:T1 held before the corridor was traced — its rake still runs
    // here, on the permanent way the basemap already draws.
    expect(seeded.lng).toBe(72.949657);
    expect(seeded.lat).toBe(18.942208);
    expect(seeded.heading).toBe(218);
  });

  it('neither line crosses the container yard, the roads or a gate structure', () => {
    for (const siding of ['T1', 'T2']) {
      for (const [key, v] of Object.entries(placements)) {
        if (!key.startsWith('yard:')) continue;
        expect(toLine(siding, [v.lng, v.lat]), `${siding} clears ${key}`).toBeGreaterThan(60);
      }
      for (const [id, g] of gates) {
        if (siding === 'T1' && id === 'JNPCT-G2') continue; // T1 deliberately terminates here
        // A toll canopy spans ±18 m across the road, so past ~30 m is clear of the
        // structure. JNPCT-G1 is the adjacent carriageway of T1's terminating
        // complex (44 m away) and BMCT-G1 sits beside T1's BMCT end.
        expect(toLine(siding, g), `${siding} clears the ${id} structure`).toBeGreaterThan(30);
      }
      for (const [key, v] of Object.entries(placements)) {
        if (!key.startsWith('truckroute:') || !Array.isArray(v.path)) continue;
        for (const w of v.path) expect(toLine(siding, w), `${siding} clears ${key}`).toBeGreaterThan(40);
      }
    }
  });

  it('runs each rake on its OWN line for the whole shunt cycle', () => {
    const anim = buildSceneAnim(terminals, gateOps as never);
    const layer = anim.layers.find((l) => l.title === '3D · Rail rake (live)')!;
    const cars = layer.graphics.toArray();
    expect(cars.length, 'two rakes of loco + 8 wagons').toBe(18);
    for (let t = 0; t <= 400; t += 20) {
      anim.tick(t, 20);
      for (const g of cars) {
        const geo = g.geometry as unknown as { longitude: number; latitude: number };
        const siding = (g.attributes as { siding: string }).siding;
        // Each rake is derived from the same anchor + heading as its own track, so
        // every car must sit on those rails, not beside them or on the other line.
        expect(toLine(siding, [geo.longitude, geo.latitude]), `t=${t}s ${siding} car is on its rails`).toBeLessThan(2);
      }
    }
    anim.destroy();
  });
});
