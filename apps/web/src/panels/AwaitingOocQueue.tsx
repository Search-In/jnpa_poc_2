/**
 * Awaiting out-of-charge — the containers customs is still holding.
 *
 * The worklist for the OOC step. Every row is a cargo record whose
 * `customs_status` is UNDER_INSPECTION or HELD, which is exactly the set the
 * server refuses to release (`release_cargo` passes
 * `blocked_customs={HELD, UNDER_INSPECTION}` into the same locked read that
 * checks the lifecycle, and answers `409 customs_not_cleared`). Recording the
 * out-of-charge here is what lets those containers leave the port.
 *
 * Without this the action existed but was unfindable: it lived on one row of a
 * ~11,900-row paginated Movements grid, so you had to already know which
 * container you were hunting. Nothing listed the flagged ones.
 *
 * ⚠ THIS IS NOT THE FILED BILL-OF-ENTRY REGISTER. {@link OocPanel}, directly
 * below, renders real ICEGATE CHPOI10 documents — BE number, importer, assessed
 * value, duty, the granted out-of-charge — every value as filed. This table
 * renders operational cargo records, and the two sets are DISJOINT:
 * `core.cargo ∩ core.ooc_item = 0 containers` (03_RMS_Scan_Data_Gap.md §6).
 * They are deliberately two tables. Merging them would put rows with one
 * populated column beside real filings with twelve, and "Record OOC" writes
 * `core.cargo.customs_status` — it files no BE, so a cleared container would
 * leave this list and never appear in the register.
 */
import { useMemo, useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteButton, CalciteChip, CalciteIcon, CalciteNotice, CalciteCheckbox,
} from '@esri/calcite-components-react';
import type { CargoCustomsStatus, ContainerMovementDTO } from '@jnpa/data';
import type { BlockedPage } from './awaitingOoc.js';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { SuccessNotice } from '../components/SuccessNotice.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { cargoRefreshStore, useCargoRefresh } from '../state/cargoRefreshStore.js';
import { cargoErrorMessage } from '../state/cargoError.js';
import { customsActionsFor, CUSTOMS_ACTION_UI } from './cargoGates.js';
import { BLOCKING_CUSTOMS, mergeBlockedPages, waitingLabel } from './awaitingOoc.js';
import { scanSelectionFor } from './scanSelection.js';
import { useRmsSelection } from '../state/useRmsSelection.js';
import { tokens } from '../theme/tokens.js';

/**
 * How many rows to pull per disposition.
 *
 * Server-side filtered (`GET /api/cargo?customs_status=…`), so this is a page of
 * the blocked population rather than a page of everything filtered down. The
 * header total is read alongside it so a truncated page can SAY it is truncated
 * instead of quietly presenting itself as the whole queue.
 */
const PAGE = 200;

const val = (v: unknown): string =>
  (v === null || v === undefined || v === '' ? '—' : String(v));

const lifecycleOf = (m: ContainerMovementDTO): string =>
  m.cargo?.lifecycle_status || 'CREATED';

/** One container whose write failed, kept structured so a retry can target it. */
interface Failure {
  containerNo: string;
  message: string;
}

export function AwaitingOocQueue() {
  const { adapter } = useApp();
  const cargoRev = useCargoRefresh();
  // Which boxes a filed RMS scan list actually selected — the same source the
  // Scan tab and Movements use, so all three agree on WHY a box is under exam.
  const rms = useRmsSelection();

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [done, setDone] = useState<{ cleared: number; failed: number } | null>(null);

  const state = useAsync<BlockedPage<ContainerMovementDTO>>(async () => {
    // One request per blocking disposition: `customs_status` takes a single value.
    const pages = await Promise.all(BLOCKING_CUSTOMS.map(async (cs) => {
      if (adapter.getContainerMovementsPage) {
        return adapter.getContainerMovementsPage({ customsStatus: cs, limit: PAGE });
      }
      // Mock/offline adapters expose only the bare list. No header, no total —
      // say so rather than reporting the page size as the population.
      const items = await adapter.getContainerMovements({ customsStatus: cs, limit: PAGE });
      return { items, total: null };
    }));
    return mergeBlockedPages(pages);
  }, [adapter, cargoRev]);

  /**
   * Record a disposition on one container. Returns the error text on failure so
   * the bulk caller can report WHICH containers failed instead of one aggregate
   * "some writes failed" the operator cannot act on.
   */
  const write = async (containerNo: string, status: CargoCustomsStatus): Promise<string | null> => {
    if (!adapter.updateCargo) return 'Cargo write is unavailable in this data mode.';
    try {
      await adapter.updateCargo(containerNo, { customs_status: status });
      return null;
    } catch (e) {
      return cargoErrorMessage(e);
    }
  };

  const runOne = async (containerNo: string, status: CargoCustomsStatus) => {
    setBusy(true);
    setFailures([]);
    setDone(null);
    const err = await write(containerNo, status);
    if (err) setFailures([{ containerNo, message: err }]);
    else setDone({ cleared: status === 'CLEARED' ? 1 : 0, failed: 0 });
    cargoRefreshStore.bump();
    setSelected((s) => { const n = new Set(s); n.delete(containerNo); return n; });
    setBusy(false);
  };

  /**
   * Record an out-of-charge for every selected container.
   *
   * SEQUENTIAL, not `Promise.all`: each write is a PUT against the shared backend
   * and a burst of them is a self-inflicted load spike on a demo instance. It also
   * keeps the failure report ordered and lets a partial run report exactly how far
   * it got — a parallel batch that half-fails leaves the operator guessing.
   */
  const runBulk = async () => {
    const targets = [...selected];
    if (targets.length === 0) return;
    setBusy(true);
    setFailures([]);
    setDone(null);
    const failed: Failure[] = [];
    for (const cn of targets) {
      const err = await write(cn, 'CLEARED');
      if (err) failed.push({ containerNo: cn, message: err });
    }
    setFailures(failed);
    setDone({ cleared: targets.length - failed.length, failed: failed.length });
    cargoRefreshStore.bump();
    // Keep only the ones that failed selected, so a retry re-runs exactly those.
    setSelected(new Set(failed.map((f) => f.containerNo)));
    setBusy(false);
  };

  return (
    <Panel
      heading="Awaiting out-of-charge"
      description="Cargo records customs is holding or examining — the port will not release these until an out-of-charge is recorded."
      state={state}
      isEmpty={(d) => d.items.length === 0}
    >
      {({ items: rows, total }) => <Table
        rows={rows}
        total={total}
        rmsSelected={rms.selected}
        selected={selected}
        setSelected={setSelected}
        busy={busy}
        failures={failures}
        done={done}
        onOne={runOne}
        onBulk={runBulk}
        onDismiss={() => { setDone(null); setFailures([]); }}
      />}
    </Panel>
  );
}

function Table({
  rows, total, rmsSelected, selected, setSelected, busy, failures, done, onOne, onBulk, onDismiss,
}: {
  rows: ContainerMovementDTO[];
  total: number | null;
  rmsSelected: ReadonlySet<string>;
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
  busy: boolean;
  failures: Failure[];
  done: { cleared: number; failed: number } | null;
  onOne: (containerNo: string, status: CargoCustomsStatus) => void;
  onBulk: () => void;
  onDismiss: () => void;
}) {
  const nos = useMemo(() => rows.map((m) => m.container.containerNo), [rows]);
  // One clock read per render, shared by every row: two rows computed a
  // millisecond apart must not disagree about where the day boundary is.
  const now = Date.now();
  const allSelected = nos.length > 0 && nos.every((cn) => selected.has(cn));

  const toggle = (cn: string) => setSelected((s) => {
    const n = new Set(s);
    if (n.has(cn)) n.delete(cn); else n.add(cn);
    return n;
  });

  return (
    <>
      {done && (
        <SuccessNotice
          title={done.failed === 0
            ? `Out-of-charge recorded for ${done.cleared} container${done.cleared === 1 ? '' : 's'}.`
            : `Recorded ${done.cleared}, failed ${done.failed}.`}
          details={[
            { label: 'Effect', value: 'customs_status → CLEARED on the shared cargo record' },
            { label: 'Next step', value: 'Release is now available on Movements and the Scan step' },
          ]}
          closable
          onClose={onDismiss}
          style={{ marginBottom: 8 }}
        />
      )}
      {failures.length > 0 && (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s" style={{ margin: '6px 0' }}>
          <div slot="title">
            Could not record {failures.length} out-of-charge{failures.length === 1 ? '' : 's'}
          </div>
          {/* Name every container. A bulk run that reports only a count leaves the
              operator with no idea which boxes still need attention — and these
              stay selected, so Record OOC retries exactly the ones that failed. */}
          <div slot="message">
            <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
              {failures.map((f) => <li key={f.containerNo}>{f.containerNo}: {f.message}</li>)}
            </ul>
          </div>
        </CalciteNotice>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <CalciteButton
          scale="s"
          iconStart="unlock"
          loading={busy}
          disabled={busy || selected.size === 0}
          title="Record an out-of-charge (customs_status → CLEARED) for every selected container"
          onClick={onBulk}
        >
          Record OOC{selected.size > 0 ? ` · ${selected.size}` : ''}
        </CalciteButton>
        <ImportExportToolbar
          data={rows.map((m) => ({
            'Container No': m.container.containerNo,
            'Customs Status': m.cargo?.customs_status ?? '',
            'Lifecycle': lifecycleOf(m),
            'Yard Block': m.cargo?.yard_block ?? '',
            'Vessel': m.cargo?.vessel_name ?? '',
            'Last Updated': m.cargo?.updated_at ?? '',
          }))}
          filename="awaiting-out-of-charge.csv"
        />
      </div>

      {/* These are cargo records, NOT filed Bills of Entry — the register below is
          the filed set, and the two share no containers at all. */}
      <div><SourceBadge source="POC-3 Cargo" live /></div>

      {/* 03_RMS_Scan_Data_Gap.md §6.1: `reconcile_cargo_status()` is correct code
          that can never fire on this dataset, so every CLEARED here is operator-
          entered rather than derived from a filed out-of-charge. Adding a button
          that writes more of them makes stating that caveat mandatory, not
          optional — an evaluator reading "CLEARED" will assume customs granted it. */}
      <CalciteNotice open kind="warning" icon="information" scale="s" style={{ margin: '6px 0' }}>
        <div slot="title">These are cargo records, not filed Bills of Entry</div>
        <div slot="message">
          Recording an out-of-charge here writes <code>customs_status = CLEARED</code> on
          the shared cargo record, which is what permits the port to release the
          container. It does <strong>not</strong> file an ICEGATE out-of-charge, and no
          document backs it: these containers appear in no Bill of Entry in the corpus
          (<code>core.cargo</code> and <code>core.ooc_item</code> share zero containers).
          The filed register below is the real one.
        </div>
      </CalciteNotice>

      {total != null && total > rows.length && (
        <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 6px' }}>
          <CalciteIcon icon="filter" scale="s" style={{ marginRight: 6 }} />
          Showing <strong>{rows.length}</strong> of <strong>{total}</strong> containers awaiting
          an out-of-charge. Clear these and the next page loads.
        </p>
      )}

      <CalciteTable scale="s" caption="Containers awaiting a customs out-of-charge">
        <CalciteTableRow slot="table-header">
          <CalciteTableHeader heading="" />
          <CalciteTableHeader heading="Container" />
          <CalciteTableHeader heading="Customs" />
          <CalciteTableHeader heading="Why" description="What put it under examination" />
          <CalciteTableHeader heading="Lifecycle" />
          <CalciteTableHeader heading="Yard" />
          <CalciteTableHeader heading="Vessel" />
          <CalciteTableHeader heading="Waiting" />
          <CalciteTableHeader heading="Action" />
        </CalciteTableRow>
        {rows.map((m) => {
          const cn = m.container.containerNo;
          const cs = m.cargo?.customs_status ?? 'PENDING';
          const result = cs === 'HELD' ? 'HOLD' : cs === 'UNDER_INSPECTION' ? 'EXAM' : undefined;
          const why = scanSelectionFor(result, rmsSelected.has(cn.trim().toUpperCase()));
          return (
            <CalciteTableRow key={cn}>
              <CalciteTableCell>
                <CalciteCheckbox
                  checked={selected.has(cn)}
                  disabled={busy}
                  label={`Select ${cn}`}
                  onCalciteCheckboxChange={() => toggle(cn)}
                />
              </CalciteTableCell>
              <CalciteTableCell><strong>{cn}</strong></CalciteTableCell>
              <CalciteTableCell>
                <CalciteChip scale="s" icon="flag" value={cs}
                  style={{ ['--calcite-chip-text-color' as never]:
                    cs === 'HELD' ? tokens.severity.CRIT : tokens.congestion.AMBER }}>
                  {cs === 'UNDER_INSPECTION' ? 'EXAM' : cs}
                </CalciteChip>
              </CalciteTableCell>
              <CalciteTableCell>
                {/* RMS = a filed scan list named it. FLAGGED = an operator did.
                    On this corpus it is always FLAGGED — the RMS lists and the
                    cargo table share no containers (§2 of the gap report) — and
                    showing which it is keeps that visible rather than implied. */}
                <CalciteChip scale="s" value={why.reason ?? '—'} title={why.explain}
                  style={{ ['--calcite-chip-text-color' as never]:
                    why.reason === 'RMS' ? tokens.kpi.better : tokens.color.textMuted }}>
                  {why.reason === 'RMS' ? 'RMS list' : why.reason === 'FLAGGED' ? 'Operator flag' : '—'}
                </CalciteChip>
              </CalciteTableCell>
              <CalciteTableCell>{lifecycleOf(m).replace(/_/g, ' ')}</CalciteTableCell>
              <CalciteTableCell>{val(m.cargo?.yard_block)}</CalciteTableCell>
              <CalciteTableCell>{val(m.cargo?.vessel_name)}</CalciteTableCell>
              <CalciteTableCell>{waitingLabel(m.cargo?.updated_at, now)}</CalciteTableCell>
              <CalciteTableCell>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {/* Same rule and same copy as the Movements customs cell, so the
                      two surfaces cannot describe the same act differently. */}
                  {customsActionsFor(cs).map((action) => {
                    const a = CUSTOMS_ACTION_UI[action];
                    return (
                      <CalciteButton key={action} scale="s" appearance="outline" kind={a.kind}
                        iconStart={a.icon} title={a.title} disabled={busy}
                        onClick={() => onOne(cn, a.status)}>
                        {a.label}
                      </CalciteButton>
                    );
                  })}
                </div>
              </CalciteTableCell>
            </CalciteTableRow>
          );
        })}
      </CalciteTable>

      {rows.length > 0 && (
        <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '6px 0 0' }}>
          <CalciteCheckbox
            checked={allSelected}
            disabled={busy}
            label="Select all"
            style={{ marginRight: 6 }}
            onCalciteCheckboxChange={() =>
              setSelected(allSelected ? new Set() : new Set(nos))}
          />
          Select all {rows.length} on this page.
        </p>
      )}
    </>
  );
}
