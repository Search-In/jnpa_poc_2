/**
 * The UC-III handover, shown after the fact.
 *
 * Opened from a released row. The handover FACTS are read back off the cargo
 * record — see `uc3Handover.ts` for why that, and not the fire-and-forget event,
 * is the honest source.
 *
 * The RETURN leg comes from `core.gate_event` (`GET /api/gate/events`), which is
 * where UC-III records a real crossing. That table is the only evidence UC-2 can
 * show that a truck actually took the box: UC-III's job flow writes there and
 * updates nothing but `customs_status` on `core.cargo`, so before this the dialog
 * could only say "not confirmed here". It now says which — a recorded crossing,
 * or genuinely nothing on record — and never infers one from the release.
 */
import { CalciteButton, CalciteIcon, CalciteLoader, CalciteNotice } from '@esri/calcite-components-react';
import { Fragment } from 'react';
import type { GateEvent } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import {
  handoverFor, hasRecordedGateOut, latestCrossing, UC3_NEXT_STEPS, type ReleasedCargo,
} from './uc3Handover.js';
import { tokens } from '../theme/tokens.js';

const fmtTs = (v: string) => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString();
};

export function Uc3HandoverDialog({
  containerNo, cargo, onClose,
}: {
  containerNo: string;
  cargo: ReleasedCargo | null | undefined;
  onClose: () => void;
}) {
  const { adapter } = useApp();
  const handover = handoverFor(cargo);
  // The return leg. Absent adapter method (mock mode) ⇒ empty, which renders as
  // "nothing recorded" — correct, because in mock mode nothing was.
  const crossings = useAsync<GateEvent[]>(
    () => (adapter.getGateEvents ? adapter.getGateEvents({ containerNo }) : Promise.resolve([])),
    [adapter, containerNo]);
  if (!handover) return null;

  const events = crossings.data ?? [];
  const gateOut = latestCrossing(events, 'GATE_OUT');
  const confirmed = hasRecordedGateOut(events);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label={`UC-III handover — ${containerNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(520px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="hand-point-right" scale="s" />
          <strong style={{ fontSize: 14 }}>Handed over to UC-III</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{containerNo}</span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          <CalciteNotice open kind="success" icon="check-circle" scale="s">
            <div slot="title">
              <code>{handover.event}</code> emitted — this is where UC-2&apos;s lifecycle ends
            </div>
            <div slot="message">
              RELEASED is the terminal state of the import lifecycle. The event below went
              to the shared bus carrying the yard location and vehicle details; the truck
              leg is UC-III&apos;s.
            </div>
          </CalciteNotice>

          <div
            style={{
              display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
              fontSize: 12.5, background: tokens.color.bgElevated,
              border: `1px solid ${tokens.color.border}`, borderRadius: 6,
              padding: '10px 12px', margin: '10px 0',
            }}
          >
            {handover.facts.map((f) => (
              <Fragment key={f.label}>
                <span style={{ color: tokens.color.textMuted }}>{f.label}</span>
                {/* An absent field says WHY it is absent. Rendering "—" would read
                    as a display gap rather than as a fact the event never carried. */}
                {f.value !== null ? (
                  <strong style={{ color: tokens.color.text }}>
                    {f.label === 'Released at' ? fmtTs(f.value) : f.value}
                  </strong>
                ) : (
                  <em style={{ color: tokens.color.textMuted }}>{f.absent}</em>
                )}
              </Fragment>
            ))}
          </div>

          {!handover.complete && (
            <CalciteNotice open kind="warning" icon="information" scale="s">
              <div slot="title">The handover was partial</div>
              <div slot="message">
                One or more fields the event is specified to carry were not on the record
                at release. UC-III can still act on what it received — a truck is
                dispatched against the yard location — but the missing values were never
                sent and cannot be recovered from here.
              </div>
            </CalciteNotice>
          )}

          {/* The return leg: what UC-III actually recorded. */}
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '12px 0 4px' }}>
            <strong>Recorded gate crossings (UC-III)</strong>
          </p>
          {crossings.loading ? (
            <CalciteLoader inline label="Loading gate crossings" />
          ) : crossings.error ? (
            <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not read the gate crossings</div>
              {/* Distinguish "we could not look" from "nothing happened" — reporting
                  a failed read as an absent crossing is the same over-claim in
                  reverse. */}
              <div slot="message">
                {String(crossings.error)} — this is not evidence that no crossing took
                place.
              </div>
            </CalciteNotice>
          ) : events.length === 0 ? (
            <p style={{ fontSize: 12.5, color: tokens.color.textMuted, margin: 0 }}>
              None on record. UC-III has not logged a gate crossing for this container, so
              the box may still be in the yard awaiting a truck.
            </p>
          ) : (
            <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
              {events.map((e) => (
                <li key={e.id ?? `${e.ts}-${e.event_type}`} style={{ marginBottom: 3 }}>
                  <strong>{e.event_type ?? 'CROSSING'}</strong>
                  {e.ts ? ` · ${fmtTs(e.ts)}` : ''}
                  {e.gate_id ? ` · gate ${e.gate_id}` : ''}
                  {e.plate ? ` · ${e.plate}` : ''}
                  {e.job_id != null ? ` · job #${e.job_id}` : ''}
                  {e.document_type
                    ? ` · ${e.document_type}${e.document_reference ? ` ${e.document_reference}` : ''}`
                    : ''}
                </li>
              ))}
            </ul>
          )}

          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '12px 0 4px' }}>
            <strong>What happens next, and who owns it</strong>
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            {UC3_NEXT_STEPS.map(({ step, owner }) => (
              <li key={step} style={{ marginBottom: 3 }}>
                {step} — <span style={{ color: tokens.color.textMuted }}>{owner}</span>
              </li>
            ))}
          </ul>

          {/* The honesty line, now keyed on what was actually found. Saying
              "not confirmed" over a recorded crossing understates the evidence;
              saying "confirmed" without one invents a gate-out. */}
          <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '10px 0 0' }}>
            <CalciteIcon icon="information" scale="s" style={{ marginRight: 6 }} />
            {confirmed ? (
              <>
                The gate-out above is a <strong>recorded crossing</strong> from
                {' '}<code>core.gate_event</code>
                {gateOut?.gate_id ? <> at gate <strong>{gateOut.gate_id}</strong></> : null} — not
                inferred from the release. The remaining steps are still unconfirmed: UC-2
                sees crossings, not the terminal&apos;s documents.
              </>
            ) : (
              <>
                No crossing is on record, so none of the steps above is confirmed. Note the
                GATE_OUT status on this row is derived from <code>is_released</code> — it
                means UC-2 released the box, <strong>not</strong> that a truck took it
                through a gate.
              </>
            )}
          </p>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
        </div>
      </div>
    </>
  );
}
