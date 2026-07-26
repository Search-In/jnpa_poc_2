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
import { apronCargoLayer, cranePlacements, gateRoles, graphicsFor3d } from '../src/map/scene3d.js';

const terminals = (terminalsConfig as unknown as { terminals: Terminal[] }).terminals;
const placements = (
  positions as unknown as {
    placements: Record<string, { lng: number; lat: number; path?: [number, number][] }>;
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

  it('grows every anchor into a cluster of 3–4 cranes', () => {
    const perAnchor = new Map<string, number>();
    for (const c of cranes) {
      const parts = c.pkey.split(':');
      const anchor = parts.slice(0, 3).join(':');
      perAnchor.set(anchor, (perAnchor.get(anchor) ?? 0) + 1);
    }
    expect(perAnchor.size).toBe(22); // 3 NSICT + 3 NSIGT + 4 GTI + 9 BMCT + 3 JNPCT
    for (const [anchor, n] of perAnchor) {
      expect(n, `${anchor} cluster size`).toBeGreaterThanOrEqual(3);
      expect(n, `${anchor} cluster size`).toBeLessThanOrEqual(4);
    }
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
      expect(d, `truck at ${tr.attrs.gateId} stays on the approach`).toBeLessThan(110);
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

describe('quay apron cargo', () => {
  const apron = apronCargoLayer(terminals).graphics.toArray().map((g) => {
    const geo = g.geometry as unknown as { longitude: number; latitude: number };
    return [geo.longitude, geo.latitude] as [number, number];
  });

  it('decorates the apron of every terminal', () => {
    expect(apron.length).toBeGreaterThan(20);
  });

  it('keeps the decoration clear of the cranes, the yards and the gate queues', () => {
    // The biggest cargo GLB renders ~15 m across, so ~8 m of separation is the
    // floor for two stacks; the working assets need much more room than that.
    const nearest = (from: [number, number], to: [number, number][]) =>
      Math.min(...to.map((p) => metres(from, p)));
    const cranes = cranePlacements(terminals).map((c) => c.pos);
    const yards = Object.entries(placements)
      .filter(([k]) => k.startsWith('yard:'))
      .map(([, v]) => [v.lng, v.lat] as [number, number]);
    for (const p of apron) {
      expect(nearest(p, cranes), 'apron cargo clears the cranes').toBeGreaterThan(20);
      expect(nearest(p, yards), 'apron cargo clears the yard blocks').toBeGreaterThan(20);
      expect(nearest(p, apron.filter((q) => q !== p)), 'apron cargo clears itself').toBeGreaterThan(16);
    }
  });
});
