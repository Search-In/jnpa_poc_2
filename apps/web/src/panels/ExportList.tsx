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
 * ⚠ TWO THINGS THIS PANEL MUST NOT IMPLY.
 * 1. There is no Shipping Bill / LEO column, and there must not be one until
 *    customs supply an SB extract carrying a container number. The filed SBs
 *    have no container column at all, so such a column would render empty on
 *    every one of the 5,743 rows. See markdowns/04_Export_Build_Plan.md §3.2.
 * 2. The BMCT list carries no vessel column — `vessel_visit` is null on all 588
 *    of its rows because that is how the file was supplied. Those rows show
 *    "not stated", never a guessed visit.
 */
import { useMemo, useState } from 'react';
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
                The corpus holds 5 CODECO gate messages against 5,743 load-list lines, so
                most containers on this list have no matching gate event. This is the
                supplied data, not a failed lookup.
              </div>
            </CalciteNotice>
          )}

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

function ExportLoadList() {
  const { adapter } = useApp();
  const [terminal, setTerminal] = useState('ALL');
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<AdvanceListContainer | null>(null);

  const state = useAsync<AdvanceListContainer[]>(
    () => (adapter.getAdvanceList
      ? adapter.getAdvanceList({
          list_type: 'EAL',
          terminal: terminal === 'ALL' ? undefined : terminal,
          limit: 500,
        })
      : Promise.reject(new Error('The shipping-lines API is unavailable in this data mode.'))),
    [adapter, terminal],
  );

  const rows = useMemo(() => {
    const all = state.data ?? [];
    const q = search.trim().toUpperCase();
    if (!q) return all;
    return all.filter((r) =>
      r.container_no?.toUpperCase().includes(q)
      || (r.pod ?? '').toUpperCase().includes(q)
      || (r.shipping_line_code ?? '').toUpperCase().includes(q)
      || (r.bill_of_lading ?? '').toUpperCase().includes(q)
      || (r.vessel_visit ?? '').toUpperCase().includes(q));
  }, [state.data, search]);

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
            <CalciteLabel scale="s" style={{ minWidth: 260 }}>Search (container / POD / line / BL / visit)
              <CalciteInput
                scale="s"
                value={search}
                placeholder="TEMU0412003"
                onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
              />
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
              />
            </div>
          </div>

          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
            {rows.length} container{rows.length === 1 ? '' : 's'} declared for load
            {terminal !== 'ALL' ? ` at ${terminal}` : ''}
          </p>

          {rows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">Nothing to show</div>
              <div slot="message">No export advance-list line matches the current filter.</div>
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
                <CalciteNotice open kind="info" icon="information" scale="s" style={{ marginTop: 12 }}>
                  <div slot="title">The scanned original carries more than this</div>
                  <div slot="message">
                    This Form 13&apos;s printed copy shows a FORM HISTORY custody chain
                    (NSICT → UNF → the liner → the forwarder → the CFS → the transporter).
                    The parser did not capture it, so it is not shown here — it exists only
                    on the scanned image.
                  </div>
                </CalciteNotice>
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


type ExportView = 'list' | 'docs' | 'messages' | 'cutoffs' | 'departures' | 'synthetic';

/**
 * The export surface: the load list at population scale, and the gate documents
 * behind it. Split by a switch rather than two tabs — they are two views of one
 * step in the chain, not two places to go.
 */
export function ExportList() {
  const [view, setView] = useState<ExportView>('list');
  return (
    <>
      <div style={{ marginBottom: 10 }}>
        <CalciteSegmentedControl
          scale="s"
          onCalciteSegmentedControlChange={(e) =>
            setView((e.target as unknown as { selectedItem?: { value?: string } })
              .selectedItem?.value as ExportView)}
        >
          <CalciteSegmentedControlItem value="list" checked={view === 'list'}>
            Load list (EAL)
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="docs" checked={view === 'docs'}>
            Gate documents
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="messages" checked={view === 'messages'}>
            Form 11 · COPRAR · COARRI
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="cutoffs" checked={view === 'cutoffs'}>
            Cut-offs
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="departures" checked={view === 'departures'}>
            Departures
          </CalciteSegmentedControlItem>
          <CalciteSegmentedControlItem value="synthetic" checked={view === 'synthetic'}>
            ⚠ Synthetic chains
          </CalciteSegmentedControlItem>
        </CalciteSegmentedControl>
      </div>
      {view === 'list' && <ExportLoadList />}
      {view === 'docs' && <ExportDocuments />}
      {view === 'messages' && <ExportMessages />}
      {view === 'cutoffs' && <ExportCutoffs />}
      {view === 'departures' && <ExportDepartures />}
      {view === 'synthetic' && <ExportSyntheticChains />}
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

/** Form 11 (rail pre-advice) + COPRAR + COARRI — the remaining real steps. */
function ExportMessages() {
  const { adapter } = useApp();
  const f11 = useAsync<Form11Entry[]>(
    () => (adapter.getForm11 ? adapter.getForm11() : Promise.resolve([])), [adapter]);
  const coprar = useAsync<CoprarItem[]>(
    () => (adapter.getCoprarItems ? adapter.getCoprarItems() : Promise.resolve([])), [adapter]);
  const coarri = useAsync<CoarriMove[]>(
    () => (adapter.getCoarriMoves ? adapter.getCoarriMoves() : Promise.resolve([])), [adapter]);

  const block = (title: string, note: React.ReactNode, body: React.ReactNode) => (
    <div style={{ marginBottom: 18 }}>
      <strong style={{ fontSize: 13, color: tokens.color.text }}>{title}</strong>
      <div style={{ margin: '6px 0 8px' }}>{note}</div>
      {body}
    </div>
  );

  return (
    <>
      {block('Form 11 — rail pre-advice',
        <CalciteNotice open kind="info" icon="information" scale="s">
          <div slot="message">
            Each source workbook holds exactly one row — these are the templates the
            terminals supplied, not a rake&apos;s full load. The <code>TRUCK_NO</code>,
            <code> DRIVER_TRAIN_ID</code> and <code>SHIPPING_BILL_NO</code> columns exist
            in the source but are empty in every one.
          </div>
        </CalciteNotice>,
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

      {block('COPRAR — advance load list',
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

      {block('COARRI — load / discharge confirmation',
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
      <SourceBadge source="Terminal berthing reports · VESSELS EXPECTED gate window" live />

      <CalciteNotice open kind="info" icon="information" scale="s" style={{ margin: '4px 0 10px' }}>
        <div slot="title">Vessel cut-offs — the deadline, not the at-risk list</div>
        <div slot="message">
          These are the gate windows the terminals publish. The per-container shutout-risk
          list EC-1 describes cannot be computed from this dataset: the export advance
          lists&apos; vessel visits appear in neither the berthing reports nor the vessel
          calls, so no container can be tied to a cut-off. Only NSICT and NSIGT publish
          these times.
        </div>
      </CalciteNotice>

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
