/**
 * Customs scanner flagging + damage-assessment status (prompt §10). Shows the
 * live scan queue (flagged → start → clear), drives Scanner TAT visibility.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip,
  CalciteButton, CalciteNotice, CalciteIcon,
} from '@esri/calcite-components-react';
import type { ScanEvent } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { SuccessNotice } from '../components/SuccessNotice.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimStore } from '../sim/useSimStore.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';

const resultColor = (r?: string) =>
  r === 'EXAM' ? tokens.severity.CRIT : r === 'HOLD' ? tokens.severity.WARN : tokens.kpi.better;

/** Yard-Assignment eligibility: the scan row carries `yardBlock` (mapped from the
 *  same GET /api/cargo the queue already fetched) once a yard has been assigned. */
const isYardAssigned = (s: ScanEvent) => !!(s as ScanEvent & { yardBlock?: string }).yardBlock;

// Pre-document-processing status colour (from the e-seal reader state).
const preDocColor = (p?: string) =>
  p === 'TAMPER' ? tokens.severity.CRIT : p === 'VERIFIED' ? tokens.kpi.better : tokens.severity.WARN;

/**
 * Release confirmation — releases a container from the port by updating the live
 * POC-3 cargo record via the existing Poc3CargoAdapter write
 * (`PUT /api/cargo/{id} { is_released: true }`). Reuses the app's role="dialog"
 * overlay + CalciteNotice feedback. On success it bumps cargoRefreshStore so the
 * Scan Queue + Movement + Yard/Pendency refetch through the existing adapter flow.
 */
function ReleaseDialog({ row, onClose, onReleased }: { row: ScanEvent; onClose: () => void; onReleased?: (row: ScanEvent) => void }) {
  const { adapter } = useApp();
  const containerNo = row.containerNo;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const confirm = async () => {
    if (!adapter.updateCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    // Guard against a duplicate release (double-click / re-confirm).
    if (busy || done) return;
    setBusy(true);
    setError(null);
    try {
      await adapter.updateCargo(containerNo, { is_released: true });
      cargoRefreshStore.bump(); // refresh Scan + Movement + Yard/Pendency
      setDone(true);
      onReleased?.(row); // retain row (stays visible) + toast + disable duplicate release
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
        aria-label={`Release ${containerNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(400px, 96vw)', background: tokens.color.bgPanel, border: `1px solid ${tokens.color.border}`,
          borderRadius: 12, boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="unlock" scale="s" />
          <strong style={{ fontSize: 14 }}>Release container</strong>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>
        <div style={{ padding: 14 }}>
          {done ? (
            <SuccessNotice title="Container released successfully." details={[{ label: 'Container', value: containerNo }]} />
          ) : (
            <p style={{ fontSize: 13, margin: 0 }}>
              Release <strong>{containerNo}</strong> from the port? This updates the Cargo record (<code>is_released</code>) via POC-3.
            </p>
          )}
          {error && (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ marginTop: 10 }}>
              <div slot="title">Release failed</div>
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
              <CalciteButton scale="s" kind="brand" iconStart="unlock" loading={busy} disabled={busy} onClick={confirm}>Confirm release</CalciteButton>
            </>
          )}
        </div>
      </div>
    </>
  );
}

export function ScanQueue() {
  const { adapter, lang } = useApp();
  // Refetch on the What-If scan lever (scanQueue) — NOT on the clock `tick` that
  // `useSimDep` embeds — so the network-backed Scan tab stops refetching (and
  // blinking) once per second while the sim clock runs. scanQueue is null when
  // idle (stable) and only changes under a scan What-If, where a refresh is wanted.
  const scanLever = useSimStore().scanQueue;
  // Bumped after any cargo write → the queue (and dependent panels) refetch.
  const cargoRev = useCargoRefresh();
  const state = useAsync<ScanEvent[]>(() => adapter.getScanQueue(), [adapter, scanLever, cargoRev]);
  // Row pending a release confirmation (null = no dialog).
  const [releaseTarget, setReleaseTarget] = useState<ScanEvent | null>(null);
  // Containers released in this session — disables a second Release (dedupe).
  const [released, setReleased] = useState<Set<string>>(new Set());
  // Rows released this session are RETAINED so the container STAYS VISIBLE in the
  // queue for verification, even though the backend (is_released=false) filters it
  // out on the next refetch. Nothing here changes the release API or its logic.
  const [releasedRows, setReleasedRows] = useState<ScanEvent[]>([]);
  // Panel-level success toast shown after a release succeeds.
  const [toast, setToast] = useState<string | null>(null);
  const onReleased = (row: ScanEvent) => {
    setReleased((s) => new Set(s).add(row.containerNo));
    setReleasedRows((rows) => [row, ...rows.filter((r) => r.containerNo !== row.containerNo)]);
    setToast(row.containerNo); // container number → standardized success toast below
  };
  return (
    <>
    <Panel heading={t('panel_scan', lang)} state={state} isEmpty={(d) => d.filter(isYardAssigned).length === 0 && releasedRows.length === 0}>
      {(scans) => {
        // Eligibility: only YARD-ASSIGNED containers (yard_block set) enter the
        // Scan Queue. Newly-created / discharged-but-unassigned containers are
        // excluded until Yard Assignment completes (which sets yard_block and
        // bumps cargoRefreshStore → this list refetches and they appear). The
        // yard_block is carried on the scan row itself (no extra network call).
        const eligible = scans.filter(isYardAssigned);
        // Merge with rows released this session so released containers stay visible
        // for verification (the backend filters them out on refetch).
        const shownNos = new Set(eligible.map((sc) => sc.containerNo));
        const displayScans = [...eligible, ...releasedRows.filter((r) => !shownNos.has(r.containerNo))];
        return (
        <>
          {/* Release success toast (standardized). Closable; the queue also refetches. */}
          {toast && (
            <SuccessNotice
              title="Container released successfully."
              details={[{ label: 'Container', value: toast }]}
              closable
              onClose={() => setToast(null)}
              style={{ marginBottom: 8 }}
            />
          )}
          <ImportExportToolbar data={displayScans} filename="scan-queue.csv" />
          {/* Re-sourced from the POC-3 shared Cargo API: the queue is the set of
              in-port (not-yet-released) containers, customs_status → scan result,
              so Release writes back to a real cargo record via PUT. */}
          <div><SourceBadge source="POC-3 Cargo · ICEGATE" live /></div>
          {/* Retained-row explainer: the backend filters is_released=false, so a
              released container leaves the live queue on reload. We keep it here,
              clearly marked, purely so operators can verify the release succeeded. */}
          {releasedRows.length > 0 && (
            <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <CalciteIcon icon="information" scale="s" />
              Rows marked <strong style={{ color: tokens.kpi.better }}>RELEASED</strong> are retained here for verification only and clear when the queue reloads.
            </p>
          )}
          <CalciteTable caption="scan queue">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Container" />
            <CalciteTableHeader heading="e-Seal" />
            <CalciteTableHeader heading="Pre-doc" />
            <CalciteTableHeader heading="Flagged by" />
            <CalciteTableHeader heading="Start" />
            <CalciteTableHeader heading="Action" />
            <CalciteTableHeader heading="Result" />
          </CalciteTableRow>
          {displayScans.slice(0, 25).map((s) => {
            const isReleased = released.has(s.containerNo);
            return (
            <CalciteTableRow key={s.scanId} style={isReleased ? { opacity: 0.72 } : undefined}>
              <CalciteTableCell>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {s.containerNo}
                  {isReleased && (
                    <CalciteChip scale="s" icon="check" value="released" title="Retained for verification only" style={{ ['--calcite-chip-text-color' as never]: tokens.kpi.better }}>
                      Released
                    </CalciteChip>
                  )}
                </span>
              </CalciteTableCell>
              <CalciteTableCell>
                {/* e-Seal number from the POC-3 record; the seal status (ACTIVE /
                    TAMPERED / …) rides along as a hover title when present. */}
                <span title={(s as ScanEvent & { esealStatus?: string }).esealStatus ?? undefined}>
                  {(s as ScanEvent & { sealNo?: string }).sealNo ?? '—'}
                </span>
              </CalciteTableCell>
              <CalciteTableCell>
                {(() => {
                  const pd = (s as ScanEvent & { preDoc?: string }).preDoc ?? '—';
                  return (
                    <CalciteChip value={pd} style={{ ['--calcite-chip-text-color' as never]: preDocColor(pd) }}>{pd}</CalciteChip>
                  );
                })()}
              </CalciteTableCell>
              <CalciteTableCell>{s.flaggedBy}</CalciteTableCell>
              <CalciteTableCell>{new Date(s.startTs).toLocaleString()}</CalciteTableCell>
              <CalciteTableCell>
                {/* Release the container from the port via the Cargo write API.
                    Once released this session the button is DISABLED (dedupe) and the
                    row is retained (see releasedRows) so it stays visible. */}
                {released.has(s.containerNo) ? (
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="neutral"
                    iconStart="check"
                    disabled
                    title="Container already released"
                  >
                    Released
                  </CalciteButton>
                ) : (
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="brand"
                    iconStart="unlock"
                    title="Release this container from the port (updates the Cargo record)"
                    onClick={() => setReleaseTarget(s)}
                  >
                    Release
                  </CalciteButton>
                )}
              </CalciteTableCell>
              <CalciteTableCell>
                {released.has(s.containerNo) ? (
                  <CalciteChip scale="s" icon="check" value="RELEASED" style={{ ['--calcite-chip-text-color' as never]: tokens.kpi.better }}>
                    RELEASED
                  </CalciteChip>
                ) : (
                  <CalciteChip value={s.result ?? 'PENDING'} style={{ ['--calcite-chip-text-color' as never]: resultColor(s.result) }}>
                    {s.result ?? 'PENDING'}
                  </CalciteChip>
                )}
              </CalciteTableCell>
            </CalciteTableRow>
            );
          })}
          </CalciteTable>
        </>
        );
      }}
    </Panel>
    {/* Mounted OUTSIDE the Panel so the dialog survives the post-release refetch
        (the Panel unmounts its children while useAsync reloads, which would reset
        the dialog's success state and re-show the confirmation UI). */}
    {releaseTarget && <ReleaseDialog row={releaseTarget} onClose={() => setReleaseTarget(null)} onReleased={onReleased} />}
    </>
  );
}
