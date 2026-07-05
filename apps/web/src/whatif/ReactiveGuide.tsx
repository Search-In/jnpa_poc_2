/**
 * ReactiveGuide — the causal "WHICH / WHERE / HOW / WHY machine" side panel
 * (spec §8.1, scored criterion 5 — the differentiator).
 *
 * While a What-If scenario tour is running, this panel reads the causal DAG
 * (MODULE 1: ./causalGraph.js) and answers, in the spec's order:
 *   - WHICH factors are impacted — the propagation frontier ranked causally
 *     nearest-first (perturbed source at rank 1), each with its net direction
 *     (▲/▼) and, on the perturbed node, the simulated from → to magnitude,
 *   - WHERE — a chip per impacted node that has a geography; hovering/clicking
 *     re-drives the map highlight halos via the optional onSpotlight callback,
 *   - HOW — the mechanism sentence on every traversed edge, rendered as a
 *     lightweight animated "flowing edge" list (A → B: mechanism, lag),
 *   - WHY — the auto-composed plain-language narrative in a callout box
 *     (composeNarrative — pure template assembly, no LLM).
 *
 * It docks TOP-RIGHT (below the shell header) so it never overlaps the
 * GuidedTour coach-mark, which owns the bottom-right corner at zIndex 1000,
 * and it collapses to a pill exactly like GuidedTour does. Fully
 * deterministic: no Date.now(), no Math.random() — everything derives from
 * the causal graph + the active scenario key; the only motion is a CSS
 * keyframe pulse staggered by array index.
 *
 * MODULE 1 contract consumed (./causalGraph.js):
 *   CAUSAL_GRAPH { nodes: CausalNode[]; edges: CausalEdge[] },
 *   propagateScenario(scenarioId) → PropagationEntry[] (deterministic BFS
 *     frontier, ordered by depth then node id; [] for unknown ids),
 *   composeNarrative(graph, frontier, { magnitudes? }) → WHY paragraph,
 *   SCENARIO_PERTURBATION: Record<'S1'..'S6', { node; direction; magnitude? }>.
 *
 * Framing discipline (Integrity Rule): every number shown here is a simulated
 * propagation result under stated assumptions — never a claimed JNPA baseline.
 */
import { useMemo, useState } from 'react';
import { CalciteChip, CalciteIcon } from '@esri/calcite-components-react';
import {
  CAUSAL_GRAPH,
  SCENARIO_PERTURBATION,
  propagateScenario,
  composeNarrative,
  type CausalEdge,
  type CausalNode,
  type Magnitude,
} from './causalGraph.js';
import { useSimStore } from '../sim/useSimStore.js';
import { tokens } from '../theme/tokens.js';

/**
 * The dashboard's tour scenarios (scenarioPlayer.ts) use ids CGO-1 / CGO-2 /
 * CGO-3 / LANE-ASSIGN, while the causal graph's perturbations are keyed by
 * the spec's scripted-scenario ids S1..S6 (§8.4.5). This alias maps the
 * former onto the latter so starting a tour immediately lights up the
 * Reactive Guide. Exported so the integrator can extend it when new
 * storylines land.
 */
export const SCENARIO_KEY_ALIAS: Record<string, string> = {
  'CGO-1': 'S5', // CFS Pendency Spike ≈ trailer/driver-shortage event class
  'CGO-2': 'S2', // Customs Flag Surge ≈ scanner outage / scan-queue balloon
  'CGO-3': 'S3', // Inter-Terminal Optimisation ≈ mixed-train optimization
  'LANE-ASSIGN': 'S4', // Dynamic Lane Assignment ≈ gate closure / congestion
};

/** Resolve a tour scenario id to a causal-graph scenario key, or null. */
function resolveScenarioKey(scenarioId: string): string | null {
  if (scenarioId in SCENARIO_PERTURBATION) return scenarioId;
  const alias = SCENARIO_KEY_ALIAS[scenarioId];
  return alias && alias in SCENARIO_PERTURBATION ? alias : null;
}

/** Node lookup by id — CAUSAL_GRAPH.nodes is an array; index it once. */
const NODE_BY_ID: ReadonlyMap<string, CausalNode> = new Map(
  CAUSAL_GRAPH.nodes.map((n) => [n.id, n]),
);

/** One WHICH row, fully resolved: node + direction + optional magnitude. */
interface ImpactRow {
  node: CausalNode;
  /** '+' = this factor rises under the perturbation, '-' = it falls. */
  netSign: '+' | '-';
  /** Simulated from → to on the perturbed source node (shadow-run figure). */
  magnitude?: Magnitude;
}

/** Everything the panel renders, derived once per scenario key. */
interface GuideModel {
  scenarioKey: string;
  impacted: ImpactRow[];
  whereNodes: CausalNode[]; // impacted nodes that carry a geography
  edges: CausalEdge[]; // traversed edges, in propagation order
  narrative: string;
}

/**
 * Build the panel's model from the causal graph. Pure and deterministic —
 * propagateScenario()/composeNarrative() are graph/template computations (no
 * LLM, no clock, no randomness), so this is safe to memoise on the scenario
 * key alone. Returns null for an unknown key or an empty frontier so the
 * panel renders nothing rather than an empty shell.
 */
function buildGuideModel(scenarioKey: string): GuideModel | null {
  const frontier = propagateScenario(scenarioKey);
  const perturbation = SCENARIO_PERTURBATION[scenarioKey];
  if (frontier.length === 0 || !perturbation) return null;

  // WHICH — the frontier arrives ordered (depth, then node id): the perturbed
  // source first, then causally nearest factors. Render in that rank order.
  const impacted: ImpactRow[] = [];
  for (const entry of frontier) {
    const node = NODE_BY_ID.get(entry.nodeId);
    if (!node) continue; // defensive: unknown node id in the frontier
    const row: ImpactRow = { node, netSign: entry.netSign };
    if (entry.nodeId === perturbation.node && perturbation.magnitude) {
      row.magnitude = perturbation.magnitude;
    }
    impacted.push(row);
  }

  const whereNodes = impacted
    .map((r) => r.node)
    .filter((n) => Array.isArray(n.geo) && n.geo.length > 0);

  // HOW — each frontier entry carries its full path edges; the LAST edge of
  // each non-source entry is the edge that reached it, so the deduped union
  // of last edges is exactly the BFS propagation tree, in propagation order.
  const edges: CausalEdge[] = [];
  const seenEdges = new Set<string>();
  for (const entry of frontier) {
    const last = entry.edges[entry.edges.length - 1];
    if (!last) continue; // the depth-0 source has no inbound edge
    const key = `${last.from}->${last.to}`;
    if (seenEdges.has(key)) continue;
    seenEdges.add(key);
    edges.push(last);
  }

  // WHY — pin the scenario's simulated magnitude onto the source node so the
  // narrative quotes "from ~A to ~B within simulation" (never a baseline).
  const narrative = composeNarrative(
    CAUSAL_GRAPH,
    frontier,
    perturbation.magnitude
      ? { magnitudes: { [perturbation.node]: perturbation.magnitude } }
      : undefined,
  );

  return { scenarioKey, impacted, whereNodes, edges, narrative };
}

/** Small uppercase section header — WHICH / WHERE / HOW / WHY. */
function SectionHeader({ word, rest }: { word: string; rest: string }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'baseline', gap: 6, margin: '10px 0 6px',
        fontSize: 11, letterSpacing: 0.8, textTransform: 'uppercase',
      }}
    >
      <strong style={{ color: tokens.color.brand }}>{word}</strong>
      <span style={{ color: tokens.color.textMuted }}>{rest}</span>
    </div>
  );
}

export function ReactiveGuide({ onSpotlight }: { onSpotlight?: (assetIds: string[]) => void }) {
  const sim = useSimStore();
  const scenarioId = sim.tour.scenarioId;

  // Collapse to a compact pill so the panel never blocks the board.
  const [collapsed, setCollapsed] = useState(false);

  const scenarioKey = scenarioId ? resolveScenarioKey(scenarioId) : null;
  const model = useMemo(
    () => (scenarioKey ? buildGuideModel(scenarioKey) : null),
    [scenarioKey],
  );

  // No active scenario (or no causal mapping for it) → render nothing.
  if (!scenarioId || !model) return null;

  if (collapsed) {
    return (
      <button
        onClick={() => setCollapsed(false)}
        aria-label="Expand reactive causality guide"
        style={{
          position: 'fixed', top: 128, right: 16, zIndex: 990,
          display: 'flex', alignItems: 'center', gap: 8,
          background: tokens.color.brand, color: '#fff', border: 'none',
          borderRadius: 999, padding: '8px 14px', cursor: 'pointer',
          boxShadow: '0 8px 24px rgba(12,20,33,0.28)', fontSize: 13, fontWeight: 600,
        }}
      >
        <CalciteIcon icon="lightbulb" scale="s" />
        Reactive Guide
        <CalciteIcon icon="chevron-down" scale="s" />
      </button>
    );
  }

  return (
    <>
      {/* One-time keyframes for the "flowing edge" pulse in the HOW list. */}
      <style>{`
        @keyframes jnpaCausalFlow {
          0%   { opacity: 0.25; transform: translateX(-2px); }
          50%  { opacity: 1;    transform: translateX(2px); }
          100% { opacity: 0.25; transform: translateX(-2px); }
        }
      `}</style>

      <aside
        role="complementary"
        aria-label="Reactive causality guide"
        style={{
          position: 'fixed',
          top: 128, // below the shell header + tab bar; GuidedTour owns bottom-right
          right: 16,
          width: 'min(360px, calc(100vw - 32px))',
          maxHeight: 'min(560px, calc(100vh - 300px))',
          overflowY: 'auto',
          background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)',
          zIndex: 990, // just under the GuidedTour coach-mark (1000)
        }}
      >
        {/* Header — brand strip, mirrors GuidedTour's header treatment. */}
        <div
          style={{
            position: 'sticky', top: 0,
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', background: tokens.color.brand, color: '#fff',
            borderRadius: '12px 12px 0 0', zIndex: 1,
          }}
        >
          <CalciteIcon icon="lightbulb" scale="s" />
          <strong style={{ fontSize: 13 }}>Reactive Guide · causal propagation</strong>
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Minimise"
            title="Minimise"
            style={{
              marginLeft: 'auto', background: 'transparent', border: 'none',
              color: '#fff', cursor: 'pointer', display: 'flex', padding: 2,
            }}
          >
            <CalciteIcon icon="chevron-up" scale="s" />
          </button>
        </div>

        {/* Persistent honesty caption (Integrity Rule) — always visible. */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            margin: '8px 12px 0', padding: '4px 8px',
            background: 'rgba(242,169,59,0.12)', border: '1px solid #f2a93b55',
            borderRadius: 8, fontSize: 11, color: tokens.color.textMuted,
          }}
        >
          <CalciteIcon icon="information" scale="s" />
          <span>
            Simulated causal propagation under stated assumptions — not a claimed JNPA baseline.
          </span>
        </div>

        <div style={{ padding: '2px 12px 12px' }}>
          {/* ---------------- WHICH — ranked impacted factors ---------------- */}
          <SectionHeader word="Which" rest="factors are impacted (ranked)" />
          <ol style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
            {model.impacted.map((row, i) => (
              <li
                key={row.node.id}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  border: `1px solid ${tokens.color.border}`, borderRadius: 8,
                  padding: '5px 8px', fontSize: 12, background: tokens.color.bgElevated,
                }}
              >
                <span
                  style={{
                    minWidth: 16, textAlign: 'center', fontSize: 11, fontWeight: 700,
                    color: tokens.color.textMuted,
                  }}
                >
                  {i + 1}
                </span>
                {/* Net direction of the factor — direction, not a verdict. */}
                <span
                  aria-label={row.netSign === '+' ? 'rises' : 'falls'}
                  style={{ fontWeight: 700, color: tokens.color.brand }}
                >
                  {row.netSign === '+' ? '▲' : '▼'}
                </span>
                <span style={{ color: tokens.color.text, flex: 1 }}>{row.node.label}</span>
                {row.magnitude && (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 4, whiteSpace: 'nowrap' }}>
                    <span style={{ color: tokens.color.textMuted }}>{row.magnitude.from}</span>
                    <CalciteIcon icon="arrow-right" scale="s" />
                    <strong style={{ color: tokens.color.text }}>
                      {row.magnitude.to}
                      {row.magnitude.unit ? ` ${row.magnitude.unit}` : ''}
                    </strong>
                  </span>
                )}
              </li>
            ))}
          </ol>

          {/* ---------------- WHERE — geographies to ring on the map ---------------- */}
          {model.whereNodes.length > 0 && (
            <>
              <SectionHeader word="Where" rest="hover to ring it on the map" />
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {model.whereNodes.map((node) => (
                  <span
                    key={node.id}
                    role="button"
                    tabIndex={0}
                    onMouseEnter={() => onSpotlight?.(node.geo ?? [])}
                    onFocus={() => onSpotlight?.(node.geo ?? [])}
                    onClick={() => onSpotlight?.(node.geo ?? [])}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') onSpotlight?.(node.geo ?? []);
                    }}
                    style={{ cursor: 'pointer', display: 'inline-flex' }}
                    title={`Highlight on map: ${(node.geo ?? []).join(', ')}`}
                  >
                    <CalciteChip scale="s" value={node.id} icon="pin-tear">
                      {node.label}
                    </CalciteChip>
                  </span>
                ))}
              </div>
            </>
          )}

          {/* ---------------- HOW — the mechanism on each traversed edge ---------------- */}
          {model.edges.length > 0 && (
            <>
              <SectionHeader word="How" rest="mechanism on each edge" />
              <div style={{ display: 'grid', gap: 4 }}>
                {model.edges.map((edge, i) => {
                  const fromLabel = NODE_BY_ID.get(edge.from)?.label ?? edge.from;
                  const toLabel = NODE_BY_ID.get(edge.to)?.label ?? edge.to;
                  return (
                    <div
                      key={`${edge.from}->${edge.to}`}
                      style={{
                        display: 'flex', alignItems: 'flex-start', gap: 6,
                        fontSize: 12, lineHeight: 1.4, padding: '3px 2px',
                        borderLeft: `2px solid ${tokens.color.brand}44`, paddingLeft: 8,
                      }}
                    >
                      {/* Animated flowing-edge flavour — staggered deterministically by index. */}
                      <span
                        aria-hidden
                        style={{
                          color: tokens.color.brand, fontWeight: 700, marginTop: 1,
                          animation: 'jnpaCausalFlow 1.8s ease-in-out infinite',
                          animationDelay: `${i * 0.2}s`,
                        }}
                      >
                        {'▸'}
                      </span>
                      <span style={{ color: tokens.color.text }}>
                        <strong>{fromLabel}</strong>
                        {' → '}
                        <strong>{toLabel}</strong>
                        <span style={{ color: tokens.color.textMuted }}>
                          {': '}{edge.mechanism} (lag {edge.lag})
                        </span>
                      </span>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ---------------- WHY — the composed causal narrative ---------------- */}
          <SectionHeader word="Why" rest="plain-language causal narrative" />
          <div
            style={{
              background: 'rgba(26,115,194,0.08)',
              border: `1px solid ${tokens.color.brand}33`,
              borderLeft: `3px solid ${tokens.color.brand}`,
              borderRadius: 8, padding: '8px 10px',
              fontSize: 12.5, lineHeight: 1.5, color: tokens.color.text,
            }}
          >
            {model.narrative}
          </div>
        </div>
      </aside>
    </>
  );
}
