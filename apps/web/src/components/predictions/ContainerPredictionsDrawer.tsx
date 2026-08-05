/**
 * <ContainerPredictionsDrawer> — the AI/ML predictions side panel for one container.
 *
 * Opened from the Predictions column of the Movements table. It renders the
 * `uc2-dashboard/1.0.0` document the model service returns: one card per model
 * that ran for this box, then — collapsed — the inputs those models used and
 * the gate/yard figures that describe the whole page.
 *
 * WHY THIS IS AN <aside role="dialog"> AND NOT A CalciteSheet
 * ----------------------------------------------------------
 * The Movements panel already has a per-container drill-down drawer (the
 * lifecycle timeline) built exactly this way, plus three modals on the same
 * pattern. Predictions is one more per-container drill-down, so it follows that
 * convention rather than introducing a second, differently-behaved one.
 *
 * There is a second benefit worth recording, because it cost real debugging
 * time in the UC-1 build. `calcite-panel` handles its own close button by
 * setting `closed = true` ON THE DOM ELEMENT; the React wrapper only writes
 * props whose React value CHANGED, and `closed` is never passed, so that
 * mutation is permanent and the sheet opens blank the SECOND time. UC-1 fixed
 * it with `key={openId ?? 'closed'}`. A plain <aside> that is conditionally
 * mounted has no internal state to survive prop diffing, so the bug cannot
 * occur here at all. The regression test asserts the mount/unmount behaviour
 * that keeps it that way.
 *
 * ORDER AND VOLUME
 * ----------------
 * The panel lands directly on the model cards. Everything that qualifies the
 * numbers is reachable but quiet: one chip for the estimated inputs (with the
 * full list on hover AND repeated in a collapsed section, because a touch
 * screen has no hover), the model's plain-English question on an ⓘ affordance
 * rather than a permanent line of italics, and the reference sections behind
 * <details>. Quieter, never deleted.
 *
 * Rendering is generic on purpose. Each model publishes a different field set,
 * the document ships its own glossary, and the service's self-test fails the
 * build if a rendered key has no definition. So every field reaches the screen
 * with its definition on hover, and a field a model gains tomorrow appears here
 * without a frontend change instead of being silently dropped.
 */

import { useMemo } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteLoader, CalciteNotice,
} from '@esri/calcite-components-react';
import type { ContainerMovementDTO } from '@jnpa/data';
import { predictionStore, selectPredictionFor, usePredictions } from '../../state/predictionStore.js';
import { estimatedLabel, failedModels } from '../../data/ml/predictions.js';
import type { ModelBlock, ModelFieldValue, ContainerMapping } from '../../data/ml/types.js';
import { tokens } from '../../theme/tokens.js';
import {
  formatValue, gridFields, humaniseKey, orderedBlocks, statusTone, viewFor,
  type ModelView, type Tone,
} from './modelViews.js';

/** Exported so the table column and the panel agree on what the button says. */
export const PREDICTIONS_COLUMN_LABEL = 'Predictions';

const TONE_COLOUR: Record<Tone, string> = {
  good: tokens.congestion.GREEN,
  warn: tokens.congestion.AMBER,
  bad: tokens.congestion.RED,
  neutral: tokens.color.textMuted,
};

const SECTION_TITLE: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: 'uppercase',
  color: tokens.color.textMuted,
};

const CARD: CSSProperties = {
  border: `1px solid ${tokens.color.border}`,
  borderRadius: 6,
  background: tokens.color.bgElevated,
  padding: '10px 12px',
};

const KEY: CSSProperties = { fontSize: 11.5, color: tokens.color.textMuted };
const VAL: CSSProperties = {
  fontSize: 12.5,
  color: tokens.color.text,
  fontVariantNumeric: 'tabular-nums',
  textAlign: 'right',
  wordBreak: 'break-word',
};

/**
 * The ⓘ affordance: explanatory text on hover, and reachable by keyboard.
 *
 * `tabIndex={0}` + `title` + `aria-label` rather than a custom popover: it needs
 * no state, and hover, keyboard focus and a screen reader all reach the same
 * text for free.
 */
function InfoHint({ text }: { text: string }) {
  return (
    <span
      role="note"
      tabIndex={0}
      title={text}
      aria-label={text}
      style={{ marginLeft: 4, fontSize: 10, color: tokens.color.textMuted, cursor: 'help' }}
    >
      ⓘ
    </span>
  );
}

/** A verdict chip whose colour carries the domain meaning of the word. */
function StatusChip({ value }: { value: ModelFieldValue }) {
  const tone = statusTone(value);
  return (
    <span
      style={{
        fontSize: 10.5, fontWeight: 700, letterSpacing: 0.3,
        color: TONE_COLOUR[tone], border: `1px solid ${TONE_COLOUR[tone]}`,
        borderRadius: 3, padding: '1px 6px', whiteSpace: 'nowrap',
      }}
    >
      {formatValue(value)}
    </span>
  );
}

/**
 * Key/value rows with the document's own glossary as the tooltip. `title`
 * rather than a custom popover so the definition reaches a keyboard user and a
 * screen reader with no JS.
 */
function FieldGrid({
  fields, glossary,
}: {
  fields: Array<[string, ModelFieldValue]>;
  glossary: Record<string, string>;
}) {
  if (fields.length === 0) return null;
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px', margin: '8px 0 0' }}>
      {fields.map(([key, value]) => (
        <div key={key} style={{ display: 'contents' }}>
          <dt style={KEY} title={glossary[key] ?? undefined}>
            {humaniseKey(key)}
            {glossary[key] ? ' ⓘ' : ''}
          </dt>
          <dd style={{ ...VAL, margin: 0 }}>{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Free text a model wrote to explain itself (M1's accuracy disclosure). */
function Prose({ text }: { text: ModelFieldValue }) {
  if (typeof text !== 'string' || !text.trim()) return null;
  return (
    <p style={{ margin: '8px 0 0', fontSize: 11.5, lineHeight: 1.45, color: tokens.color.textMuted }}>
      {text}
    </p>
  );
}

function ModelCard({
  view, block, question, glossary,
}: {
  view: ModelView;
  block: ModelBlock;
  question?: string;
  glossary: Record<string, string>;
}) {
  const headline = view.headline ? block[view.headline] : undefined;
  const status = view.statusKey ? block[view.statusKey] : undefined;
  const degraded = block.degraded === true;
  return (
    <section style={CARD} aria-label={view.title}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0, fontSize: 12.5, fontWeight: 700, color: tokens.color.text }}>
          {view.title}
          {/* The plain-English question this model answers. On the affordance,
              not under every title: an operator who has read it once does not
              need it on every open, and it costs a line of height each time. */}
          {question && <InfoHint text={question} />}
        </h3>
        {status !== undefined && <StatusChip value={status} />}
        {degraded && (
          <span
            title={
              typeof block.decision_path === 'string'
                ? `A fallback produced this number. ${block.decision_path}`
                : 'A fallback produced this number rather than the primary engine.'
            }
            tabIndex={0}
            style={{
              fontSize: 10, fontWeight: 700, color: tokens.congestion.AMBER,
              border: `1px solid ${tokens.congestion.AMBER}`, borderRadius: 3,
              padding: '1px 5px', cursor: 'help',
            }}
          >
            degraded
          </span>
        )}
        {headline !== undefined && (
          <span
            style={{
              marginLeft: 'auto', fontSize: 17, fontWeight: 700,
              color: tokens.color.text, fontVariantNumeric: 'tabular-nums',
            }}
            title={view.headline ? glossary[view.headline] : undefined}
          >
            {formatValue(headline)}
            {view.unit ? <span style={{ fontSize: 11, color: tokens.color.textMuted }}> {view.unit}</span> : null}
          </span>
        )}
      </header>

      {/* Facility-level models say, on the card itself, what set they describe.
          Without this an operator reads "worst wait 14 min" as a fact about the
          container they opened rather than about the gate. */}
      {view.facilityLevel && typeof block.facility_scope === 'string' && (
        <p style={{ margin: '6px 0 0', fontSize: 11, color: tokens.congestion.AMBER }}>
          {block.facility_scope}
        </p>
      )}

      <FieldGrid fields={gridFields(block, view)} glossary={glossary} />
      {view.richKeys
        ?.filter((key) => key !== 'facility_scope' && key !== 'trailUsed')
        .map((key) => <Prose key={key} text={block[key] ?? null} />)}
    </section>
  );
}

/**
 * The estimated-inputs indicator: one chip, with the full list on hover.
 *
 * Deliberately NOT a full-width advisory banner. The whole panel is a
 * prediction; a block arguing that point on every open buries the figures the
 * operator came for. Nothing is given up — the substitutions are stated
 * verbatim here on hover and again, in full, in the "Model inputs" section
 * below, which is what a touch screen with no hover falls back to.
 *
 * The label is a bare COUNT, never a fraction. "5 of 8" beside a suite of seven
 * models reads as five of the seven models; these are model INPUTS, and the
 * number varies per container because the ledger only records inputs it
 * actually had to resolve.
 */
function EstimatedChip({ mapping }: { mapping: ContainerMapping | null }) {
  if (!mapping || mapping.inputs_assumed <= 0) {
    return (
      <CalciteChip scale="s" icon="check-circle" title="Every value the models used came from this container's own record.">
        {estimatedLabel(0)}
      </CalciteChip>
    );
  }
  const detail = [
    `${mapping.inputs_assumed} of the ${mapping.inputs_assumed + mapping.inputs_observed} input values these models needed were not on this container's record, so a published constant was used:`,
    ...mapping.assumptions.map((a) => `• ${a}`),
    ...(mapping.warnings.length ? ['', 'Notes:', ...mapping.warnings.map((w) => `• ${w}`)] : []),
  ].join('\n');
  return (
    <CalciteChip scale="s" kind="brand" icon="exclamation-mark-triangle" title={detail}>
      {estimatedLabel(mapping.inputs_assumed)}
    </CalciteChip>
  );
}

/** A collapsed disclosure — reference detail that should not cost height. */
function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details style={{ marginTop: 8 }}>
      <summary style={{ cursor: 'pointer', ...SECTION_TITLE }}>{summary}</summary>
      <div style={{ marginTop: 8 }}>{children}</div>
    </details>
  );
}

export function ContainerPredictionsDrawer({
  containerNo, moves, onClose,
}: {
  containerNo: string;
  /** The page currently in the table — what gets scored, and re-scored. */
  moves: ContainerMovementDTO[];
  onClose: () => void;
}) {
  const state = usePredictions();
  // Keyed on the PROP, not on the store's open container — the drawer's title
  // and its numbers must describe the same box. See selectPredictionFor.
  const prediction = selectPredictionFor(state, containerNo);
  const dashboard = state.response?.dashboard ?? null;
  const glossary = dashboard?.glossary ?? {};
  const mapping = prediction?.mapping ?? null;

  const blocks = useMemo(
    () => (prediction ? orderedBlocks(prediction.models) : []),
    [prediction],
  );
  const failed = state.response ? failedModels(state.response) : [];

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <aside
        role="dialog"
        aria-label={`AI predictions for ${containerNo}`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(520px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="lightbulb" scale="s" />
          <strong style={{ fontSize: 14 }}>AI predictions</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{containerNo}</span>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}
          >
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1 }}>
          {state.loading && (
            <CalciteLoader scale="s" label="Scoring this page through the UC-II models" text="Scoring this page through the UC-II models…" />
          )}

          {!state.loading && state.error && (
            <>
              <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
                <div slot="title">Predictions unavailable</div>
                <div slot="message">{state.error}</div>
              </CalciteNotice>
              <CalciteButton
                scale="s"
                appearance="outline"
                iconStart="refresh"
                style={{ marginTop: 8 }}
                onClick={() => void predictionStore.refresh(moves)}
              >
                Try again
              </CalciteButton>
            </>
          )}

          {!state.loading && !state.error && !prediction && (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No prediction for this container</div>
              <div slot="message">
                The model service answered, but returned no block for {containerNo}. Re-score
                to include it.
              </div>
            </CalciteNotice>
          )}

          {!state.loading && !state.error && prediction && dashboard && (
            <>
              {failed.length > 0 && (
                <CalciteNotice open kind="danger" icon="exclamation-mark-circle" scale="s">
                  <div slot="title">{failed.length} model(s) failed in this run</div>
                  <div slot="message">{failed.join(' · ')}</div>
                </CalciteNotice>
              )}

              {/* One status line. Everything here is a fact about THIS run that
                  changes how the numbers read. Anything that only explains
                  itself lives on a hover. */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', marginBottom: 8 }}>
                <CalciteChip
                  scale="s"
                  icon="container"
                  title={
                    'Arrival cadence is only measurable across rows, and the gate and yard ' +
                    'figures describe the whole set — so the visible page is scored together, ' +
                    'not this container alone.'
                  }
                >
                  page of {state.scored}
                  {state.pageSize > state.scored ? ` of ${state.pageSize}` : ''}
                </CalciteChip>
                <EstimatedChip mapping={mapping} />
                {dashboard.run.cadence_measured_rows > 0 && (
                  <CalciteChip
                    scale="s"
                    title={`${dashboard.run.cadence_measured_rows} row(s) had arrival cadence measured from this page; ${dashboard.run.cadence_assumed_rows} fell back to the named default.`}
                  >
                    {dashboard.run.cadence_measured_rows} cadence measured
                  </CalciteChip>
                )}
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  iconStart="refresh"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => void predictionStore.refresh(moves)}
                >
                  Re-score
                </CalciteButton>
              </div>

              {dashboard.run.containers_dropped > 0 && (
                <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
                  <div slot="title">
                    {dashboard.run.containers_dropped} container(s) left out of this run
                  </div>
                  <div slot="message">
                    {dashboard.run.dropped_reason ??
                      'The page is larger than the service scores in one call.'}
                  </div>
                </CalciteNotice>
              )}

              {/* The answer the operator opened this for. No heading above it —
                  the drawer's own title already says what it is. */}
              <div style={{ display: 'grid', gap: 8 }}>
                {blocks.map(({ view, block }) => (
                  <ModelCard
                    key={view.id}
                    view={view}
                    block={block}
                    question={dashboard.model_questions[view.id]}
                    glossary={glossary}
                  />
                ))}
              </div>

              {/* Reference, not answer. Collapsed, each costs one line instead
                  of a screen of scrolling — and the model inputs carry the
                  estimated values in full, which is what lets the chip above
                  afford to be a chip. */}
              <Disclosure
                summary={`Model inputs (${mapping ? estimatedLabel(mapping.inputs_assumed) : 'as used'})`}
              >
                <div style={CARD}>
                  {mapping ? (
                    <>
                      <FieldGrid
                        fields={mapping.derived.map((d) => [
                          d.model_input,
                          d.observed ? d.value : `${formatValue(d.value)} (estimated)`,
                        ])}
                        glossary={glossary}
                      />
                      {(mapping.assumptions.length > 0 || mapping.warnings.length > 0) && (
                        <ul style={{ margin: '8px 0 0', paddingLeft: 16, fontSize: 11, lineHeight: 1.5, color: tokens.color.textMuted }}>
                          {mapping.assumptions.map((a) => <li key={a}>{a}</li>)}
                          {mapping.warnings.map((w) => <li key={w}>{w}</li>)}
                        </ul>
                      )}
                    </>
                  ) : (
                    <p style={{ margin: 0, fontSize: 11.5, color: tokens.color.textMuted }}>
                      No translation ledger was returned for this container.
                    </p>
                  )}
                </div>
              </Disclosure>

              <Disclosure summary="Gate & yard figures (whole page, not this container)">
                <div style={{ display: 'grid', gap: 8 }}>
                  {Object.entries(dashboard.facility_summary).map(([id, block]) => (
                    <ModelCard
                      key={id}
                      view={viewFor(id)}
                      block={block}
                      question={dashboard.model_questions[id]}
                      glossary={glossary}
                    />
                  ))}
                  <p style={{ margin: 0, fontSize: 10.5, color: tokens.color.textMuted }}>
                    {state.response?.adapter.moduleId} {state.response?.adapter.version} ·
                    adapter {state.response?.adapter.adapter_version} · generated{' '}
                    {dashboard.generated_at_utc}
                  </p>
                </div>
              </Disclosure>
            </>
          )}
        </div>
      </aside>
    </>
  );
}
