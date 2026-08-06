/**
 * Customs scanner flagging + damage-assessment status (prompt §10). Shows the
 * live scan queue (flagged → start → clear), drives Scanner TAT visibility.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip,
  CalciteButton, CalciteIcon,
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
import { useCargoRefresh } from '../state/cargoRefreshStore.js';
import { nextGate, GATE_UI, uiGate, type CargoGate } from './cargoGates.js';
import { CargoGateDialog } from './CargoGateDialog.js';

const resultColor = (r?: string) =>
  r === 'EXAM' ? tokens.severity.CRIT : r === 'HOLD' ? tokens.severity.WARN : tokens.kpi.better;

/** Yard-Assignment eligibility: the scan row carries `yardBlock` (mapped from the
 *  same GET /api/cargo the queue already fetched) once a yard has been assigned. */
const isYardAssigned = (s: ScanEvent) => !!(s as ScanEvent & { yardBlock?: string }).yardBlock;

const yardBlockOf = (s: ScanEvent) => (s as ScanEvent & { yardBlock?: string }).yardBlock;
const lifecycleOf = (s: ScanEvent) =>
  (s as ScanEvent & { lifecycleStatus?: string }).lifecycleStatus ?? 'CREATED';

/**
 * Which gate this row is at. Delegates to the shared state-machine mirror so the
 * Scan tab and Movements cannot disagree.
 *
 * ⚠ A row can be IN the queue while its lifecycle is still `CREATED`: the server
 * admits anything with a `yard_block` set, and the seeded data wrote that column
 * directly without ever running the transition. `inYard` is therefore always true
 * here — queue membership implies a block — so such a row's next step is to catch
 * the record up, not to be discharged again.
 */
const gateFor = (s: ScanEvent): CargoGate =>
  nextGate(lifecycleOf(s), { inYard: true }) ?? 'yard';

// Pre-document-processing status colour (from the e-seal reader state).
const preDocColor = (p?: string) =>
  p === 'TAMPER' ? tokens.severity.CRIT : p === 'VERIFIED' ? tokens.kpi.better : tokens.severity.WARN;

/**
 * The gate confirmation for one scan-queue row, wrapping the shared
 * {@link CargoGateDialog} so this tab and Movements drive the same transitions.
 */
function ReleaseDialog({ row, onClose, onReleased }: { row: ScanEvent; onClose: () => void; onReleased?: (row: ScanEvent) => void }) {
  const gate = gateFor(row);
  return (
    <CargoGateDialog
      gate={gate}
      containerNo={row.containerNo}
      lifecycle={lifecycleOf(row)}
      yardBlock={yardBlockOf(row)}
      customsStatus={row.result === 'HOLD' ? 'HELD' : undefined}
      onClose={onClose}
      onDone={(status) => { if (status === 'RELEASED') onReleased?.(row); }}
    />
  );
}

export function ScanQueueTable() {
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
            {/* Was "Flagged by", which rendered a hardcoded 'CUSTOMS' on every row —
                the mapper sets it as a constant, so it carried no information. The
                lifecycle position is what actually varies, and it is what decides
                which action the row offers. */}
            <CalciteTableHeader heading="Lifecycle" />
            {/* Was "Start", implying a scan start time. The value is the cargo
                record's `updated_at`; there is no scan-start timestamp in the data. */}
            <CalciteTableHeader heading="Last updated" />
            <CalciteTableHeader heading="Next step" />
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
              <CalciteTableCell>
                {(() => {
                  const lc = lifecycleOf(s);
                  return (
                    <CalciteChip
                      scale="s"
                      value={lc}
                      title={`Lifecycle position — decides the next step offered.\nYard block: ${yardBlockOf(s) ?? 'not set'}`}
                      style={{ ['--calcite-chip-text-color' as never]:
                        lc === 'VERIFIED' ? tokens.kpi.better
                          : lc === 'CREATED' ? tokens.color.textMuted : tokens.color.brand }}
                    >
                      {lc.replace(/_/g, ' ')}
                    </CalciteChip>
                  );
                })()}
              </CalciteTableCell>
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
                    iconStart={GATE_UI[uiGate(gateFor(s))].icon}
                    title={`Next step for this container (currently ${lifecycleOf(s)})`}
                    onClick={() => setReleaseTarget(s)}
                  >
                    {/* The label names the NEXT GATE, not always "Release". Offering
                        Release on an unverified box produced a 409 the operator read
                        as "release_failed". */}
                    {gateFor(s) === 'yard' ? 'Assign yard'
                      : gateFor(s) === 'verify' ? 'Record scan'
                        : 'Release'}
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
