/**
 * UC-2 scenario studio — the two UC-2 What-If requirements, computed IN THIS
 * APP by the pure engines in @jnpa/data (packages/data/src/uc2), not fetched
 * from the UC-3 backend:
 *
 *   1. Additional Export Containers Loading — revised load list, asset plan,
 *      loading completion and sailing impact after extra export boxes are
 *      requested once planning is concluded.
 *   2. Multiple Yard Blocks at Peak RTG Demand — utilization, waiting, queues,
 *      productivity and throughput under four dispatch strategies, with a
 *      transparent top-two recommendation.
 *
 * Presentation reuses the shared four-beat WhatIfAnswer (verdict → picture →
 * actions → the working) and the audited-answer stylesheet, so a locally
 * computed answer reads exactly like a remotely computed one — provenance
 * chips, query trace and all. Both scenarios are non-destructive: the engines
 * take a read-only copy of adapter data and never write anything back.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteNotice,
} from '@esri/calcite-components-react';
import type { ContainerMovementDTO, StrategyMetrics, Uc2AnswerResult } from '@jnpa/data';
import {
  DEFAULT_RTG_PARAMS, MockAdapter, nominalYardBlocks, runExportLoadingScenario,
  runRtgPeakScenario, UC2_HYPOTHETICAL_NOTICE,
} from '@jnpa/data';
import type { BaselinesConfig } from '@jnpa/kpi';
import type { Terminal } from '@jnpa/schemas';
import baselinesConfig from '../../../../config/baselines.json';
import terminalsConfig from '../../../../config/terminals.json';
import uc2Config from '../../../../config/uc2-whatif.json';
import { useApp } from '../state/AppContext.js';
import './auditedAnswer.css';
import WhatIfAnswer from './WhatIfAnswer';

const CLASSES = {
  root: 'aa-root', verdict: 'aa-verdict', headline: 'aa-headline', detail: 'aa-detail',
  banner: 'aa-banner', section: 'aa-section', actions: 'aa-actions', action: 'aa-action',
  evidence: 'aa-evidence', summary: 'aa-summary', table: 'aa-table', chip: 'aa-chip',
} as const;

const CFG_RATE = (uc2Config as any).exportLoading.berthMovesPerHour.value as number;
const CFG_RTG = (uc2Config as any).rtg;

const label = { fontSize: 12, fontWeight: 600 as const, display: 'block', marginTop: 8 };
const numInput = { width: 90, padding: '4px 6px', fontSize: 13 };

/** Original-vs-revised picture for the export-loading answer. */
function LoadingComparison({ result }: { result: Uc2AnswerResult }) {
  const r = result.result as any;
  if (!r?.original) return null;
  const rows: Array<[string, unknown, unknown]> = [
    ['Boxes on the load list', r.original.boxes, r.revised.boxes],
    ['Gross weight (kg)', r.original.gross_weight_kg, r.revised.gross_weight_kg],
    ['Reefers', r.original.reefers, r.revised.reefers],
    ['Hazmat', r.original.hazmat, r.revised.hazmat],
    ['Loading completion (anchored)', r.timing.original_completion, r.timing.revised_completion],
    ['Sailing plan', r.sailing.original, `${r.sailing.revised} (+${r.sailing.delay_hours} h derived)`],
  ];
  return (
    <table className="aa-table">
      <thead>
        <tr><th scope="col" /><th scope="col">Original</th><th scope="col">Simulated (revised)</th></tr>
      </thead>
      <tbody>
        {rows.map(([k, a, b]) => (
          <tr key={k}><th scope="row">{k}</th><td>{String(a)}</td><td>{String(b)}</td></tr>
        ))}
      </tbody>
    </table>
  );
}

/** Strategy table + the two recommended plans for the RTG answer. */
function RtgComparison({ result }: { result: Uc2AnswerResult }) {
  const r = result.result as any;
  const strategies = (r?.strategies ?? []) as StrategyMetrics[];
  if (!strategies.length) return null;
  const rec = r.recommendation;
  const rankOf = (s: string) => (r.ranking as any[]).find((x) => x.strategy === s)?.rank;
  return (
    <div>
      <table className="aa-table">
        <thead>
          <tr>
            <th scope="col">Strategy</th><th scope="col">Idle (RTG-h)</th>
            <th scope="col">Waiting (box-h)</th><th scope="col">Avg wait (min/move)</th>
            <th scope="col">Peak queue</th><th scope="col">Delayed moves</th>
            <th scope="col">Moves/RTG-h</th><th scope="col">Throughput (moves/h)</th>
            <th scope="col">Utilization %</th><th scope="col">Score</th><th scope="col">Rank</th>
          </tr>
        </thead>
        <tbody>
          {strategies.map((s) => (
            <tr key={s.strategy}>
              <th scope="row">{s.strategy}</th>
              <td>{s.idle_rtg_hours}</td><td>{s.waiting_box_hours}</td>
              <td>{s.avg_wait_min_per_move}</td><td>{s.peak_queue}</td>
              <td>{s.delayed_moves}</td><td>{s.moves_per_rtg_hour}</td>
              <td>{s.throughput_moves_per_hour}</td><td>{s.utilization_pct}</td>
              <td>{s.score}</td><td>#{rankOf(s.strategy)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rec ? (
        <div style={{ display: 'grid', gap: 8, marginTop: 10 }}>
          {[rec.rank1, rec.rank2].map((plan: any, i: number) => (
            <div key={plan.strategy} className="aa-section" style={{ border: '1px solid var(--calcite-color-border-2, #ddd)', borderRadius: 6, padding: '8px 10px' }}>
              <strong>Recommended dispatch plan #{i + 1} — {plan.strategy}</strong>
              <div style={{ fontSize: 12, marginTop: 2 }}>{plan.label}</div>
              <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12 }}>
                {plan.why.map((w: string) => <li key={w}>{w}</li>)}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Deterministic simulator corpus, built lazily and only when the app's own
 * adapter cannot serve the container register (e.g. cargo is sourced from the
 * POC-3 backend and it is unreachable). Same construction as AppContext's mock
 * base — zero credentials, seed-stable — and its use is declared on screen.
 */
let simFallback: MockAdapter | null = null;
function simCorpus(): MockAdapter {
  simFallback ??= new MockAdapter({
    terminalsConfig: terminalsConfig as unknown as ConstructorParameters<typeof MockAdapter>[0]['terminalsConfig'],
    baselines: baselinesConfig as unknown as BaselinesConfig,
  });
  return simFallback;
}

export function Uc2WhatIf() {
  const { adapter } = useApp();
  const [terminals, setTerminals] = useState<Terminal[]>([]);
  const [movements, setMovements] = useState<ContainerMovementDTO[] | null>(null);
  const [corpusSource, setCorpusSource] = useState<'adapter' | 'simulator-fallback'>('adapter');
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      const t = await adapter.getTerminals().catch(() => simCorpus().getTerminals());
      try {
        const m = await adapter.getContainerMovements({});
        if (!alive) return;
        setTerminals(t); setMovements(m); setCorpusSource('adapter');
      } catch {
        // The configured cargo source (usually POC-3) is unreachable — degrade
        // to the schema-accurate simulator corpus and say so on screen.
        try {
          const m = await simCorpus().getContainerMovements({});
          if (!alive) return;
          setTerminals(t); setMovements(m); setCorpusSource('simulator-fallback');
        } catch (e) {
          if (alive) setLoadError(String((e as Error)?.message ?? e));
        }
      }
    })();
    return () => { alive = false; };
  }, [adapter]);

  // The simulation "now": the corpus's latest event — deterministic, not wall-clock.
  const asOf = useMemo(() => {
    if (!movements?.length) return new Date(0).toISOString();
    return movements.reduce((max, m) => (m.lastEventTs > max ? m.lastEventTs : max), movements[0]!.lastEventTs);
  }, [movements]);

  // ---- Requirement 1 state ----
  const [terminalId, setTerminalId] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [rate, setRate] = useState(CFG_RATE);
  const [loadResult, setLoadResult] = useState<Uc2AnswerResult | null>(null);

  useEffect(() => {
    if (!terminalId && terminals.length) setTerminalId(terminals[0]!.terminalId);
  }, [terminals, terminalId]);

  const planInfo = useMemo(() => {
    if (!movements || !terminalId) return { original: 0, candidates: [] as ContainerMovementDTO[] };
    const exp = movements.filter((m) => m.container.originStream.startsWith('EXPORT_'));
    const planned = exp.filter((m) => m.trail.some((e) => e.eventType === 'LEO' && e.facilityId === terminalId));
    const plannedNos = new Set(planned.map((m) => m.container.containerNo));
    return {
      original: planned.length,
      candidates: exp.filter((m) => !plannedNos.has(m.container.containerNo)),
    };
  }, [movements, terminalId]);

  const toggle = useCallback((cn: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cn)) next.delete(cn); else next.add(cn);
      return next;
    });
  }, []);

  const runLoading = useCallback(() => {
    if (!movements) return;
    setLoadResult(runExportLoadingScenario({
      movements, asOf,
      params: { terminalId, additionalContainerNos: [...selected], berthMovesPerHour: rate },
    }));
  }, [movements, asOf, terminalId, selected, rate]);

  // ---- Requirement 2 state ----
  const [rtgTerminals, setRtgTerminals] = useState<Set<string>>(new Set());
  const [blocksPerTerminal, setBlocksPerTerminal] = useState(3);
  const [rtgParams, setRtgParams] = useState({
    rtgsPerBlock: CFG_RTG.rtgsPerBlock.value as number,
    maxRtgsPerBlock: CFG_RTG.maxRtgsPerBlock.value as number,
    peakMovesPerHourPerRtg: CFG_RTG.peakMovesPerHourPerRtg.value as number,
    demandMultiplier: CFG_RTG.demandMultiplier.value as number,
    stressHours: CFG_RTG.stressHours.value as number,
  });
  const [rtgResult, setRtgResult] = useState<Uc2AnswerResult | null>(null);

  useEffect(() => {
    if (rtgTerminals.size === 0 && terminals.length >= 2) {
      setRtgTerminals(new Set(terminals.slice(0, 2).map((t) => t.terminalId)));
    }
  }, [terminals, rtgTerminals.size]);

  const toggleRtgTerminal = useCallback((t: string) => {
    setRtgTerminals((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t); else next.add(t);
      return next;
    });
  }, []);

  const selectedBlocks = useMemo(
    () => [...rtgTerminals].sort().flatMap((t) => nominalYardBlocks([t]).slice(0, blocksPerTerminal)),
    [rtgTerminals, blocksPerTerminal],
  );

  const runRtg = useCallback(() => {
    if (!movements) return;
    setRtgResult(runRtgPeakScenario({
      movements,
      blocks: selectedBlocks,
      params: { ...rtgParams, weights: { ...DEFAULT_RTG_PARAMS.weights, ...(CFG_RTG.scoringWeights.value as object) } },
    }));
  }, [movements, selectedBlocks, rtgParams]);

  const setParam = (k: keyof typeof rtgParams) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setRtgParams((p) => ({ ...p, [k]: Number(e.target.value) }));

  const candidatesShown = planInfo.candidates.slice(0, 30);

  return (
    <section className="aa-wrap" aria-label="UC-2 what-if scenarios" data-uc2-whatif>
      <header className="aa-head">
        <div>
          <h3 className="aa-title">UC-2 scenario studio — computed in this app</h3>
          <p className="aa-sub">
            The two UC-2 requirements, run against the adapter's own container corpus by the
            deterministic engines in @jnpa/data. Every figure carries its provenance
            (measured / derived / assumed / parameter) and anything the data cannot support
            is reported unavailable, not invented.
          </p>
        </div>
      </header>

      <CalciteNotice open icon="information" kind="brand" scale="s">
        <div slot="message">{UC2_HYPOTHETICAL_NOTICE}</div>
      </CalciteNotice>

      {corpusSource === 'simulator-fallback' ? (
        <p className="aa-banner" data-kind="projected">
          The configured cargo source is unreachable, so this studio is computing against the
          schema-accurate simulator corpus (seed-stable, zero credentials) — not the live register.
        </p>
      ) : null}
      {loadError ? <p className="aa-banner" role="alert">Could not load the corpus: {loadError}</p> : null}

      {/* ── Requirement 1 · Additional export containers ─────────────────── */}
      <div className="aa-section" style={{ marginTop: 14 }} data-uc2-loading>
        <h4 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <CalciteIcon icon="ship" scale="s" /> Additional export containers loading
        </h4>
        <p className="aa-sub">
          The original planned load list is the export boxes already customs-cleared (LEO) at the
          terminal — planning concluded. Pick additional export boxes and simulate the revised
          list, the asset plan, the new completion and the sailing impact.
        </p>

        <span style={label}>Vessel / loading plan (terminal)</span>
        <select value={terminalId} onChange={(e) => { setTerminalId(e.target.value); setSelected(new Set()); setLoadResult(null); }}>
          {terminals.map((t) => <option key={t.terminalId} value={t.terminalId}>{t.terminalId} — {t.name}</option>)}
        </select>
        <CalciteChip scale="s" value="orig" style={{ marginLeft: 8 }}>
          original load list: {planInfo.original} boxes
        </CalciteChip>

        <span style={label}>
          Additional export containers ({selected.size} selected
          {planInfo.candidates.length > candidatesShown.length
            ? ` · showing ${candidatesShown.length} of ${planInfo.candidates.length} candidates`
            : ''})
        </span>
        <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--calcite-color-border-2, #ddd)', borderRadius: 6, padding: 6 }}>
          {candidatesShown.map((m) => {
            const c = m.container;
            return (
              <label key={c.containerNo} style={{ display: 'flex', gap: 6, fontSize: 12, alignItems: 'center' }}>
                <input
                  type="checkbox"
                  checked={selected.has(c.containerNo)}
                  onChange={() => toggle(c.containerNo)}
                />
                <code>{c.containerNo}</code> {c.sizeFt} ft · {Math.round(c.grossWtKg / 100) / 10} t
                {c.reefer ? ' · reefer' : ''}{c.hazmatIMDG ? ' · hazmat' : ''} · {c.originStream}
              </label>
            );
          })}
          {candidatesShown.length === 0 ? <p style={{ fontSize: 12, margin: 4 }}>No candidate export boxes outside the original plan.</p> : null}
        </div>

        <span style={label}>Berth loading rate (moves/hour) — parameter, you set this</span>
        <input type="number" min={1} step="0.01" value={rate} style={numInput}
               onChange={(e) => setRate(Number(e.target.value))} />

        <div style={{ marginTop: 10 }}>
          <CalciteButton scale="s" iconStart="play" onClick={runLoading} disabled={!movements ? true : undefined}>
            Simulate new stowage plan
          </CalciteButton>
        </div>

        {loadResult ? (
          <div style={{ marginTop: 10 }}>
            <WhatIfAnswer
              result={loadResult}
              title="UC-2 · R1 — Additional export containers loading"
              chart={<LoadingComparison result={loadResult} />}
              classNames={CLASSES}
            />
          </div>
        ) : null}
      </div>

      {/* ── Requirement 2 · Yard blocks at peak RTG demand ───────────────── */}
      <div className="aa-section" style={{ marginTop: 18 }} data-uc2-rtg>
        <h4 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <CalciteIcon icon="grid-unit" scale="s" /> Multiple yard blocks — peak RTG demand
        </h4>
        <p className="aa-sub">
          Holds every selected block at its observed peak-hour demand simultaneously (scaled by
          the multiplier), runs four dispatch strategies over the shared RTG pool and ranks them
          on idle time, delays and throughput with declared weights.
        </p>

        <span style={label}>Yard blocks (first N of each terminal's 12-block grid)</span>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {terminals.map((t) => (
            <label key={t.terminalId} style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
              <input type="checkbox" checked={rtgTerminals.has(t.terminalId)}
                     onChange={() => toggleRtgTerminal(t.terminalId)} />
              {t.terminalId}
            </label>
          ))}
          <label style={{ fontSize: 12, display: 'flex', gap: 4, alignItems: 'center' }}>
            blocks per terminal
            <input type="number" min={1} max={12} value={blocksPerTerminal} style={{ ...numInput, width: 60 }}
                   onChange={(e) => setBlocksPerTerminal(Math.max(1, Math.min(12, Number(e.target.value))))} />
          </label>
        </div>
        <p style={{ fontSize: 12, margin: '4px 0 0' }}>
          Selected: {selectedBlocks.map((b) => b.blockId).join(', ') || 'none'}
        </p>

        <span style={label}>Configured peak capacity & stress — parameters, you set these</span>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', fontSize: 12 }}>
          <label>RTGs/block <input type="number" min={1} value={rtgParams.rtgsPerBlock} style={{ ...numInput, width: 60 }} onChange={setParam('rtgsPerBlock')} /></label>
          <label>max RTGs/block <input type="number" min={1} value={rtgParams.maxRtgsPerBlock} style={{ ...numInput, width: 60 }} onChange={setParam('maxRtgsPerBlock')} /></label>
          <label>peak moves/h per RTG <input type="number" min={1} value={rtgParams.peakMovesPerHourPerRtg} style={{ ...numInput, width: 60 }} onChange={setParam('peakMovesPerHourPerRtg')} /></label>
          <label>demand × <input type="number" min={0} step="0.1" value={rtgParams.demandMultiplier} style={{ ...numInput, width: 60 }} onChange={setParam('demandMultiplier')} /></label>
          <label>stress hours <input type="number" min={1} value={rtgParams.stressHours} style={{ ...numInput, width: 60 }} onChange={setParam('stressHours')} /></label>
        </div>

        <div style={{ marginTop: 10 }}>
          <CalciteButton scale="s" iconStart="play" onClick={runRtg} disabled={!movements ? true : undefined}>
            Run peak-demand simulation
          </CalciteButton>
        </div>

        {rtgResult ? (
          <div style={{ marginTop: 10 }}>
            <WhatIfAnswer
              result={rtgResult}
              title="UC-2 · R2 — Multiple yard blocks at peak RTG demand"
              chart={<RtgComparison result={rtgResult} />}
              classNames={CLASSES}
            />
          </div>
        ) : null}
      </div>
    </section>
  );
}

export default Uc2WhatIf;
