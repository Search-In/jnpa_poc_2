/**
 * Confirms whichever lifecycle gate a container is at: discharge → yard-assign →
 * verify → release.
 *
 * One dialog rather than four, and shared by the Movements and Scan panels,
 * because the operator's question is always "what is the next step for this box"
 * and the answer is determined by its recorded state — not by which tab they are
 * looking at. The two panels previously had separate dialogs with separate ideas
 * of the lifecycle, which is how a container verified in Scan ended up with no way
 * to release it from Movements.
 *
 * Each gate calls its OWN endpoint (`POST /discharge`, `PUT /yard-assignment`,
 * `POST /verify`, `POST /release`) rather than patching columns, so every
 * transition is validated by the server's state machine and emits its audited
 * event. `PUT {is_released:true}` in particular faces the same VERIFY gate as
 * `POST /release` but reads as a field patch — which is exactly why a blocked
 * release used to surface as a bare "release_failed".
 */
import { Fragment, useState } from 'react';
import {
  CalciteButton, CalciteIcon, CalciteInput, CalciteLabel, CalciteNotice,
} from '@esri/calcite-components-react';
import { useApp } from '../state/AppContext.js';
import { SuccessNotice } from '../components/SuccessNotice.js';
import { cargoRefreshStore } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { GATE_UI, uiGate, type CargoGate } from './cargoGates.js';
import { tokens } from '../theme/tokens.js';

export function CargoGateDialog({
  gate, containerNo, lifecycle, yardBlock, customsStatus, vesselName, facts, note, onClose, onDone,
}: {
  gate: CargoGate;
  containerNo: string;
  lifecycle: string;
  yardBlock?: string | null;
  /** Customs disposition — an INDEPENDENT track; used only to warn, never to gate. */
  customsStatus?: string | null;
  /** Sent with the discharge call so the record keeps the discharging vessel. */
  vesselName?: string | null;
  /** Extra read-only context for this gate (the discharge report's facts). */
  facts?: Array<[string, string]>;
  /** Gate-specific caveat, e.g. that COARRI is unavailable for JNPA calls. */
  note?: React.ReactNode;
  onClose: () => void;
  /** Fired after a successful transition, with the resulting lifecycle status. */
  onDone?: (status: string) => void;
}) {
  const { adapter } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  /**
   * The block to park the container in.
   *
   * Pre-filled from the record when it already has one (the catch-up case, where
   * the block was written directly and only the transition is missing). It is
   * EMPTY for a container that has just been discharged — and the server rejects
   * an empty block with `400 yard_block is required`, so the gate has to ask for
   * it rather than send whatever happens to be on the record.
   */
  const [block, setBlock] = useState(yardBlock ?? '');
  const ui = GATE_UI[uiGate(gate)];
  const needsBlock = gate === 'yard' && !block.trim();

  const run = async (pass = true) => {
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      let status = '';
      if (gate === 'discharge') {
        if (!adapter.dischargeCargo) throw new Error('Discharge is unavailable in this data mode.');
        const res = await adapter.dischargeCargo(containerNo, {
          ...(vesselName ? { vessel_name: vesselName } : {}),
          discharge_time: new Date().toISOString(),
        });
        status = res.lifecycle_status;
      } else if (gate === 'yard') {
        if (!adapter.assignYard) throw new Error('Yard assignment is unavailable in this data mode.');
        await adapter.assignYard(containerNo, block.trim());
        status = 'YARD_ASSIGNED';
      } else if (gate === 'verify') {
        if (!adapter.verifyCargo) throw new Error('Verification is unavailable in this data mode.');
        const res = await adapter.verifyCargo(containerNo, {
          verified: pass,
          remarks: pass ? 'Scan cleared' : 'Scan failed — held for examination',
        });
        status = res.lifecycle_status;
      } else {
        if (!adapter.releaseCargo) throw new Error('Release is unavailable in this data mode.');
        await adapter.releaseCargo(containerNo);
        status = 'RELEASED';
      }
      setOutcome(status);
      // Refresh Movements, the Scan queue and Yard/Pendency together — a
      // transition changes what every one of them should show.
      cargoRefreshStore.bump();
      setDone(true);
      onDone?.(status);
    } catch (e) {
      setError(cargoErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label={`${ui.title} — ${containerNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(520px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon={ui.icon} scale="s" />
          <strong style={{ fontSize: 14 }}>{ui.title}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{containerNo}</span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {done ? (
            <SuccessNotice
              title={`${ui.title} recorded.`}
              details={[
                { label: 'Container', value: containerNo },
                { label: 'Lifecycle status', value: outcome ?? '—' },
              ]}
            />
          ) : (
            <>
              {facts && facts.length > 0 && (
                <div
                  style={{
                    display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px',
                    fontSize: 12.5, background: tokens.color.bgElevated,
                    border: `1px solid ${tokens.color.border}`, borderRadius: 6,
                    padding: '10px 12px', marginBottom: 10,
                  }}
                >
                  {facts.map(([label, value]) => (
                    <Fragment key={label}>
                      <span style={{ color: tokens.color.textMuted }}>{label}</span>
                      <strong style={{ color: tokens.color.text }}>{value}</strong>
                    </Fragment>
                  ))}
                </div>
              )}

              {note}

              {/* The lifecycle and the customs disposition are independent tracks:
                  release is gated on VERIFIED and does NOT consult customs_status,
                  so the server will permit this. Warn rather than block — refusing
                  something the API allows would be its own kind of misdirection,
                  but letting it pass silently would hide a live customs hold. */}
              {gate === 'release' && customsStatus === 'HELD' && (
                <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
                  <div slot="title">Customs has this container on HOLD</div>
                  <div slot="message">
                    The lifecycle is VERIFIED, so the server will accept a release — the
                    release gate checks the lifecycle only and does not read the customs
                    disposition. Confirm the hold has been lifted before proceeding.
                  </div>
                </CalciteNotice>
              )}

              <CalciteNotice open kind="info" icon="information" scale="s" style={{ marginTop: 8 }}>
                <div slot="title">{ui.title}</div>
                <div slot="message">{ui.explain}</div>
              </CalciteNotice>

              {gate === 'yard' && (
                <CalciteLabel scale="s" style={{ marginTop: 10 }}>Yard block
                  <CalciteInput
                    scale="s"
                    value={block}
                    placeholder="A-01"
                    status={needsBlock ? 'invalid' : 'idle'}
                    onCalciteInputInput={(e) => setBlock((e.target as unknown as { value: string }).value)}
                  />
                </CalciteLabel>
              )}

              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 0' }}>
                Currently <code>{lifecycle}</code>
                {yardBlock ? <> · yard <code>{yardBlock}</code></> : null}
              </p>
            </>
          )}

          {error && (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
              <div slot="title">{ui.title} failed</div>
              <div slot="message">{error}</div>
            </CalciteNotice>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          {done ? (
            <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
          ) : (
            <>
              <CalciteButton scale="s" appearance="outline" kind="neutral" onClick={onClose} disabled={busy}>Cancel</CalciteButton>
              {/* A failed scan is a real outcome, not an error: it records the check
                  WITHOUT advancing the lifecycle, which is how a held or
                  re-scan-required box is captured. */}
              {gate === 'verify' && (
                <CalciteButton scale="s" appearance="outline" kind="danger" iconStart="x-octagon"
                  loading={busy} disabled={busy} onClick={() => run(false)}>
                  Fail — hold for exam
                </CalciteButton>
              )}
              <CalciteButton scale="s" kind="brand" iconStart={ui.icon} loading={busy}
                disabled={busy || needsBlock}
                title={needsBlock ? 'Enter the yard block first' : undefined}
                onClick={() => run(true)}>
                {ui.cta}
              </CalciteButton>
            </>
          )}
        </div>
      </div>
    </>
  );
}
