/**
 * causalGraph — the explicit causal dependency DAG of the port (spec §8.1,
 * scored criterion 5: "what-if scenarios demonstrating interdependencies +
 * automated workflows proving reactive nature"). This is the "how, where,
 * which, why" machine behind the Reactive Guide:
 *
 *   - nodes  = operational factors (driver availability, trailer pool, gate
 *     lane capacity, scanner capacity, siding/yard occupancy, CFS acceptance,
 *     rake arrivals, ITRHO tempo, reefer plugs, weather, DPD share, pendency
 *     buckets) plus the canonical KPI sinks from services/kpi,
 *   - edges  = directed influences with a sign, a plain mechanism sentence and
 *     a typical propagation lag ("driver availability ↓ → trailer placements ↓
 *     (lag 2–4 h) → CFS evacuation ↓ → import pendency ↑ → …"),
 *   - propagate() walks the frontier from a perturbed node (deterministic BFS,
 *     no Math.random / Date.now) tracking the cumulative sign and path,
 *   - composeNarrative() turns a frontier into a plain-language WHY paragraph
 *     by pure template assembly — no LLM, replayable on seed 42,
 *   - SCENARIO_PERTURBATION maps scenarios S1..S6 to their primary perturbed
 *     node so the Reactive Guide can call propagate() for the active scenario.
 *
 * Honesty framing (hard rule): every magnitude the narrative emits is a
 * simulated / modelled figure under stated assumptions — never a claimed JNPA
 * baseline improvement. Pure TS, no imports, fully unit-testable.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which way a node was pushed (S5: driver availability goes 'down' 30%). */
export type Direction = 'up' | 'down';

/** One operational factor / KPI in the port's causal DAG. */
export interface CausalNode {
  id: string;
  label: string;
  /** lever = operator/scenario input; state = intermediate; kpi = sink. */
  kind: 'lever' | 'state' | 'kpi';
  unit?: string;
  /** Which map asset(s) this node lives at, for WHERE highlighting. */
  geo?: string[];
  /** Optional dashboard tab where this node is visible (Dashboard TABS id). */
  tab?: string;
}

/** A directed influence between two nodes. */
export interface CausalEdge {
  from: string;
  to: string;
  /** '+' = endpoints move together; '-' = they move opposite ways. */
  sign: '+' | '-';
  /** Plain mechanism sentence, e.g. "fewer trailer placements". */
  mechanism: string;
  /** Typical propagation lag, human string e.g. "2–6 h". */
  lag: string;
}

/** The whole DAG, so propagate() can be tested against synthetic graphs too. */
export interface CausalGraph {
  nodes: CausalNode[];
  edges: CausalEdge[];
}

/** One node on the propagation frontier returned by propagate(). */
export interface PropagationEntry {
  nodeId: string;
  /** Hops from the perturbed source (0 = the source itself). */
  depth: number;
  /** Node ids from the source to this node (inclusive both ends). */
  pathFromSource: string[];
  /**
   * Resulting direction of THIS node given the perturbation: the product of
   * edge signs along the path, times the source direction. '+' = it rises,
   * '-' = it falls. For the source itself this is just the perturbation sign.
   */
  netSign: '+' | '-';
  /** The edges traversed from the source to this node, in order. */
  edges: CausalEdge[];
}

/** A shadow-run magnitude the narrative can pin to a node (simulated values). */
export interface Magnitude {
  from: number;
  to: number;
  unit?: string;
}

/** How a scenario perturbs the graph: primary node + direction (+ magnitude). */
export interface ScenarioPerturbation {
  node: string;
  direction: Direction;
  magnitude?: Magnitude;
}

// ---------------------------------------------------------------------------
// The port graph. Node ids are stable keys the Reactive Guide references;
// geo ids are real assets from config/terminals.json + the mock facilities so
// WHERE-highlighting rings actual map markers; tab ids match Dashboard TABS.
// KPI sink ids are the EXACT canonical keys from services/kpi/src/kpis.ts.
// ---------------------------------------------------------------------------

const CFS_BELT = ['CFS-DRONAGIRI-1', 'CFS-URAN-1', 'CFS-PANVEL-1'];
const GATES = ['NSICT-G1', 'NSIGT-G1', 'GTI-G2', 'BMCT-G1'];
const SIDINGS = ['T1', 'T2'];
const TERMINALS = ['GTI', 'BMCT', 'NSICT', 'NSIGT', 'JNPCT'];

export const CAUSAL_NODES: CausalNode[] = [
  // --- levers (what scenarios and operators actually move) -----------------
  { id: 'driverAvailability', label: 'Trailer-driver availability', kind: 'lever', unit: '%', geo: CFS_BELT, tab: 'movements' },
  { id: 'gateLaneCapacity', label: 'Open gate lanes', kind: 'lever', unit: 'lanes', geo: GATES, tab: 'gate' },
  { id: 'scannerCapacity', label: 'Operating scanners', kind: 'lever', unit: 'scanners', geo: ['NSICT'], tab: 'scan' },
  { id: 'rakeArrivalRate', label: 'Inbound rake arrivals', kind: 'lever', unit: 'rakes/day', geo: SIDINGS, tab: 'rail' },
  { id: 'itrhoTransferRate', label: 'ITRHO transfer tempo', kind: 'lever', unit: 'moves/day', geo: ['GTI', 'NSICT', 'BMCT'], tab: 'movements' },
  { id: 'reeferPlugs', label: 'Serviceable reefer plugs', kind: 'lever', unit: 'plugs', tab: 'pendency' },
  { id: 'weatherMultiplier', label: 'Weather severity', kind: 'lever', unit: '×' },
  { id: 'dpdShare', label: 'DPD share of imports', kind: 'lever', unit: '%', tab: 'pendency' },

  // --- intermediate states (where the cascade travels) ---------------------
  { id: 'trailerPool', label: 'Trailers in circulation', kind: 'state', unit: 'trailers', geo: CFS_BELT, tab: 'movements' },
  { id: 'cfsAcceptanceRate', label: 'CFS acceptance rate', kind: 'state', unit: 'TEU/day', geo: CFS_BELT, tab: 'pendency' },
  { id: 'sidingOccupancy', label: 'Rail siding occupancy', kind: 'state', unit: '%', geo: SIDINGS, tab: 'rail' },
  { id: 'yardOccupancy', label: 'Terminal yard occupancy', kind: 'state', unit: '%', geo: TERMINALS, tab: 'pendency' },
  { id: 'importPendency', label: 'Import pendency (yard)', kind: 'state', unit: 'TEU', geo: TERMINALS, tab: 'pendency' },
  { id: 'over15dayPendency', label: '>15-day pendency bucket', kind: 'state', unit: 'containers', tab: 'pendency' },
  { id: 'gateQueue', label: 'Gate approach queue', kind: 'state', unit: 'trucks', geo: GATES, tab: 'gate' },

  // --- KPI sinks (canonical keys from services/kpi/src/kpis.ts) ------------
  { id: 'rakeTurnaroundTime', label: 'Rake turnaround time', kind: 'kpi', unit: 'h', geo: SIDINGS, tab: 'rail' },
  { id: 'bufferPendency', label: 'Buffer-yard pendency', kind: 'kpi', unit: 'containers', tab: 'pendency' },
  { id: 'scannerTurnaroundTime', label: 'Scanner turnaround time', kind: 'kpi', unit: 'min', tab: 'scan' },
  { id: 'gateTransactionTime', label: 'Gate transaction time', kind: 'kpi', unit: 'min', geo: GATES, tab: 'gate' },
  { id: 'interTerminalTransferTat', label: 'Inter-terminal transfer TAT', kind: 'kpi', unit: 'h', tab: 'movements' },
  { id: 'mixedTrainOptimization', label: 'Mixed-train optimization', kind: 'kpi', unit: '%', tab: 'rail' },
  { id: 'trailerTurnaroundTime', label: 'Trailer turnaround time', kind: 'kpi', unit: 'min', tab: 'movements' },
];

/**
 * Directed influences, faithful to real port causality. Sign reads as
 * "endpoints move together (+) / opposite (-)"; mechanism is the sentence the
 * narrative splices in; lag is the typical propagation delay quoted to the
 * viewer (illustrative, matches the sim's time constants).
 */
export const CAUSAL_EDGES: CausalEdge[] = [
  // Driver / trailer / CFS evacuation chain (the S5 May-2026 event class)
  { from: 'driverAvailability', to: 'trailerPool', sign: '+', mechanism: 'rostered drivers put trailers into circulation — no driver, no trip', lag: '2–4 h' },
  { from: 'weatherMultiplier', to: 'trailerPool', sign: '-', mechanism: 'monsoon road conditions cut effective trips per trailer shift', lag: '1–2 h' },
  { from: 'trailerPool', to: 'cfsAcceptanceRate', sign: '+', mechanism: 'trailer placements set the CFS evacuation tempo', lag: '2–6 h' },
  { from: 'trailerPool', to: 'itrhoTransferRate', sign: '+', mechanism: 'inter-terminal runs draw on the same trailer pool', lag: '1–3 h' },
  { from: 'cfsAcceptanceRate', to: 'importPendency', sign: '-', mechanism: 'the CFS evacuation tempo sets how fast the terminal import stack drains', lag: '6–12 h' },
  { from: 'dpdShare', to: 'importPendency', sign: '-', mechanism: 'DPD boxes bypass CFS staging and clear direct from the terminal', lag: '1–2 days' },
  { from: 'reeferPlugs', to: 'importPendency', sign: '-', mechanism: 'unplugged reefers force priority evacuation that displaces scheduled deliveries', lag: '2–6 h' },

  // Scanning
  { from: 'scannerCapacity', to: 'scannerTurnaroundTime', sign: '-', mechanism: 'fewer operating scanners means fewer scan slots per hour', lag: '1–2 h' },
  { from: 'scannerCapacity', to: 'importPendency', sign: '-', mechanism: 'boxes held for scanning cannot be delivered or transhipped', lag: '4–8 h' },

  // Pendency ageing + overflow
  { from: 'importPendency', to: 'over15dayPendency', sign: '+', mechanism: 'boxes that linger age into the >15-day dwell bucket', lag: '3–5 days' },
  { from: 'importPendency', to: 'yardOccupancy', sign: '+', mechanism: 'un-evacuated imports keep occupying yard ground slots', lag: '6–12 h' },
  { from: 'importPendency', to: 'bufferPendency', sign: '+', mechanism: 'terminal overflow rolls out to buffer and parking yards', lag: '12–24 h' },

  // Yard congestion feedback onto handling speed
  { from: 'yardOccupancy', to: 'gateTransactionTime', sign: '+', mechanism: 'congested blocks slow yard-crane positioning per gate move', lag: '1–3 h' },
  { from: 'yardOccupancy', to: 'trailerTurnaroundTime', sign: '+', mechanism: 'trailers wait longer under the yard crane in dense blocks', lag: '1–3 h' },

  // Gate complex
  { from: 'gateLaneCapacity', to: 'gateQueue', sign: '-', mechanism: 'with fewer open lanes, truck arrivals outpace lane service', lag: '30–60 min' },
  { from: 'gateQueue', to: 'gateTransactionTime', sign: '+', mechanism: 'trucks queue before processing, stretching end-to-end lane time', lag: '15–45 min' },
  { from: 'gateQueue', to: 'trailerTurnaroundTime', sign: '+', mechanism: 'CFS and ITT trailers stand in the same approach queue', lag: '30–90 min' },
  { from: 'weatherMultiplier', to: 'gateTransactionTime', sign: '+', mechanism: 'rain slows seal checks and inspection at the lane', lag: 'immediate' },

  // Rail side
  { from: 'rakeArrivalRate', to: 'sidingOccupancy', sign: '+', mechanism: 'more inbound rakes contend for the same siding slots', lag: '1–2 h' },
  { from: 'rakeArrivalRate', to: 'importPendency', sign: '-', mechanism: 'each rake worked at the siding departs with ~90 TEU of imports off the terminal stack', lag: '12–24 h' },
  { from: 'sidingOccupancy', to: 'rakeTurnaroundTime', sign: '+', mechanism: 'rakes wait on approach when sidings are occupied', lag: '1–4 h' },
  { from: 'sidingOccupancy', to: 'mixedTrainOptimization', sign: '-', mechanism: 'siding slot conflicts force sub-optimal wagon split plans', lag: '2–6 h' },

  // ITRHO / mixed-train chain (S3)
  { from: 'itrhoTransferRate', to: 'interTerminalTransferTat', sign: '-', mechanism: 'trailer batch size drives per-box transfer time', lag: '2–4 h' },
  { from: 'itrhoTransferRate', to: 'mixedTrainOptimization', sign: '+', mechanism: 'trailer batching decides whether a mixed rake can be worked at one terminal', lag: '4–8 h' },
  { from: 'itrhoTransferRate', to: 'sidingOccupancy', sign: '-', mechanism: "single-point rake handling decides whether the second terminal's siding stays tied up", lag: '2–6 h' },
];

/** The default graph the Reactive Guide propagates over. */
export const CAUSAL_GRAPH: CausalGraph = { nodes: CAUSAL_NODES, edges: CAUSAL_EDGES };

// ---------------------------------------------------------------------------
// Propagation
// ---------------------------------------------------------------------------

/**
 * Walk the downstream frontier from a perturbed node.
 *
 * BFS over out-edges: each reachable node is reported once, at its shortest
 * causal distance, with the path and traversed edges kept. `direction` is
 * which way the SOURCE was pushed; each entry's `netSign` is the product of
 * the edge signs along its path times that source direction, i.e. the way the
 * entry's node itself moves. Where two same-length paths reach a node, the
 * lexicographically smallest expansion wins — ordering is fully deterministic
 * (depth, then node id; no Math.random anywhere).
 */
export function propagate(
  graph: CausalGraph,
  perturbedNodeId: string,
  direction: Direction,
): PropagationEntry[] {
  const known = new Set(graph.nodes.map((n) => n.id));
  if (!known.has(perturbedNodeId)) return [];

  // Adjacency with a stable, sorted expansion order.
  const out = new Map<string, CausalEdge[]>();
  for (const edge of graph.edges) {
    const list = out.get(edge.from);
    if (list) list.push(edge);
    else out.set(edge.from, [edge]);
  }
  for (const list of out.values()) list.sort((a, b) => (a.to < b.to ? -1 : a.to > b.to ? 1 : 0));

  const sourceSign: '+' | '-' = direction === 'up' ? '+' : '-';
  const source: PropagationEntry = {
    nodeId: perturbedNodeId,
    depth: 0,
    pathFromSource: [perturbedNodeId],
    netSign: sourceSign,
    edges: [],
  };

  const visited = new Set<string>([perturbedNodeId]);
  const frontier: PropagationEntry[] = [source];
  const queue: PropagationEntry[] = [source];

  while (queue.length > 0) {
    const current = queue.shift() as PropagationEntry; // non-empty by loop guard
    for (const edge of out.get(current.nodeId) ?? []) {
      if (visited.has(edge.to)) continue;
      visited.add(edge.to);
      const next: PropagationEntry = {
        nodeId: edge.to,
        depth: current.depth + 1,
        pathFromSource: [...current.pathFromSource, edge.to],
        netSign: edge.sign === '+' ? current.netSign : current.netSign === '+' ? '-' : '+',
        edges: [...current.edges, edge],
      };
      frontier.push(next);
      queue.push(next);
    }
  }

  // BFS already yields depth order; re-sort defensively by (depth, node id).
  frontier.sort((a, b) =>
    a.depth !== b.depth ? a.depth - b.depth : a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0,
  );
  return frontier;
}

// ---------------------------------------------------------------------------
// Narrative composition (the WHY panel) — pure templates, no LLM.
// ---------------------------------------------------------------------------

export interface NarrativeOptions {
  /** Shadow-run magnitudes per node id — simulated values, pinned inline. */
  magnitudes?: Record<string, Magnitude>;
}

/** Closing caption every narrative carries (honesty framing, spec hard rule). */
export const NARRATIVE_CAPTION =
  'All movements are simulated within the twin under stated assumptions — modelled behaviour, not a claimed JNPA baseline.';

/** Deterministic thousands formatting without locale dependence. */
function fmt(n: number): string {
  const rounded = Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10;
  const [intPart, decPart] = String(rounded).split('.');
  const grouped = (intPart ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return decPart ? `${grouped}.${decPart}` : grouped;
}

/**
 * Compose the plain-language WHY paragraph from a propagation frontier.
 *
 * Template shape: "Because <source> falls (from ~A to ~B within simulation),
 * <depth-1 effects with mechanism + lag>. In turn, <depth-2 effects>. …"
 * plus the standing simulated/modelled caption. Deterministic string
 * assembly only; magnitudes (when provided) come from the shadow run and are
 * always framed as simulated figures, never baseline claims.
 */
export function composeNarrative(
  graph: CausalGraph,
  frontier: PropagationEntry[],
  opts?: NarrativeOptions,
): string {
  const source = frontier[0];
  if (!source || source.depth !== 0) return NARRATIVE_CAPTION;

  const labels = new Map<string, string>();
  for (const node of graph.nodes) labels.set(node.id, node.label);
  const labelOf = (id: string): string => labels.get(id) ?? id;
  const verbOf = (sign: '+' | '-'): string => (sign === '+' ? 'rises' : 'falls');
  const magOf = (id: string): string => {
    const m = opts?.magnitudes?.[id];
    if (!m) return '';
    const unit = m.unit ? (m.unit === '%' ? '%' : ` ${m.unit}`) : '';
    return ` from ~${fmt(m.from)}${unit} to ~${fmt(m.to)}${unit} within simulation`;
  };

  const clauseOf = (entry: PropagationEntry): string => {
    const lastEdge = entry.edges[entry.edges.length - 1];
    const base = `${labelOf(entry.nodeId)} ${verbOf(entry.netSign)}${magOf(entry.nodeId)}`;
    return lastEdge ? `${base} (${lastEdge.mechanism}; lag ${lastEdge.lag})` : base;
  };

  // Group downstream entries by depth; propagate() already ordered them.
  const byDepth = new Map<number, PropagationEntry[]>();
  for (const entry of frontier) {
    if (entry.depth === 0) continue;
    const bucket = byDepth.get(entry.depth);
    if (bucket) bucket.push(entry);
    else byDepth.set(entry.depth, [entry]);
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b);

  const opening = `Because ${labelOf(source.nodeId)} ${verbOf(source.netSign)}${magOf(source.nodeId)}`;
  if (depths.length === 0) {
    return `${opening}, no downstream factor moves in this graph. ${NARRATIVE_CAPTION}`;
  }

  const sentences: string[] = [];
  const connectors = ['In turn,', 'Downstream,', 'Further out,'];
  for (let i = 0; i < depths.length; i++) {
    const depth = depths[i];
    if (depth === undefined) continue;
    const clauses = (byDepth.get(depth) ?? []).map(clauseOf).join('; ');
    if (i === 0) {
      sentences.push(`${opening}, ${clauses}.`);
    } else {
      const connector = connectors[Math.min(i - 1, connectors.length - 1)] ?? 'Further out,';
      sentences.push(`${connector} ${clauses}.`);
    }
  }
  sentences.push(NARRATIVE_CAPTION);
  return sentences.join(' ');
}

// ---------------------------------------------------------------------------
// Scenario wiring (spec §8.4.5, S1..S6) — the primary perturbed node per
// scenario, so the Reactive Guide calls propagate() for whichever scenario is
// live. Magnitudes are the scripted shadow-run figures (simulated, seed 42).
// ---------------------------------------------------------------------------

export const SCENARIO_PERTURBATION: Record<string, ScenarioPerturbation> = {
  /** S1 — rake delay cascade: bunched arrivals jam the sidings. */
  S1: { node: 'sidingOccupancy', direction: 'up', magnitude: { from: 62, to: 91, unit: '%' } },
  /** S2 — scanner outage: 1 of 2 scanners down for 8 h. */
  S2: { node: 'scannerCapacity', direction: 'down', magnitude: { from: 2, to: 1, unit: 'scanners' } },
  /** S3 — mixed-train optimization: ITRHO batching lifts the transfer tempo. */
  S3: { node: 'itrhoTransferRate', direction: 'up', magnitude: { from: 320, to: 540, unit: 'moves/day' } },
  /** S4 — gate closure: NSICT complex loses 3 of 6 lanes for 4 h. */
  S4: { node: 'gateLaneCapacity', direction: 'down', magnitude: { from: 6, to: 3, unit: 'lanes' } },
  /** S5 — trailer-driver shortage (May-2026 event class): availability −30%. */
  S5: { node: 'driverAvailability', direction: 'down', magnitude: { from: 100, to: 70, unit: '%' } },
  /** S6 — reefer surge: 20 CPP plugs failed under a discharge spike. */
  S6: { node: 'reeferPlugs', direction: 'down', magnitude: { from: 120, to: 100, unit: 'plugs' } },
};

/**
 * Convenience: the propagation frontier for a scenario id (S1..S6) over the
 * default graph. Returns [] for unknown ids so callers can render nothing.
 */
export function propagateScenario(scenarioId: string): PropagationEntry[] {
  const perturbation = SCENARIO_PERTURBATION[scenarioId];
  if (!perturbation) return [];
  return propagate(CAUSAL_GRAPH, perturbation.node, perturbation.direction);
}
