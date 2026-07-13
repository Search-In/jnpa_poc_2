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
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';

const resultColor = (r?: string) =>
  r === 'EXAM' ? tokens.severity.CRIT : r === 'HOLD' ? tokens.severity.WARN : tokens.kpi.better;

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
function ReleaseDialog({ containerNo, onClose }: { containerNo: string; onClose: () => void }) {
  const { adapter } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const confirm = async () => {
    if (!adapter.updateCargo) { setError('Cargo write is unavailable in this data mode.'); return; }
    setBusy(true);
    setError(null);
    try {
      await adapter.updateCargo(containerNo, { is_released: true });
      cargoRefreshStore.bump(); // refresh Scan + Movement + Yard/Pendency
      setDone(true);
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
            <CalciteNotice open kind="success" icon="check-circle" scale="s">
              <div slot="title">Released</div>
              <div slot="message">{containerNo} marked released from the port.</div>
            </CalciteNotice>
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
  const simDep = useSimDep();
  // Bumped after any cargo write → the queue (and dependent panels) refetch.
  const cargoRev = useCargoRefresh();
  const state = useAsync<ScanEvent[]>(() => adapter.getScanQueue(), [adapter, simDep, cargoRev]);
  // Container pending a release confirmation (null = no dialog).
  const [releaseTarget, setReleaseTarget] = useState<string | null>(null);
  return (
    <Panel heading={t('panel_scan', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(scans) => (
        <>
          <ImportExportToolbar data={scans} filename="scan-queue.csv" />
          {/* Re-sourced from the POC-3 shared Cargo API: the queue is the set of
              in-port (not-yet-released) containers, customs_status → scan result,
              so Release writes back to a real cargo record via PUT. */}
          <div><SourceBadge source="POC-3 Cargo · ICEGATE" live /></div>
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
          {scans.slice(0, 25).map((s) => (
            <CalciteTableRow key={s.scanId}>
              <CalciteTableCell>{s.containerNo}</CalciteTableCell>
              <CalciteTableCell>{(s as ScanEvent & { sealNo?: string }).sealNo ?? '—'}</CalciteTableCell>
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
                {/* Release the container from the port via the Cargo write API. */}
                <CalciteButton
                  scale="s"
                  appearance="outline"
                  kind="brand"
                  iconStart="unlock"
                  title="Release this container from the port (updates the Cargo record)"
                  onClick={() => setReleaseTarget(s.containerNo)}
                >
                  Release
                </CalciteButton>
              </CalciteTableCell>
              <CalciteTableCell>
                <CalciteChip value={s.result ?? 'PENDING'} style={{ ['--calcite-chip-text-color' as never]: resultColor(s.result) }}>
                  {s.result ?? 'PENDING'}
                </CalciteChip>
              </CalciteTableCell>
            </CalciteTableRow>
          ))}
          </CalciteTable>
          {releaseTarget && <ReleaseDialog containerNo={releaseTarget} onClose={() => setReleaseTarget(null)} />}
        </>
      )}
    </Panel>
  );
}
