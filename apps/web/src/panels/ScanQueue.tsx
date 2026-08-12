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
import { nextGate, gateUi, VERIFY_UI, type CargoGate } from './cargoGates.js';
import { CargoGateDialog } from './CargoGateDialog.js';
import { CustomsResultChip } from './CustomsResultChip.js';
import { partitionScanQueue, scanSelectionFor } from './scanSelection.js';
import { useRmsSelection } from '../state/useRmsSelection.js';

/** Yard-Assignment eligibility: the scan row carries `yardBlock` (mapped from the
 *  same GET /api/cargo the queue already fetched) once a yard has been assigned. */
const isYardAssigned = (s: ScanEvent) => !!(s as ScanEvent & { yardBlock?: string }).yardBlock;

const yardBlockOf = (s: ScanEvent) => (s as ScanEvent & { yardBlock?: string }).yardBlock;
const lifecycleOf = (s: ScanEvent) =>
  (s as ScanEvent & { lifecycleStatus?: string }).lifecycleStatus ?? 'CREATED';

/**
 * The raw customs disposition, carried straight through by the mapper.
 *
 * ⚠ This used to be re-derived from the scan result as
 * `result === 'HOLD' ? 'HELD' : undefined`, which silently dropped EXAM — so an
 * UNDER_INSPECTION container reached the release dialog looking as though customs
 * had no opinion on it, and the customs warning that exists for exactly that case
 * never rendered. `result` is a lossy projection; the gate needs the original.
 */
const customsStatusOf = (s: ScanEvent) =>
  (s as ScanEvent & { customsStatus?: string }).customsStatus;

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
function ReleaseDialog({ row, onClose, onDone }: { row: ScanEvent; onClose: () => void; onDone?: (row: ScanEvent, status: string) => void }) {
  const gate = gateFor(row);
  return (
    <CargoGateDialog
      gate={gate}
      // Everything left in this queue was selected for scanning — by a filed RMS
      // list or an operator's flag — so here the verify gate really is a scan.
      verifyKind="SCAN"

      containerNo={row.containerNo}
      lifecycle={lifecycleOf(row)}
      yardBlock={yardBlockOf(row)}
      customsStatus={customsStatusOf(row)}
      onClose={onClose}
      onDone={(status) => onDone?.(row, status)}
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
  // Which boxes a filed RMS scan list actually selected — shared with Movements
  // so both panels agree on whether a scan was ever ordered.
  const rms = useRmsSelection();
  // Row pending a release confirmation (null = no dialog).
  const [releaseTarget, setReleaseTarget] = useState<ScanEvent | null>(null);
  // Containers released in this session — disables a second Release (dedupe).
  const [released, setReleased] = useState<Set<string>>(new Set());
  /**
   * Rows acted on THIS SESSION, retained so the container stays visible after its
   * transition.
   *
   * The server's queue is WORK OUTSTANDING: `NOT IN ('VERIFIED','RELEASED')`. So
   * the moment a scan is recorded the container legitimately leaves — there is no
   * scan left to do — but a row vanishing the instant you act on it reads as "did
   * that work?" rather than "that worked". The retained copy carries the NEW
   * lifecycle, so the row updates in place instead of disappearing and its next
   * step advances: Record scan → Release.
   */
  const [retainedRows, setRetainedRows] = useState<ScanEvent[]>([]);
  // Panel-level success toast — names the gate that completed, not always release.
  const [toast, setToast] = useState<{ container: string; status: string } | null>(null);
  const onGateDone = (row: ScanEvent, status: string) => {
    // Only release is one-shot; the dedupe set exists to stop a second attempt.
    if (status === 'RELEASED') setReleased((s) => new Set(s).add(row.containerNo));
    setRetainedRows((rows) => [
      { ...row, lifecycleStatus: status } as ScanEvent,
      ...rows.filter((r) => r.containerNo !== row.containerNo),
    ]);
    setToast({ container: row.containerNo, status });
  };
  return (
    <>
    <Panel heading={t('panel_scan', lang)} state={state} isEmpty={(d) => d.filter(isYardAssigned).length === 0 && retainedRows.length === 0}>
      {(scans) => {
        // Eligibility: only YARD-ASSIGNED containers (yard_block set) enter the
        // Scan Queue. Newly-created / discharged-but-unassigned containers are
        // excluded until Yard Assignment completes (which sets yard_block and
        // bumps cargoRefreshStore → this list refetches and they appear). The
        // yard_block is carried on the scan row itself (no extra network call).
        const eligible = scans.filter(isYardAssigned);
        // Rows acted on this session WIN over the server copy: the retained row
        // carries the lifecycle the transition just produced, while a refetch that
        // raced the write could still return the old one.
        const acted = new Map(retainedRows.map((r) => [r.containerNo, r]));
        const merged = [
          ...eligible.map((sc) => acted.get(sc.containerNo) ?? sc),
          ...retainedRows.filter((r) => !eligible.some((sc) => sc.containerNo === r.containerNo)),
        ];
        // Scanning is a branch: keep the boxes a scan is actually due on and set
        // the facilitated ones aside. Until the RMS lists resolve, keep everything
        // — dropping rows on an unresolved set would hide real selections.
        const { due: displayScans, notDue } = rms.ready
          ? partitionScanQueue(merged, {
            containerNoOf: (r) => r.containerNo,
            resultOf: (r) => r.result as never,
            rmsSelected: rms.selected,
            alwaysKeep: new Set(retainedRows.map((r) => r.containerNo.toUpperCase())),
          })
          : { due: merged, notDue: [] as ScanEvent[] };
        return (
        <>
          {/* Release success toast (standardized). Closable; the queue also refetches. */}
          {toast && (
            <SuccessNotice
              title={toast.status === 'RELEASED' ? 'Container released successfully.'
                : toast.status === 'VERIFIED' ? 'Scan recorded — the container is now VERIFIED.'
                  : `Recorded — the container is now ${toast.status.replace(/_/g, ' ')}.`}
              details={[
                { label: 'Container', value: toast.container },
                { label: 'Lifecycle status', value: toast.status },
                ...(toast.status === 'VERIFIED'
                  ? [{ label: 'Next step', value: 'Release — the button on this row has advanced' }]
                  : []),
              ]}
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
          {/* The Result badge is the one claim on this tab an evaluator will try to
              trace, so it states its own provenance rather than leaving the reader
              to assume the customs corpus backs it (ticket UC2-004). */}
          <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 6px' }}>
            <CalciteIcon icon="information" scale="s" style={{ marginRight: 6 }} />
            <strong>Two independent tracks.</strong> <em>Lifecycle</em> is the port's custody of the
            box (discharge → yard → scan verified → released) and is what the buttons here advance.
            <em> Customs result</em> is what customs says about the goods — CLEAR means an
            out-of-charge was granted, EXAM that it was selected for scanning, HOLD that it is held.
            Recording a scan does not clear customs, and customs clearing the goods does not record a
            scan. Each customs badge is checked against the filed documents: a traced one names the
            record behind it; one no document supports is marked <strong>SIMULATED</strong>.
          </p>
          {/* Scanning is step 5 of the import lifecycle and reads "[RMS scan if
              selected]" — a branch. Listing facilitated boxes here, and offering
              them a Record-scan button, invented a scan nobody ordered. */}
          {notDue.length > 0 && (
            <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 6px' }}>
              <CalciteIcon icon="filter" scale="s" style={{ marginRight: 6 }} />
              <strong>{notDue.length}</strong> other container{notDue.length === 1 ? ' is' : 's are'} in
              the yard but not due a scan — RMS did not select {notDue.length === 1 ? 'it' : 'them'} and
              nobody has flagged {notDue.length === 1 ? 'it' : 'them'}. Scanning is a branch of the
              import lifecycle, not a step every box takes, so {notDue.length === 1 ? 'it goes' : 'they go'}
              {' '}straight to release verification on the Movements tab:{' '}
              <span style={{ color: tokens.color.text }}>
                {notDue.slice(0, 6).map((r) => r.containerNo).join(', ')}
                {notDue.length > 6 ? ` +${notDue.length - 6} more` : ''}
              </span>.
            </p>
          )}
          {/* Retained-row explainer: the backend filters is_released=false, so a
              released container leaves the live queue on reload. We keep it here,
              clearly marked, purely so operators can verify the release succeeded. */}
          {retainedRows.length > 0 && (
            <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '4px 0 0', display: 'flex', alignItems: 'center', gap: 6 }}>
              <CalciteIcon icon="information" scale="s" />
              Rows you acted on are kept here so you can see the result. The queue itself is work
              outstanding, so a <strong>VERIFIED</strong> or <strong>RELEASED</strong> container
              leaves it on reload — that is the scan being done, not the record being lost.
            </p>
          )}
          <CalciteTable caption="scan queue">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Container" description="and why a scan is due" />
            <CalciteTableHeader heading="e-Seal" />
            <CalciteTableHeader heading="Pre-doc" />
            {/* Was "Flagged by", which rendered a hardcoded 'CUSTOMS' on every row —
                the mapper sets it as a constant, so it carried no information. The
                lifecycle position is what actually varies, and it is what decides
                which action the row offers. */}
            <CalciteTableHeader heading="Lifecycle" description="Where the box has got to" />
            {/* Was "Start", implying a scan start time. The value is the cargo
                record's `updated_at`; there is no scan-start timestamp in the data. */}
            <CalciteTableHeader heading="Last updated" />
            <CalciteTableHeader heading="Next step" />
            <CalciteTableHeader heading="Customs result" description="What customs says about the goods" />
          </CalciteTableRow>
          {displayScans.slice(0, 25).map((s) => {
            const isReleased = released.has(s.containerNo);
            return (
            <CalciteTableRow key={s.scanId} style={isReleased ? { opacity: 0.72 } : undefined}>
              <CalciteTableCell>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  {s.containerNo}
                  {(() => {
                    // Name the instruction that put this box under the scanner —
                    // a filed RMS list, or an operator's flag. Without it, "why is
                    // this here?" has no answer on the row.
                    const sel = scanSelectionFor(s.result as never,
                      rms.selected.has(s.containerNo.toUpperCase()));
                    if (!sel.reason) return null;
                    return (
                      <CalciteChip scale="s" value={sel.reason} title={sel.explain}
                        style={{ ['--calcite-chip-text-color' as never]:
                          sel.reason === 'RMS' ? tokens.color.brand : tokens.severity.WARN }}>
                        {sel.reason === 'RMS' ? 'RMS-selected' : 'Flagged'}
                      </CalciteChip>
                    );
                  })()}
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
                    iconStart={gateUi(gateFor(s), 'SCAN').icon}
                    title={`Next step for this container (currently ${lifecycleOf(s)})`}
                    onClick={() => setReleaseTarget(s)}
                  >
                    {/* The label names the NEXT GATE, not always "Release". Offering
                        Release on an unverified box produced a 409 the operator read
                        as "release_failed". */}
                    {gateFor(s) === 'yard' ? 'Assign yard'
                      : gateFor(s) === 'verify' ? VERIFY_UI.SCAN.label
                        : 'Release'}
                  </CalciteButton>
                )}
              </CalciteTableCell>
              <CalciteTableCell>
                {/* ALWAYS the customs disposition — never the lifecycle. This cell
                    used to show RELEASED once a container was released, which merged
                    the two independent tracks into one column and made "CLEAR"
                    look like an outcome of the scan. Where the container has got to
                    is the Lifecycle column's job; what customs says about the goods
                    is this one's. The badge also carries its own provenance — the
                    document that produced it, or a SIMULATED mark. */}
                <CustomsResultChip containerNo={s.containerNo} result={s.result} />
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
    {releaseTarget && <ReleaseDialog row={releaseTarget} onClose={() => setReleaseTarget(null)} onDone={onGateDone} />}
    </>
  );
}
