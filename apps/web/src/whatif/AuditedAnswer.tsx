/**
 * The audited-answer panel for UC-2.
 *
 * Sits above the S1-S6 guided scenarios and answers the two questions the JNPA
 * Notice actually puts to this use case (II-A, II-B), plus the yard feedback
 * scenario we proposed. Figures come from the shared engine, so they match what
 * UC-1 and UC-3 show for the same scenario.
 *
 * Includes a small bar chart drawn with plain elements. `apps/web` has no
 * charting library and adding one to a shared repo to draw a single hourly
 * profile is not a trade worth making — the same pattern is already used for the
 * gate forecast curve in `panels/GateOps.tsx`.
 */
import { useCallback, useMemo, useState } from 'react';
import './auditedAnswer.css';
import WhatIfAnswer from './WhatIfAnswer';
import { orderedFor, type ScenarioEntry } from './scenarioCatalog';
import {
  EngineUnavailable,
  runEngineScenario,
  type EngineResult,
} from './engineClient';

const CLASSES = {
  root: 'aa-root',
  verdict: 'aa-verdict',
  headline: 'aa-headline',
  detail: 'aa-detail',
  banner: 'aa-banner',
  section: 'aa-section',
  actions: 'aa-actions',
  action: 'aa-action',
  evidence: 'aa-evidence',
  summary: 'aa-summary',
  table: 'aa-table',
  chip: 'aa-chip',
} as const;

/**
 * The hourly gate profile, before against after — the picture II-A is actually
 * asking for. Rendered as paired bars with the sustained rate drawn across them,
 * because the question is "does any hour cross the line", and a line is the
 * clearest way to answer it.
 */
function HourlyProfile({ result }: { result: EngineResult }) {
  const before = (result.result?.baseline_profile ?? []) as any[];
  const after = (result.result?.shifted_profile ?? []) as any[];
  if (!before.length) return null;

  const rate = Number(result.figures.sustained_rate_per_hour ?? 0) || 0;
  const peak = Math.max(
    rate,
    ...before.map((h) => Number(h.arrivals ?? 0)),
    ...after.map((h) => Number(h.arrivals ?? 0) + Number(h.added ?? 0)),
  );
  if (!peak) return null;

  const hour = (b: any) => String(b.bucket ?? '').slice(11, 16);
  const pct = (v: number) => `${Math.max(0, Math.min(100, (v / peak) * 100))}%`;

  return (
    <figure className="aa-chart">
      <figcaption>
        Gate arrivals by hour — before and after the shift
        {rate ? <span className="aa-chart-rate"> · line = {Math.round(rate)}/h sustained</span> : null}
      </figcaption>
      <div className="aa-bars" role="img"
           aria-label={`Hourly gate arrivals before and after the modal shift, against a sustained rate of ${Math.round(rate)} per hour`}>
        {before.map((b, i) => {
          const base = Number(b.arrivals ?? 0);
          const shifted = Number(after[i]?.arrivals ?? base) + Number(after[i]?.added ?? 0);
          const over = rate > 0 && shifted > rate;
          return (
            <div className="aa-bar-col" key={String(b.bucket ?? i)}
                 title={`${hour(b)} — before ${base}, after ${shifted}`}>
              <div className="aa-bar-pair">
                <div className="aa-bar aa-bar-before" style={{ height: pct(base) }} />
                <div className={`aa-bar aa-bar-after${over ? ' aa-bar-over' : ''}`}
                     style={{ height: pct(shifted) }} />
              </div>
              <span className="aa-bar-label">{hour(b).slice(0, 2)}</span>
            </div>
          );
        })}
        {rate > 0 ? (
          <div className="aa-rate-line" style={{ bottom: pct(rate) }} aria-hidden="true" />
        ) : null}
      </div>
      <div className="aa-legend">
        <span><i className="aa-swatch aa-bar-before" /> before</span>
        <span><i className="aa-swatch aa-bar-after" /> after</span>
        <span><i className="aa-swatch aa-bar-over" /> over the sustained rate</span>
      </div>
    </figure>
  );
}

export function AuditedAnswer() {
  // All nine, UC-2's own first. A cargo planner asking whether the gate absorbs
  // a modal shift has an obvious reason to also ask what the berth queue is
  // doing — hiding the marine scenarios because another department owns them
  // would defeat the point of a cross-domain twin.
  const catalog = useMemo(() => orderedFor('UC-2'), []);
  const [active, setActive] = useState<string>(catalog[0].id);
  const [result, setResult] = useState<EngineResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const entry: ScenarioEntry = catalog.find((s) => s.id === active) ?? catalog[0];

  const run = useCallback(async () => {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await runEngineScenario(entry.id, { ...entry.params }));
    } catch (err) {
      setError(
        err instanceof EngineUnavailable
          ? err.message
          : 'The audited figures could not be fetched.',
      );
    } finally {
      setLoading(false);
    }
  }, [entry]);

  return (
    <section className="aa-wrap" aria-label="Audited what-if answers">
      <header className="aa-head">
        <div>
          <h3 className="aa-title">Audited answers — JNPA Notice</h3>
          <p className="aa-sub">
            Computed in the UC-3 backend, where the berthing, traffic and gate
            tables live. Each answer carries its method, its assumptions stated
            separately, and the queries it ran.
          </p>
        </div>
      </header>

      <div className="aa-tabs" role="tablist">
        {catalog.map((s) => (
          <button
            key={s.id}
            role="tab"
            type="button"
            aria-selected={s.id === active}
            className={`aa-tab${s.id === active ? ' aa-tab-on' : ''}`}
            onClick={() => {
              setActive(s.id);
              setResult(null);
              setError(null);
            }}
          >
            <span className={`aa-ref aa-ref-${s.source}`}>{s.ref}</span> {s.label}
            {s.owner !== 'UC-2' ? <span className="aa-owner"> {s.owner}</span> : null}
          </button>
        ))}
      </div>

      <p className="aa-question">{entry.question}</p>
      {entry.caveat ? <p className="aa-caveat">{entry.caveat}</p> : null}
      {entry.owner !== 'UC-2' ? (
        <p className="aa-sub">
          A {entry.owner} question, computed in {entry.answeredBy} where its data
          lives. Shown here because a cargo decision often turns on it.
        </p>
      ) : null}

      <button type="button" className="aa-run" onClick={run} disabled={loading}>
        {loading ? 'Fetching…' : result ? 'Refresh figures' : 'Get the audited figures'}
      </button>

      {error ? <p className="aa-banner" role="alert">{error}</p> : null}

      {result ? (
        <WhatIfAnswer
          result={result}
          title={`${entry.ref} — ${entry.label}`}
          chart={<HourlyProfile result={result} />}
          classNames={CLASSES}
        />
      ) : null}
    </section>
  );
}

export default AuditedAnswer;
