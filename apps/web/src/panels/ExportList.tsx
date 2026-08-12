/**
 * Export — the terminal load list (EAL) and each box's export chain.
 *
 * Step 7 of the canonical export order (markdowns/03_Export_Container_Lifecycle.md):
 * the shipping line declares to a terminal, for a named vessel visit, every
 * container it intends to load. 5,743 rows across 5 visits — the only export
 * source in the corpus at population scale.
 *
 * Data source (POC-3):
 *   GET /api/shipping-lines?list_type=EAL   -> the load list (this table)
 *   GET /api/shipping-lines/gate-movements  -> CODECO gate-in for a container
 *
 * ⚠ THREE THINGS THIS PANEL MUST NOT IMPLY.
 * 1. There is no Shipping Bill / LEO column, and there must not be one until
 *    customs supply an SB extract carrying a container number. The filed SBs
 *    have no container column at all, so such a column would render empty on
 *    every one of the 5,743 rows. See markdowns/04_Export_Build_Plan.md §3.2.
 * 2. The BMCT list carries no vessel column — `vessel_visit` is null on all 588
 *    of its rows because that is how the file was supplied. Those rows show
 *    "not stated", never a guessed visit.
 * 3. The table shows ONE PAGE of the register, so it must never present its row
 *    count as the population — it reads "Showing 500 of 5,743". Search therefore
 *    goes to the server (`q`), because filtering the loaded page made every
 *    container past page 1 look absent.
 */
import { useEffect, useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteChip, CalciteButton, CalciteIcon, CalciteNotice, CalciteInput,
  CalciteLabel, CalciteLoader, CalciteSelect, CalciteOption,
  CalciteSegmentedControl, CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import type {
  AdvanceListContainer, GateMovement, SourceGateDocument, VesselDeparture,
  Form11Entry, CoprarItem, CoarriMove, SyntheticChain, VesselCutoff,
} from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { LifecycleSteps, EXPORT_STEPS, EXPORT_VIEWS, SHARED_SURFACES } from './LifecycleSteps.js';
import { UPLOAD_TARGETS } from './uploadTargets.js';
import { ShippingBills, Leo } from './CustomsRegisters.js';
import { InfoPopover } from '../components/InfoPopover.js';
import { tokens } from '../theme/tokens.js';

const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

/** Numerics arrive as decimal STRINGS (Postgres numeric) — coerce before maths. */
function fmtWeight(v?: number | string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  // Filed in kg; tonnes read better at load-list scale.
  return `${(n / 1000).toLocaleString(undefined, { maximumFractionDigits: 2 })} t`;
}

const fmtTs = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};

/** Same ZZZ-sentinel rule as the manifest view — see Igm.tsx `hazardClass`. */
function hazardClass(v?: string | null): string | null {
  const s = (v ?? '').trim();
  if (!s || s.toUpperCase() === 'ZZZ') return null;
  return s;
}

/**
 * One container's export chain: the load-list line it sits on, plus its CODECO
 * gate-in if the terminal filed one.
 *
 * The corpus holds only 5 CODECO messages against 5,743 load-list lines, so a
 * match here is the exception, not the rule. The dialog says so explicitly
 * rather than rendering an empty panel that reads like a data fault.
 */
function ExportChainDialog({ row, onClose }: { row: AdvanceListContainer; onClose: () => void }) {
  const { adapter } = useApp();
  const containerNo = row.container_no;
  const moves = useAsync<GateMovement[]>(
    () => (adapter.getGateMovements
      ? adapter.getGateMovements(undefined, { limit: 500 })
      : Promise.resolve([])),
    [adapter],
  );
  const gateIn = (moves.data ?? []).find((m) => m.container_no === containerNo);

  const section = (title: string) => (
    <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '14px 0 6px' }}>
      {title}
    </div>
  );
  const facts = (rows: Array<[string, string]>) => (
    <div
      style={{
        display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
        gap: '6px 16px', fontSize: 12, color: tokens.color.textMuted,
        background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
        borderRadius: 6, padding: '10px 12px',
      }}
    >
      {rows.map(([label, value]) => (
        <div key={label}>
          <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
          <strong style={{ color: tokens.color.text, fontSize: 12.5 }}>{value}</strong>
        </div>
      ))}
    </div>
  );

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label={`Export chain for container ${containerNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(880px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="container" scale="s" />
          <strong style={{ fontSize: 14 }}>{val(containerNo)}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            {val(row.terminal)} · visit {row.vessel_visit ?? 'not stated'}
          </span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {section('Declared on the export advance list')}
          {facts([
            ['Container', val(row.container_no)],
            ['ISO', val(row.iso_code)],
            ['Freight kind', val(row.freight_kind)],
            ['Category', val(row.category)],
            ['Gross weight', fmtWeight(row.gross_weight_kg)],
            ['POL → POD', `${val(row.pol)} → ${val(row.pod)}`],
            ['Final destination', val(row.destination)],
            ['Shipping line', val(row.shipping_line_code)],
            ['Vessel visit', row.vessel_visit ?? 'not stated on this list'],
            ['Voyage', val(row.voyage)],
            ['Bill of lading', val(row.bill_of_lading)],
            ['Seal', val(row.seal_no)],
            ['Nominated CFS', val(row.nominated_cfs)],
            ['Group code', val(row.group_code)],
            ['IEC', val(row.iec_code)],
            ['Commodity', val(row.commodity_code)],
          ])}

          {hazardClass(row.imdg_code) && (
            <>
              {section('Hazardous')}
              {facts([
                ['IMDG class', hazardClass(row.imdg_code) ?? '—'],
                ['UN number', val(row.un_number)],
              ])}
            </>
          )}

          {row.reefer_status && (
            <>
              {section('Reefer')}
              {facts([
                ['Status', val(row.reefer_status)],
                ['Set point', row.reefer_temp === null || row.reefer_temp === undefined ? '—' : `${row.reefer_temp} °C`],
              ])}
            </>
          )}

          {section('Gate-in (CODECO)')}
          {moves.loading ? (
            <CalciteLoader scale="s" label="Loading gate movements" />
          ) : gateIn ? (
            facts([
              ['Gate pass', val(gateIn.gate_pass_no)],
              ['Gate pass time', fmtTs(gateIn.gate_pass_ts)],
              ['Gate', val(gateIn.gate_no)],
              ['Vehicle', val(gateIn.vehicle_no)],
              ['VCN', val(gateIn.vcn)],
              ['Equipment status', val(gateIn.equipment_status)],
            ])
          ) : (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No CODECO gate message for this container</div>
              <div slot="message">
                Measured, not assumed: the 5 CODECO gate messages in this corpus share
                <strong> zero</strong> containers with the 5,743 load-list lines
                (04_Export_Build_Plan.md §2.5). So no container on this list resolves a
                gate-in — the document families are disjoint as supplied. This is the
                data, not a failed lookup.
              </div>
            </CalciteNotice>
          )}

          {/* E5: the row names a vessel visit, so say what that visit does and does
              not reach. Stating the empty join is the point — omitting it would let
              the dialog read as if the chain simply ended here. */}
          {section('Vessel')}
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="title">
              {row.vessel_visit
                ? `Visit ${row.vessel_visit} is not in the berthing reports or vessel calls`
                : 'This terminal’s list carries no vessel column'}
            </div>
            <div slot="message">
              {row.vessel_visit
                ? 'The export lists’ vessel visits appear in neither core.berthing_report_vessel '
                  + 'nor core.vessel_call, so this container cannot be tied to a cut-off or a '
                  + 'recorded sailing. The Cut-offs and Departures views show the vessel side on '
                  + 'its own terms.'
                : 'The BMCT list was supplied with no vessel column, so this line names no visit. '
                  + 'Nothing is guessed in its place.'}
            </div>
          </CalciteNotice>

          {/* Stated, not silently omitted — the customs step is the known gap. */}
          {section('Customs')}
          <CalciteNotice open kind="warning" icon="information" scale="s">
            <div slot="title">Shipping Bill and LEO cannot be linked to this container</div>
            <div slot="message">
              The filed Shipping Bills carry no container number, and the granted LEOs
              share no SB number with them, so neither can be attached to a box. The
              Customs tab shows both registers on their own terms.
            </div>
          </CalciteNotice>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
        </div>
      </div>
    </>
  );
}

/** One page of the load list. 5,743 rows do not belong in one fetch. */
const PAGE_SIZE = 500;

function ExportLoadList() {
  const { adapter } = useApp();
  const [terminal, setTerminal] = useState('ALL');
  // `search` is the field; `query` is what the fetch uses. Applied on Enter /
  // the Search button so the list does not refetch per keystroke.
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  // Bumped after a successful import so the list refetches with the new rows.
  const [rev, setRev] = useState(0);
  const [target, setTarget] = useState<AdvanceListContainer | null>(null);

  /**
   * ⚠ Search runs SERVER-SIDE (`q`), not over the loaded page.
   *
   * The register is 5,743 rows (verified against the deployed RDS) and this fetch
   * is one 500-row page. Filtering the page client-side made any container past
   * the first page report "Nothing to show" — indistinguishable from a data fault.
   *
   * ⚠ The backend's `q` matches container_no, bill_of_lading and
   * shipping_line_code ONLY. The field label says exactly that; widening it needs
   * the backend clause widened first.
   */
  const state = useAsync<{ items: AdvanceListContainer[]; total: number | null }>(
    () => (adapter.getAdvanceListPage
      ? adapter.getAdvanceListPage({
          list_type: 'EAL',
          terminal: terminal === 'ALL' ? undefined : terminal,
          q: query || undefined,
          limit: PAGE_SIZE,
        })
      : Promise.reject(new Error('The shipping-lines API is unavailable in this data mode.'))),
    [adapter, terminal, query, rev],
  );

  const rows = state.data?.items ?? [];
  const total = state.data?.total ?? null;
  // True when the register holds more than this page shows — the count line and
  // the notice below both depend on saying so rather than implying completeness.
  const truncated = total !== null && total > rows.length;
  const applySearch = () => setQuery(search.trim());

  // Terminal codes present on the EAL data, for the filter.
  const TERMINALS = ['ALL', 'GTI', 'NSIGT', 'NSFT', 'NSICT', 'BMCT'];

  return (
    <>
      <SourceBadge source="Shipping lines · EAL (export advance list to terminal)" live />

      {state.loading ? (
        <CalciteLoader scale="s" label="Loading export advance list" />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load the export advance list</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <CalciteLabel scale="s" style={{ minWidth: 150 }}>Terminal
              <CalciteSelect
                label="Terminal"
                scale="s"
                onCalciteSelectChange={(e) =>
                  setTerminal((e.target as unknown as { selectedOption?: { value?: string } })
                    .selectedOption?.value ?? 'ALL')}
              >
                {TERMINALS.map((tm) => (
                  <CalciteOption key={tm} value={tm} selected={terminal === tm}>{tm}</CalciteOption>
                ))}
              </CalciteSelect>
            </CalciteLabel>
            {/* Fields named here are exactly the ones `q` matches server-side
                (container_no / bill_of_lading / shipping_line_code). POD and
                vessel visit are NOT searchable — do not add them to this label
                without adding them to the backend's q clause first. */}
            <CalciteLabel scale="s" style={{ minWidth: 320 }}>Search (container / BL / shipping line)
              <div style={{ display: 'flex', gap: 6 }}>
                <CalciteInput
                  scale="s"
                  value={search}
                  placeholder="TEMU0412003"
                  onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
                />
                <CalciteButton scale="s" iconStart="search" onClick={applySearch}>Search</CalciteButton>
                {query && (
                  <CalciteButton
                    scale="s"
                    appearance="outline"
                    kind="neutral"
                    iconStart="x"
                    onClick={() => { setSearch(''); setQuery(''); }}
                  >
                    Clear
                  </CalciteButton>
                )}
              </div>
            </CalciteLabel>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={rows.map((r) => ({
                  'Container': r.container_no,
                  'Terminal': r.terminal,
                  'Vessel Visit': r.vessel_visit,
                  'ISO': r.iso_code,
                  'Freight Kind': r.freight_kind,
                  'Category': r.category,
                  'Gross Weight (kg)': r.gross_weight_kg,
                  'POL': r.pol,
                  'POD': r.pod,
                  'Shipping Line': r.shipping_line_code,
                  'BL': r.bill_of_lading,
                  'Seal': r.seal_no,
                  'IMDG': hazardClass(r.imdg_code) ?? '',
                  'Nominated CFS': r.nominated_cfs,
                }))}
                filename="export-advance-list.csv"
                importTarget={UPLOAD_TARGETS.eal}
                onImported={() => setRev((n) => n + 1)}
              />
            </div>
          </div>

          {/* The register size, not the page size. `total` comes from the API's
              Page envelope; showing rows.length alone reported 500 for a 5,743-row
              list. When the envelope is absent (bare array) fall back to the count
              we actually have rather than inventing one. */}
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
            {truncated
              ? <>Showing <strong>{rows.length}</strong> of <strong>{total!.toLocaleString()}</strong> lines declared for load</>
              : <>{(total ?? rows.length).toLocaleString()} line{(total ?? rows.length) === 1 ? '' : 's'} declared for load</>}
            {terminal !== 'ALL' ? ` at ${terminal}` : ''}
            {query ? ` matching “${query}”` : ''}
          </p>

          {/* ⚠ 03a §3.5: EAL_NSFT files 979 rows for 978 distinct containers and
              EAL_BMCT 588 for 587 — the source carries duplicate container rows.
              So this is a count of LINES, and the wording above says so. */}
          {truncated && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 0 8px', fontSize: 12, color: tokens.color.textMuted }}>
              One page of a larger register
              <InfoPopover label="One page of a larger register">
                <strong style={{ display: 'block', marginBottom: 4 }}>One page of a larger register</strong>
                This shows the first {PAGE_SIZE} of {total!.toLocaleString()} lines. Search runs
                against the whole register on the server, not just this page — so a container
                further down the list is still findable by number, bill of lading or shipping
                line. Counts here are advance-list <em>lines</em>; two terminals file a duplicate
                container row, so lines slightly exceed distinct containers.
              </InfoPopover>
            </div>
          )}

          {rows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">Nothing to show</div>
              <div slot="message">
                {query
                  ? `No export advance-list line matches “${query}”${terminal !== 'ALL' ? ` at ${terminal}` : ''}. This search covered the whole register, not just one page.`
                  : 'No export advance-list line matches the current filter.'}
              </div>
            </CalciteNotice>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="export advance list (EAL)">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Container" />
                  <CalciteTableHeader heading="Terminal" />
                  <CalciteTableHeader heading="Vessel visit" />
                  <CalciteTableHeader heading="ISO" />
                  <CalciteTableHeader heading="Kind" />
                  <CalciteTableHeader heading="Weight" />
                  <CalciteTableHeader heading="POD" />
                  <CalciteTableHeader heading="Line" />
                  <CalciteTableHeader heading="IMDG" />
                  <CalciteTableHeader heading="Chain" />
                </CalciteTableRow>
                {rows.map((r, i) => {
                  const hz = hazardClass(r.imdg_code);
                  return (
                    <CalciteTableRow key={`${r.container_no}-${i}`}>
                      <CalciteTableCell>
                        <strong>{val(r.container_no)}</strong>
                        {/* An ISO-6346 check-digit failure is a data-quality fact
                            worth showing, not something to hide. */}
                        {r.container_valid_iso === false && (
                          <CalciteChip scale="s" title="Container number fails the ISO 6346 check digit"
                            style={{ ['--calcite-chip-text-color' as never]: tokens.severity.WARN, marginLeft: 6 }}>
                            ISO?
                          </CalciteChip>
                        )}
                      </CalciteTableCell>
                      <CalciteTableCell>{val(r.terminal)}</CalciteTableCell>
                      <CalciteTableCell>
                        {r.vessel_visit ?? (
                          <span style={{ color: tokens.color.textMuted }} title="This terminal's list carries no vessel column">
                            not stated
                          </span>
                        )}
                      </CalciteTableCell>
                      <CalciteTableCell>{val(r.iso_code)}</CalciteTableCell>
                      <CalciteTableCell>{val(r.freight_kind)}</CalciteTableCell>
                      <CalciteTableCell>{fmtWeight(r.gross_weight_kg)}</CalciteTableCell>
                      <CalciteTableCell>{val(r.pod)}</CalciteTableCell>
                      <CalciteTableCell>{val(r.shipping_line_code)}</CalciteTableCell>
                      <CalciteTableCell>
                        {hz ? (
                          <CalciteChip scale="s" icon="exclamation-mark-triangle" value={hz}
                            title={`Declared IMDG class ${hz}${r.un_number ? ` · UN ${r.un_number}` : ''}`}
                            style={{ ['--calcite-chip-text-color' as never]: tokens.severity.WARN }}>
                            {hz}
                          </CalciteChip>
                        ) : '—'}
                      </CalciteTableCell>
                      <CalciteTableCell>
                        <CalciteButton
                          scale="s"
                          appearance="outline"
                          kind="brand"
                          iconStart="file-report"
                          title="Load-list line, gate-in and customs status for this container"
                          onClick={() => setTarget(r)}
                        >
                          Chain
                        </CalciteButton>
                      </CalciteTableCell>
                    </CalciteTableRow>
                  );
                })}
              </CalciteTable>
            </div>
          )}
        </>
      )}

      {target && <ExportChainDialog row={target} onClose={() => setTarget(null)} />}
    </>
  );
}

/**
 * Export documents — the customer's own gate paperwork, as filed.
 *
 * Steps 2–3 of the canonical export order: the Form 13 / e-gate pre-advice the
 * forwarder raises, and the EIR the terminal issues at the gate. 13 documents,
 * parsed verbatim from the shared corpus.
 *
 * ⚠ Sourced from `GET /api/gate-docs/documents`, NOT `/api/gate-docs/form13`.
 * The latter reads a store where 202 of 203 rows are seeded and carry synthetic
 * shipping-bill numbers; these 13 are the real documents. Anything shown as
 * evidence must come from this endpoint.
 *
 * The full as-filed payload is rendered from `attrs` rather than a fixed field
 * map, so every value the document actually carried is visible and nothing is
 * silently dropped by the view.
 */
function ExportDocuments() {
  const { adapter } = useApp();
  const [open, setOpen] = useState<SourceGateDocument | null>(null);

  const state = useAsync<SourceGateDocument[]>(
    () => (adapter.getSourceGateDocuments
      ? adapter.getSourceGateDocuments()
      : Promise.reject(new Error('The gate-document API is unavailable in this data mode.'))),
    [adapter],
  );

  const docs = state.data ?? [];
  const CATEGORY_LABEL: Record<string, string> = {
    FORM13: 'Form 13 / e-gate pre-advice',
    EIR: 'Equipment Interchange Report',
    PIN_TICKET: 'PIN pickup ticket',
  };

  return (
    <>
      <SourceBadge source="Terminal gate documents · parsed as filed" live />

      {state.loading ? (
        <CalciteLoader scale="s" label="Loading gate documents" />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load gate documents</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : docs.length === 0 ? (
        <CalciteNotice open kind="info" icon="information" scale="s">
          <div slot="title">No gate documents</div>
          <div slot="message">
            The parsed-document endpoint returned nothing. If the gateway has not been
            restarted since this endpoint was added, it will 404.
          </div>
        </CalciteNotice>
      ) : (
        <>
          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 6px' }}>
            {docs.length} documents as filed — Form 13, EIR and PIN tickets
          </p>
          <div style={{ overflowX: 'auto' }}>
            <CalciteTable caption="parsed source gate documents">
              <CalciteTableRow slot="table-header">
                <CalciteTableHeader heading="Document" />
                <CalciteTableHeader heading="Reference" />
                <CalciteTableHeader heading="Container" />
                <CalciteTableHeader heading="Vessel / visit" />
                <CalciteTableHeader heading="Truck" />
                <CalciteTableHeader heading="Transporter" />
                <CalciteTableHeader heading="As filed" />
              </CalciteTableRow>
              {docs.map((d) => (
                <CalciteTableRow key={d.doc_id}>
                  <CalciteTableCell>
                    <strong>{CATEGORY_LABEL[d.doc_category] ?? d.doc_category}</strong>
                    <div style={{ fontSize: 10.5, color: tokens.color.textMuted }}>{val(d.doc_variant)}</div>
                  </CalciteTableCell>
                  <CalciteTableCell>{val(d.doc_ref ?? d.pin_no)}</CalciteTableCell>
                  <CalciteTableCell>{val(d.container_no)}</CalciteTableCell>
                  <CalciteTableCell>
                    {val(d.vessel_name)}
                    {d.visit_id ? <div style={{ fontSize: 10.5, color: tokens.color.textMuted }}>{d.visit_id}</div> : null}
                  </CalciteTableCell>
                  <CalciteTableCell>{val(d.vehicle_no)}</CalciteTableCell>
                  <CalciteTableCell>{val(d.transporter_name)}</CalciteTableCell>
                  <CalciteTableCell>
                    <CalciteButton scale="s" appearance="outline" kind="brand" iconStart="documentation"
                      onClick={() => setOpen(d)}>
                      View
                    </CalciteButton>
                  </CalciteTableCell>
                </CalciteTableRow>
              ))}
            </CalciteTable>
          </div>
        </>
      )}

      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
          <div
            role="dialog"
            aria-label={`Gate document ${open.doc_ref ?? open.doc_id}`}
            style={{
              position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              width: 'min(820px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
              border: `1px solid ${tokens.color.border}`, borderRadius: 12,
              boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
              display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
              <CalciteIcon icon="documentation" scale="s" />
              <strong style={{ fontSize: 14 }}>{CATEGORY_LABEL[open.doc_category] ?? open.doc_category}</strong>
              <span style={{ fontSize: 12, opacity: 0.85 }}>{val(open.doc_ref ?? open.pin_no)} · {val(open.container_no)}</span>
              <button onClick={() => setOpen(null)} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
                <CalciteIcon icon="x" scale="s" />
              </button>
            </div>
            <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
              <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 10px' }}>
                Every field exactly as it appeared on the document. Values the document
                left blank are absent here rather than shown as empty.
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '6px 16px' }}>
                {Object.entries(open.attrs ?? {}).map(([k, v]) => (
                  <div key={k} style={{
                    background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
                    borderRadius: 6, padding: '8px 10px',
                  }}>
                    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: tokens.color.textMuted }}>{k}</div>
                    <strong style={{ fontSize: 12.5, color: tokens.color.text, wordBreak: 'break-word' }}>{String(v)}</strong>
                  </div>
                ))}
              </div>
              {/* The scanned original carries a FORM HISTORY custody chain that the
                  parser did not capture. Say so rather than implying this is all
                  the document contained. */}
              {open.doc_variant === 'form13_nsict_egate' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 12, color: tokens.color.textMuted }}>
                  The scanned original carries more than this
                  <InfoPopover label="The scanned original carries more than this">
                    <strong style={{ display: 'block', marginBottom: 4 }}>
                      The scanned original carries more than this
                    </strong>
                    This Form 13&apos;s printed copy shows a FORM HISTORY custody chain
                    (NSICT → UNF → the liner → the forwarder → the CFS → the transporter).
                    The parser did not capture it, so it is not shown here — it exists only
                    on the scanned image.
                  </InfoPopover>
                </div>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
              <CalciteButton scale="s" onClick={() => setOpen(null)}>Close</CalciteButton>
            </div>
          </div>
        </>
      )}
    </>
  );
}


type ExportView = (typeof EXPORT_VIEWS)[number];

/**
 * The export surface.
 *
 * The step strip on top is the spine: it states the canonical 10-step order and
 * which steps this corpus can actually evidence, and each step selects the view
 * that shows it. Without it the switch below reads as six unrelated document
 * families, and steps 1/4/5/6 look like omissions rather than documented gaps.
 *
 * ⚠ The views are ordered to follow the chain — pre-advice (2) → gate documents,
 * Form 11 (2, rail) → EAL (7) → COPRAR/COARRI (8–9) → departures (10). COPRAR and
 * COARRI are kept together because they are the two halves of one vessel's load;
 * Form 11 was split out of that group because it is step 2, not step 8.
 */
export function ExportList({ onOpenTab, jumpToView }: {
  onOpenTab?: (tab: string) => void;
  /** A guided-tour step asking for a specific sub-view. See Dashboard.goToTab. */
  jumpToView?: { view: string; nonce: number } | null;
} = {}) {
  const [view, setView] = useState<ExportView>('overview');

  // Keyed on the nonce so a repeat request for the same view still applies, and
  // so the user is not snapped back after navigating away mid-tour.
  useEffect(() => {
    if (jumpToView) setView(jumpToView.view as ExportView);
  }, [jumpToView?.nonce]);

  return (
    <>
      <LifecycleSteps
        steps={EXPORT_STEPS}
        title="Export container lifecycle — booking to vessel"
        activeView={view}
        onSelectView={(v) => setView(v as ExportView)}
        onOpenTab={onOpenTab}
        related={[SHARED_SURFACES.gate!, SHARED_SURFACES.cfsecy!, SHARED_SURFACES.rail!]}
      />
      {/* Only the views that are NOT a numbered step. Everything else is reached
          from the strip above, which is what keeps this tab in lifecycle order
          instead of listing document families. */}
      <div style={{ marginBottom: 10 }}>
        <CalciteSegmentedControl
          scale="s"
          onCalciteSegmentedControlChange={(e) =>
            setView((e.target as unknown as { selectedItem?: { value?: string } })
              .selectedItem?.value as ExportView)}
        >
          <CalciteSegmentedControlItem value="overview" checked={view === 'overview'}>
            Overview
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="form11" checked={view === 'form11'}>
            Form 11 (rail)
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="cutoffs" checked={view === 'cutoffs'}>
            Cut-offs
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="synthetic" checked={view === 'synthetic'}>
            ⚠ Synthetic chains
          </CalciteSegmentedControlItem>
        </CalciteSegmentedControl>
      </div>
      {view === 'overview' && <ExportOverview />}
      {view === 'list' && <ExportLoadList />}
      {view === 'docs' && <ExportDocuments />}
      {view === 'form11' && <ExportForm11 />}
      {view === 'sb' && <ShippingBills />}
      {view === 'leo' && <Leo />}
      {view === 'loadmsgs' && <ExportLoadMessages />}
      {view === 'cutoffs' && <ExportCutoffs />}
      {view === 'departures' && <ExportDepartures />}
      {view === 'synthetic' && <ExportSyntheticChains />}
    </>
  );
}

/** Landing view — what the export leg can and cannot evidence, in one place. */
function ExportOverview() {
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '8px 0 10px', fontSize: 12, color: tokens.color.textMuted }}>
        <SourceBadge source="Shipping lines · terminal gate documents · ICEGATE · EDI" live />
        Pick a step above to see the documents behind it
        <InfoPopover label="Pick a step above to see the documents behind it">
          <strong style={{ display: 'block', marginBottom: 4 }}>
            Pick a step above to see the documents behind it
          </strong>
          Nine of the ten canonical steps are backed by filed documents. The customs step is
          the one that cannot be closed: the Shipping Bills carry no container number and the
          LEOs share no SB number with them, so neither can be attached to a box. No real
          container in this corpus traverses the full chain — the ⚠ Synthetic chains view is
          the only place a complete ten-step sequence exists, and it is generated, not JNPA data.
        </InfoPopover>
      </div>
    </>
  );
}

/** Vessel departures — the final step (VESDEP). Real `atd` from core.vessel_call. */
function ExportDepartures() {
  const { adapter } = useApp();
  const state = useAsync<VesselDeparture[]>(
    () => (adapter.getVesselDepartures
      ? adapter.getVesselDepartures()
      : Promise.reject(new Error('The marine-calls API is unavailable in this data mode.'))),
    [adapter],
  );
  const rows = state.data ?? [];
  return (
    <>
      <SourceBadge source="PCS VESDEP → core.vessel_call (actual time of departure)" live />
      {state.loading ? <CalciteLoader scale="s" label="Loading departures" />
        : state.error ? (
          <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
            <div slot="title">Could not load departures</div><div slot="message">{state.error}</div>
          </CalciteNotice>
        ) : rows.length === 0 ? (
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="title">No departures recorded</div>
            <div slot="message">No vessel call carries an actual time of departure.</div>
          </CalciteNotice>
        ) : (
          <>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '8px 0 6px' }}>
              {rows.length} vessel call{rows.length === 1 ? '' : 's'} with a recorded sailing —
              the last step of the export chain
            </p>
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="vessel departures">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Vessel" />
                  <CalciteTableHeader heading="VIA" />
                  <CalciteTableHeader heading="VCN" />
                  <CalciteTableHeader heading="IMO" />
                  <CalciteTableHeader heading="Voyage" />
                  <CalciteTableHeader heading="Departed (ATD)" />
                  <CalciteTableHeader heading="Planned (ETD)" />
                </CalciteTableRow>
                {rows.map((d) => (
                  <CalciteTableRow key={`${d.vcn}-${d.call_id}`}>
                    <CalciteTableCell><strong>{val(d.vessel_name)}</strong></CalciteTableCell>
                    <CalciteTableCell>{val(d.via_no)}</CalciteTableCell>
                    <CalciteTableCell>{val(d.vcn)}</CalciteTableCell>
                    <CalciteTableCell>{val(d.imo_no)}</CalciteTableCell>
                    <CalciteTableCell>{val(d.voyage_no)}</CalciteTableCell>
                    <CalciteTableCell><strong>{fmtTs(d.atd)}</strong></CalciteTableCell>
                    <CalciteTableCell>{fmtTs(d.etd)}</CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          </>
        )}
    </>
  );
}

/** Shared section wrapper for the message views. */
const messageBlock = (title: string, note: React.ReactNode, body: React.ReactNode) => (
  <div style={{ marginBottom: 18 }}>
    <strong style={{ fontSize: 13, color: tokens.color.text }}>{title}</strong>
    <div style={{ margin: '6px 0 8px' }}>{note}</div>
    {body}
  </div>
);

/**
 * Step 2 (rail) — Form 11, the pre-advice a rail-origin export is declared on.
 *
 * Split out of the old combined "Form 11 · COPRAR · COARRI" view: Form 11 is the
 * pre-advice at the START of the chain, while COPRAR/COARRI are the load list and
 * load confirmation at the end. Showing them together implied they belong to the
 * same point in the order.
 */
function ExportForm11() {
  const { adapter } = useApp();
  const f11 = useAsync<Form11Entry[]>(
    () => (adapter.getForm11 ? adapter.getForm11() : Promise.resolve([])), [adapter]);
  const block = messageBlock;

  return (
    <>
      <SourceBadge source="Terminal Form 11 · rail export pre-advice" live />
      {block('Form 11 — rail pre-advice',
        <InfoPopover label="About the Form 11 rail pre-advice rows">
          Each source workbook holds exactly one row — these are the templates the
          terminals supplied, not a rake&apos;s full load. The <code>TRUCK_NO</code>,
          <code> DRIVER_TRAIN_ID</code> and <code>SHIPPING_BILL_NO</code> columns exist
          in the source but are empty in every one.
        </InfoPopover>,
        (f11.data ?? []).length === 0 ? <p style={{ fontSize: 12, color: tokens.color.textMuted }}>None loaded.</p> : (
          <div style={{ overflowX: 'auto' }}>
            <CalciteTable caption="Form 11 rail pre-advice">
              <CalciteTableRow slot="table-header">
                <CalciteTableHeader heading="Container" /><CalciteTableHeader heading="Visit" />
                <CalciteTableHeader heading="Booking" /><CalciteTableHeader heading="Origin" />
                <CalciteTableHeader heading="POD" /><CalciteTableHeader heading="VGM" />
                <CalciteTableHeader heading="Line seal" /><CalciteTableHeader heading="Terminal template" />
              </CalciteTableRow>
              {(f11.data ?? []).map((r) => (
                <CalciteTableRow key={r.form11_id}>
                  <CalciteTableCell><strong>{val(r.container_no)}</strong></CalciteTableCell>
                  <CalciteTableCell>{val(r.visit_no)}</CalciteTableCell>
                  <CalciteTableCell>{val(r.booking_no)}</CalciteTableCell>
                  <CalciteTableCell>{val(r.origin_port)} · {val(r.origin_type)}</CalciteTableCell>
                  <CalciteTableCell>{val(r.pod)}</CalciteTableCell>
                  <CalciteTableCell>{fmtWeight(r.vgm_kg)}</CalciteTableCell>
                  <CalciteTableCell>{val(r.line_seal)}</CalciteTableCell>
                  <CalciteTableCell>{val(r.template)}</CalciteTableCell>
                </CalciteTableRow>
              ))}
            </CalciteTable>
          </div>
        ))}
    </>
  );
}

/**
 * Steps 8–9 — COPRAR (the load list ordered to the terminal) and COARRI (the
 * confirmation of what was actually loaded). Kept together because they are the
 * two halves of one vessel's load; separated from Form 11 because that is step 2.
 *
 * ⚠ Both samples are foreign calls. The notices say so on every render — these
 * demonstrate the message schema and carry no JNPA volume.
 */
function ExportLoadMessages() {
  const { adapter } = useApp();
  const coprar = useAsync<CoprarItem[]>(
    () => (adapter.getCoprarItems ? adapter.getCoprarItems() : Promise.resolve([])), [adapter]);
  const coarri = useAsync<CoarriMove[]>(
    () => (adapter.getCoarriMoves ? adapter.getCoarriMoves() : Promise.resolve([])), [adapter]);
  const block = messageBlock;

  return (
    <>
      <SourceBadge source="EDI · COPRAR (load list) + COARRI (load confirmation)" live />

      <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s" style={{ margin: '4px 0 10px' }}>
        <div slot="title">Neither sample is a JNPA call</div>
        <div slot="message">
          These are the last two steps of the export chain, and the corpus holds no COPRAR or
          COARRI for any JNPA vessel. What is shown proves the message schema parses; it says
          nothing about JNPA traffic and must not be quoted as a volume. A JNPA COPRAR + COARRI
          for one call is an open ask.
        </div>
      </CalciteNotice>

      {block('COPRAR — advance load list (step 8)',
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Not a JNPA call</div>
          <div slot="message">
            The only COPRAR sample in the corpus is a Kolkata / Haldia call. It shows the
            message schema; it is not JNPA traffic and must not be read as such.
          </div>
        </CalciteNotice>,
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          {(coprar.data ?? []).length} container{(coprar.data ?? []).length === 1 ? '' : 's'} ordered for loading
          {(coprar.data ?? []).length > 0 && ` — e.g. ${coprar.data![0]!.container_no} → ${val(coprar.data![0]!.pod)}`}
        </p>)}

      {block('COARRI — load / discharge confirmation (step 9)',
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Not a JNPA call, and incomplete</div>
          <div slot="message">
            The only COARRI sample is Visakhapatnam. It also declares 1,107 containers but
            carries 200 items, of which 50 were lost — the 4th message is truncated at
            Excel&apos;s 32,767-character cell limit, so {(coarri.data ?? []).length} rows landed.
          </div>
        </CalciteNotice>,
        <p style={{ fontSize: 12, color: tokens.color.textMuted }}>
          {(coarri.data ?? []).length} confirmed move{(coarri.data ?? []).length === 1 ? '' : 's'}
          {(coarri.data ?? []).filter((m) => m.damage_flag && m.damage_flag !== 'N').length > 0
            && ` · ${(coarri.data ?? []).filter((m) => m.damage_flag && m.damage_flag !== 'N').length} with a damage flag`}
        </p>)}
    </>
  );
}

/**
 * ⚠⚠ SYNTHETIC end-to-end chains.
 *
 * The ONLY place in this dashboard where a single container traverses all ten
 * canonical export steps — because no real container in the corpus does. The
 * document families are disjoint by design.
 *
 * Every visual affordance here exists to stop this being mistaken for real data:
 * a permanent banner, a striped header, a per-row SYNTHETIC chip, and the SYNU
 * prefix (not an allocated BIC owner code). The adapter additionally refuses to
 * return anything the backend has not stamped `synthetic: true`.
 *
 * The one real thing is the final step: each chain ends on the actual departure
 * of a real vessel call, so that link is verifiable against customer data.
 */
function ExportSyntheticChains() {
  const { adapter } = useApp();
  const [open, setOpen] = useState<SyntheticChain | null>(null);
  const state = useAsync<SyntheticChain[]>(
    () => (adapter.getSyntheticChains
      ? adapter.getSyntheticChains()
      : Promise.reject(new Error('The export-chain API is unavailable in this data mode.'))),
    [adapter],
  );
  const rows = state.data ?? [];

  const BANNER = (
    <div
      style={{
        border: `2px solid ${tokens.severity.WARN}`, borderRadius: tokens.radius.md,
        background: 'repeating-linear-gradient(45deg, rgba(242,169,59,0.10) 0 10px, transparent 10px 20px)',
        padding: '10px 12px', margin: '4px 0 12px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <CalciteIcon icon="exclamation-mark-triangle" scale="s" />
        <strong style={{ fontSize: 13, color: tokens.color.text }}>
          SYNTHETIC — generated demo data, not JNPA data
        </strong>
      </div>
      <div style={{ fontSize: 12, color: tokens.color.textMuted, marginTop: 4 }}>
        No real container in the corpus traverses the full export lifecycle, so these
        chains were generated to show it end to end. Container numbers use the
        prefix <strong>SYNU</strong>, which is not an allocated BIC owner code, so they
        cannot be confused with a real box. Do not quote these figures as JNPA volumes.
        <br />
        <strong style={{ color: tokens.color.text }}>The one real value:</strong> each
        chain&apos;s final step is the actual departure of a real vessel call.
      </div>
    </div>
  );

  return (
    <>
      {BANNER}
      {state.loading ? <CalciteLoader scale="s" label="Loading chains" />
        : state.error ? (
          <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
            <div slot="title">Could not load synthetic chains</div><div slot="message">{state.error}</div>
          </CalciteNotice>
        ) : rows.length === 0 ? (
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="message">
              No synthetic chains. If the gateway has not been restarted since this
              endpoint was added, it will 404.
            </div>
          </CalciteNotice>
        ) : (
          <>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
              {rows.length} generated chains · 10 steps each · ending on a real vessel departure
            </p>
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="synthetic export chains">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Container" />
                  <CalciteTableHeader heading="Booking" />
                  <CalciteTableHeader heading="POD" />
                  <CalciteTableHeader heading="Shipping Bill" />
                  <CalciteTableHeader heading="LEO" />
                  <CalciteTableHeader heading="Vessel (real)" />
                  <CalciteTableHeader heading="Departed (real)" />
                  <CalciteTableHeader heading="Chain" />
                </CalciteTableRow>
                {rows.map((r) => (
                  <CalciteTableRow key={r.container_no}>
                    <CalciteTableCell>
                      <strong>{val(r.container_no)}</strong>
                      <CalciteChip scale="s" value="SYNTHETIC"
                        style={{ ['--calcite-chip-text-color' as never]: tokens.severity.WARN, marginLeft: 6 }}>
                        SYNTHETIC
                      </CalciteChip>
                    </CalciteTableCell>
                    <CalciteTableCell>{val(r.booking_no)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.pod)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.shipping_bill_no)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.leo_no)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.vessel_name)}</CalciteTableCell>
                    <CalciteTableCell>{fmtTs(r.departed_at)}</CalciteTableCell>
                    <CalciteTableCell>
                      <CalciteButton scale="s" appearance="outline" iconStart="list"
                        onClick={() => setOpen(r)}>10 steps</CalciteButton>
                    </CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          </>
        )}

      {open && (
        <>
          <div onClick={() => setOpen(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
          <div role="dialog" aria-label={`Synthetic export chain for ${open.container_no}`}
            style={{
              position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
              width: 'min(760px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
              border: `2px solid ${tokens.severity.WARN}`, borderRadius: 12,
              boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
              display: 'flex', flexDirection: 'column',
            }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.severity.WARN, color: '#1b1f27', borderRadius: '10px 10px 0 0' }}>
              <CalciteIcon icon="exclamation-mark-triangle" scale="s" />
              <strong style={{ fontSize: 14 }}>SYNTHETIC chain · {val(open.container_no)}</strong>
              <button onClick={() => setOpen(null)} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}>
                <CalciteIcon icon="x" scale="s" />
              </button>
            </div>
            <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
              <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 10px' }}>
                Generated data. The final step (VESDEP) is the one real value — it is the
                actual departure of {val(open.vessel_name)} ({val(open.vcn)}).
              </p>
              {(open.steps ?? []).map((s) => {
                const isReal = s.step_code === 'VESDEP';
                return (
                  <div key={s.step_no} style={{
                    display: 'flex', gap: 10, alignItems: 'baseline', padding: '7px 0',
                    borderBottom: `1px solid ${tokens.color.border}`,
                  }}>
                    <span style={{ minWidth: 22, fontWeight: 700, color: tokens.color.textMuted }}>{s.step_no}</span>
                    <div style={{ flex: 1 }}>
                      <strong style={{ fontSize: 12.5, color: tokens.color.text }}>{s.step_label}</strong>
                      {s.doc_ref && <span style={{ fontSize: 11.5, color: tokens.color.textMuted }}> · {s.doc_ref}</span>}
                    </div>
                    <span style={{ fontSize: 12, color: tokens.color.textMuted, whiteSpace: 'nowrap' }}>{fmtTs(s.event_ts)}</span>
                    {isReal && (
                      <CalciteChip scale="s" value="REAL"
                        style={{ ['--calcite-chip-text-color' as never]: tokens.congestion.GREEN }}>
                        real
                      </CalciteChip>
                    )}
                  </div>
                );
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end', padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
              <CalciteButton scale="s" onClick={() => setOpen(null)}>Close</CalciteButton>
            </div>
          </div>
        </>
      )}
    </>
  );
}

/**
 * Cut-offs (WS1 EC-1) — the vessel gate window: gate open → dry cut-off → reefer.
 *
 * ⚠ THIS IS THE VESSEL HALF OF EC-1, NOT THE CONTAINER HALF.
 *
 * EC-1 as specified produces a per-container shutout-risk list ("predicted scan
 * completion vs vessel cut-off"). That is NOT derivable from this corpus: no
 * container reaches a vessel that has a cut-off. All three join paths are empty —
 * EAL visit → berthing via (0), synthetic chain → vessel_call → cut-off (0),
 * CODECO export gate-in → vessel_call → cut-off (0). The export lists' visits
 * (KMIS0276, S0071, KMIR3458, KMRA/R3494) exist in neither berthing nor
 * vessel_call.
 *
 * So this shows the real, usable half — the deadlines themselves — and says
 * plainly what cannot be computed. Do not add a "boxes at risk" column.
 */
function ExportCutoffs() {
  const { adapter } = useApp();
  const state = useAsync<VesselCutoff[]>(
    () => (adapter.getVesselCutoffs
      ? adapter.getVesselCutoffs()
      : Promise.reject(new Error('The export-chain API is unavailable in this data mode.'))),
    [adapter],
  );
  const rows = state.data ?? [];
  const withCutoff = rows.filter((r) => r.cutoff_dry_ts);

  /** Gate window in hours, when both ends are known. */
  const windowH = (r: VesselCutoff): number | null => {
    if (!r.gate_open_ts || !r.cutoff_dry_ts) return null;
    const h = (Date.parse(r.cutoff_dry_ts) - Date.parse(r.gate_open_ts)) / 3_600_000;
    return Number.isFinite(h) ? h : null;
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '4px 0 10px', fontSize: 12, color: tokens.color.textMuted }}>
        <SourceBadge source="Terminal berthing reports · VESSELS EXPECTED gate window" live />
        Vessel cut-offs — the deadline, not the at-risk list
        <InfoPopover label="Vessel cut-offs — the deadline, not the at-risk list">
          <strong style={{ display: 'block', marginBottom: 4 }}>
            Vessel cut-offs — the deadline, not the at-risk list
          </strong>
          These are the gate windows the terminals publish. The per-container shutout-risk
          list EC-1 describes cannot be computed from this dataset: the export advance
          lists&apos; vessel visits appear in neither the berthing reports nor the vessel
          calls, so no container can be tied to a cut-off. Only NSICT and NSIGT publish
          these times.
        </InfoPopover>
      </div>

      {state.loading ? <CalciteLoader scale="s" label="Loading cut-offs" />
        : state.error ? (
          <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
            <div slot="title">Could not load cut-offs</div><div slot="message">{state.error}</div>
          </CalciteNotice>
        ) : rows.length === 0 ? (
          <CalciteNotice open kind="info" icon="information" scale="s">
            <div slot="message">
              No gate windows recorded. If the gateway has not been restarted since this
              endpoint was added, it will 404.
            </div>
          </CalciteNotice>
        ) : (
          <>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
              {rows.length} vessel call{rows.length === 1 ? '' : 's'} with a gate window ·
              {' '}{withCutoff.length} carry a dry cut-off
            </p>
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="vessel gate-open and cut-off windows">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Vessel" />
                  <CalciteTableHeader heading="VIA" />
                  <CalciteTableHeader heading="Terminal" />
                  <CalciteTableHeader heading="Gate open" />
                  <CalciteTableHeader heading="Cut-off (dry)" />
                  <CalciteTableHeader heading="Cut-off (reefer)" />
                  <CalciteTableHeader heading="Gate window" />
                </CalciteTableRow>
                {rows.map((r) => {
                  const w = windowH(r);
                  // A window of zero or less is what the terminal printed, not a
                  // parse error — one June row genuinely shows cut-off = gate open.
                  const odd = w !== null && w <= 0;
                  return (
                    <CalciteTableRow key={r.id}>
                      <CalciteTableCell><strong>{val(r.vessel_name)}</strong></CalciteTableCell>
                      <CalciteTableCell>{val(r.via_no)}</CalciteTableCell>
                      <CalciteTableCell>{val(r.terminal_code)}</CalciteTableCell>
                      <CalciteTableCell>{fmtTs(r.gate_open_ts)}</CalciteTableCell>
                      <CalciteTableCell>
                        {r.cutoff_dry_ts
                          ? <strong>{fmtTs(r.cutoff_dry_ts)}</strong>
                          : <span style={{ color: tokens.color.textMuted }}>not published</span>}
                      </CalciteTableCell>
                      <CalciteTableCell>{fmtTs(r.cutoff_reefer_ts)}</CalciteTableCell>
                      <CalciteTableCell>
                        {w === null ? '—' : (
                          <span
                            style={{ color: odd ? tokens.severity.WARN : tokens.color.text, fontWeight: 600 }}
                            title={odd ? 'The report prints the cut-off equal to gate open — as published' : undefined}
                          >
                            {w.toFixed(0)} h{odd ? ' ⚠' : ''}
                          </span>
                        )}
                      </CalciteTableCell>
                    </CalciteTableRow>
                  );
                })}
              </CalciteTable>
            </div>
          </>
        )}
    </>
  );
}
