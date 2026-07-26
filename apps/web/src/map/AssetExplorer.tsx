/**
 * AssetExplorer — the port-asset tree that pairs with the 3D SceneView, in the
 * spirit of twinship-3d-visualizer's left-hand ontology explorer. It lists every
 * asset in the port (terminals, their berthed vessel, STS cranes, gates, and
 * yard blocks, plus standalone facilities), filterable, grouped by terminal.
 *
 * Selecting a row flies the 3D camera to that asset (via the PortScene handle)
 * and shows a details card below with the asset's live parameters — the 3D scene
 * and the tree stay in sync in both directions (a click in the 3D scene selects
 * the matching row through the shared `selectedId`).
 */
import { useMemo, useState } from 'react';
import {
  CalciteList,
  CalciteListItem,
  CalciteBlock,
  CalciteChip,
  CalciteButton,
} from '@esri/calcite-components-react';
import type { Facility, Terminal } from '@jnpa/schemas';
import type { GateOpsDTO, PendencyDTO } from '@jnpa/data';
import { tokens } from '../theme/tokens.js';

interface AssetExplorerProps {
  terminals: Terminal[];
  facilities: Facility[];
  gateOps: GateOpsDTO[];
  pendency: PendencyDTO[];
  selectedId: string | null;
  /** assetId = position/focus id; pkey = draggable placement key (undefined if not movable). */
  onSelect: (assetId: string, pkey?: string) => void;
}

type AssetKind = 'terminal' | 'vessel' | 'crane' | 'gate' | 'yard' | 'facility' | 'route' | 'rake' | 'tug' | 'channel';

interface AssetNode {
  id: string;
  label: string;
  kind: AssetKind;
  meta?: string;
  /** Placement key matching scene3d's draggable graphics (undefined = not movable). */
  pkey?: string;
}

const KIND_ICON: Record<AssetKind, string> = {
  terminal: 'organization',
  vessel: 'ship',
  crane: 'freehand',
  gate: 'car',
  yard: 'grid',
  facility: 'pin',
  route: 'car', // truck route
  rake: 'train', // rail rake
  tug: 'ship',
  channel: 'line',
};

export function AssetExplorer(props: AssetExplorerProps) {
  const { terminals, facilities, gateOps, pendency, selectedId, onSelect } = props;

  const groups = useMemo(() => buildGroups(terminals, facilities, gateOps, pendency), [terminals, facilities, gateOps, pendency]);
  // Track which section is expanded ourselves — otherwise a re-render (e.g. a
  // live data tick) re-applies `open={gi === 0}` and snaps every other block
  // (STS Cranes, Truck Gates, …) shut the instant you open it.
  const [openTitle, setOpenTitle] = useState<string | null>(() => groups[0]?.title ?? null);
  const selected = useMemo(() => {
    for (const grp of groups) {
      const hit = grp.nodes.find((n) => n.id === selectedId);
      if (hit) return hit;
    }
    return null;
  }, [groups, selectedId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: '8px 10px', borderBottom: `1px solid ${tokens.color.border}` }}>
        <div style={{ fontSize: 12, fontWeight: 600, color: tokens.color.text }}>3D Port Assets</div>
        <div style={{ fontSize: 11, color: tokens.color.textMuted }}>Select an item, then click the map to place it</div>
      </div>
      <div style={{ flex: 1, overflow: 'auto' }}>
        {groups.map((grp) => (
          <CalciteBlock
            key={grp.title}
            heading={grp.title}
            description={grp.movable ? 'movable — click then place on map' : 'reference'}
            collapsible
            open={openTitle === grp.title}
            onCalciteBlockOpen={() => setOpenTitle(grp.title)}
            onCalciteBlockClose={() => setOpenTitle((t) => (t === grp.title ? null : t))}
            iconStart={grp.movable ? 'pin-tear' : 'information'}
          >
            <CalciteList label={grp.title}>
              {grp.nodes.map((n) => (
                <CalciteListItem
                  key={`${n.kind}:${n.id}`}
                  label={n.label}
                  description={n.meta}
                  iconStart={KIND_ICON[n.kind]}
                  selected={n.id === selectedId}
                  onCalciteListItemSelect={() => onSelect(n.id, n.pkey)}
                />
              ))}
            </CalciteList>
          </CalciteBlock>
        ))}
      </div>

      {selected && (
        <CalciteBlock open heading={selected.label} description={kindLabel(selected.kind)} style={{ borderTop: `1px solid ${tokens.color.border}` }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '4px 0 10px' }}>
            <CalciteChip value="kind" scale="s" icon={KIND_ICON[selected.kind]}>{kindLabel(selected.kind)}</CalciteChip>
            {selected.meta && <CalciteChip value="meta" scale="s" kind="brand">{selected.meta}</CalciteChip>}
          </div>
          <CalciteButton width="full" scale="s" iconStart="zoom-to-object" onClick={() => onSelect(selected.id, selected.pkey)}>
            Focus in 3D
          </CalciteButton>
        </CalciteBlock>
      )}
    </div>
  );
}

function kindLabel(k: AssetKind): string {
  switch (k) {
    case 'terminal': return 'Terminal / berth';
    case 'vessel': return 'Berthed vessel';
    case 'crane': return 'Ship-to-shore crane';
    case 'gate': return 'Truck gate';
    case 'yard': return 'Container yard block';
    case 'facility': return 'Facility';
    case 'route': return 'Truck route (live)';
    case 'rake': return 'Rail rake (live)';
    case 'tug': return 'Harbour tug (live)';
    case 'channel': return 'Approach channel';
  }
}

interface AssetGroup {
  /** Section heading, e.g. "Vessels". */
  title: string;
  /** Whether these are movable 3D assets (shown as a hint in the section). */
  movable: boolean;
  nodes: AssetNode[];
}

/**
 * Build the asset list grouped BY TYPE (one clearly-named section per asset
 * kind) rather than by terminal, so the 3D items are easy to find and select:
 *   Vessels · STS Cranes · Truck Gates · Yard Blocks · Terminals · Facilities
 * Each item is prefixed with its terminal for context. Ids/pkeys mirror
 * scene3d.ts exactly so a selection maps to the right 3D graphic.
 */
function buildGroups(
  terminals: Terminal[],
  facilities: Facility[],
  gateOps: GateOpsDTO[],
  pendency: PendencyDTO[],
): AssetGroup[] {
  const gateById = new Map(gateOps.map((g) => [g.gateId, g] as const));
  const pendById = new Map(pendency.map((p) => [p.facilityId, p.pendency] as const));

  const vessels: AssetNode[] = [];
  const cranes: AssetNode[] = [];
  const gates: AssetNode[] = [];
  const yards: AssetNode[] = [];
  const routes: AssetNode[] = [];
  const termNodes: AssetNode[] = [];

  let vesselSeq = 0;
  for (const t of terminals) {
    const pend = pendById.get(t.terminalId);
    termNodes.push({
      id: t.terminalId,
      label: t.name,
      kind: 'terminal',
      meta: `${t.status}${pend != null ? ` · ${pend} pend` : ''}`,
    });
    if (t.status === 'OPERATING') {
      vesselSeq += 1;
      vessels.push({ id: t.terminalId, label: `MV-JNPA-${vesselSeq}`, kind: 'vessel', meta: `berthed · ${t.terminalId}`, pkey: `vessel:${t.terminalId}` });
      // Live truck route (the driving trucks' loop). id → asset3dPosition('route:<T>').
      routes.push({ id: `route:${t.terminalId}`, label: `${t.terminalId} truck route`, kind: 'route', meta: `${t.terminalId} · live`, pkey: `truckroute:${t.terminalId}` });
    }
    // STS cranes — one row per surveyed crane ANCHOR; count/pkey MUST match
    // craneLayer's rule (quay/200, clamped 3..9). Each anchor renders as a berth
    // cluster of 3–4 cranes (see cranePlacements in scene3d.ts); moving the anchor
    // here moves its whole cluster, and the individual cranes in a cluster stay
    // selectable by clicking them in the 3D scene.
    const quay = t.quayLengthM ?? 800;
    const nCranes = Math.max(3, Math.min(9, Math.round(quay / 200)));
    for (let i = 0; i < nCranes; i++) {
      cranes.push({ id: `${t.terminalId}-STS${i + 1}`, label: `${t.terminalId} · STS ${i + 1}`, kind: 'crane', meta: t.terminalId, pkey: `crane:${t.terminalId}:${i}` });
    }
    // Gates
    for (const g of t.gates) {
      const op = gateById.get(g);
      gates.push({ id: g, label: g, kind: 'gate', meta: op ? `${t.terminalId} · queue ${op.queueLength}` : t.terminalId, pkey: `gate3d:${g}` });
    }
    // Yard blocks (matching yardStackLayer: YARD_ROWS×YARD_COLS = 3×4 = 12)
    for (let i = 0; i < 12; i++) {
      yards.push({ id: `${t.terminalId}-Y${i + 1}`, label: `${t.terminalId} · Block ${i + 1}`, kind: 'yard', meta: t.terminalId, pkey: `yard:${t.terminalId}:${i}` });
    }
  }

  const facNodes: AssetNode[] = facilities
    .filter((f) => f.type !== 'TERMINAL' && f.geom.type === 'Point')
    .map((f) => ({ id: f.facilityId, label: f.name, kind: 'facility', meta: `${f.type} · ${f.currentPendency} pend` }));

  // Live movers (the animated assets): the rail rake, the harbour tug, plus the
  // per-terminal truck routes built above. Each carries an anchor pkey so it's
  // selectable, focus-able and movable/rotatable via the transform panel.
  const rakeNodes: AssetNode[] = [
    { id: 'rake:T1', label: 'Rail rake (loco + wagons)', kind: 'rake', meta: 'siding T1 · live', pkey: 'rake:T1' },
  ];
  const referenceNodes: AssetNode[] = [
    { id: 'tug', label: 'Harbour tug', kind: 'tug', meta: 'channel · live', pkey: 'tug' },
    { id: 'channel', label: 'Approach channel', kind: 'channel', meta: 'Thane Creek' },
  ];

  // Movable 3D-asset sections first (that's what edit mode acts on), then the
  // reference sections (terminals, off-port facilities).
  const groups: AssetGroup[] = [
    { title: `Vessels (${vessels.length})`, movable: true, nodes: vessels },
    { title: `STS Cranes (${cranes.length})`, movable: true, nodes: cranes },
    { title: `Truck Gates (${gates.length})`, movable: true, nodes: gates },
    { title: `Truck Routes (${routes.length})`, movable: true, nodes: routes },
    { title: `Rail Rake (${rakeNodes.length})`, movable: true, nodes: rakeNodes },
    { title: `Yard Blocks (${yards.length})`, movable: true, nodes: yards },
    { title: `Reference (${referenceNodes.length})`, movable: true, nodes: referenceNodes },
    { title: `Terminals (${termNodes.length})`, movable: false, nodes: termNodes },
  ];
  if (facNodes.length) groups.push({ title: `Off-Port Facilities (${facNodes.length})`, movable: false, nodes: facNodes });

  return groups.filter((g) => g.nodes.length > 0);
}
