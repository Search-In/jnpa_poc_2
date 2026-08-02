/**
 * OOC — Out-Of-Charge / Bill of Entry (ICEGATE CHPOI10).
 *
 * The customs-clearance step of the import lifecycle (see
 * markdowns/02_Import_Container_Lifecycle.md, Hero B): customs assesses the Bill
 * of Entry and grants an out-of-charge, which releases the cargo for delivery.
 * Shown inside the Scan tab because clearance and scanning are the two customs
 * gates a container passes before it can leave.
 *
 * Data source (POC-3 customs layer, parsed from the official CHPOI10 XML):
 *   GET /api/customs/ooc              -> the Bills of Entry (this list)
 *   GET /api/customs/ooc/{be}/items   -> one BE + containers + invoice items
 * Every value is as filed; blanks render as "—" rather than being invented.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteButton, CalciteChip, CalciteIcon, CalciteNotice, CalciteLoader,
  CalciteInput, CalciteLabel,
} from '@esri/calcite-components-react';
import type { OocDetail, OocRecord } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { tokens } from '../theme/tokens.js';

const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
};

/** Money/quantity arrive as decimal STRINGS (Postgres numeric) — coerce first. */
function fmtNum(v?: number | string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * OOC detail popup for one Bill of Entry — the four things the clearance step is
 * judged on: the BE, the importer, the out-of-charge grant, and the invoice items.
 */
function OocDetailDialog({ record, onClose }: { record: OocRecord; onClose: () => void }) {
  const { adapter } = useApp();
  const beNo = record.bill_of_entry_no;
  const detail = useAsync<OocDetail | null>(
    () => (adapter.getOocDetail
      ? adapter.getOocDetail(beNo)
      : Promise.reject(new Error('The customs API is unavailable in this data mode.'))),
    [adapter, beNo],
  );
  const d = detail.data;
  const head = d?.ooc ?? record;
  const items = d?.items ?? [];

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
        aria-label={`Out-of-charge detail for Bill of Entry ${beNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(900px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="check-circle" scale="s" />
          <strong style={{ fontSize: 14 }}>Out-of-Charge · BE {val(beNo)}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{val(head.importer_name)}</span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {detail.loading ? (
            <CalciteLoader scale="s" label="Loading out-of-charge detail" />
          ) : detail.error ? (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not load out-of-charge detail</div>
              <div slot="message">{detail.error}</div>
            </CalciteNotice>
          ) : (
            <>
              {section('Bill of Entry')}
              {facts([
                ['BE number', val(head.bill_of_entry_no)],
                ['BE date', fmtDate(head.bill_of_entry_date)],
                ['Document type', val(head.document_type)],
                ['IGM / line', `${val(head.igm_no)} / ${val(head.line_no)}`],
                ['Country of origin', val(head.country_of_origin)],
                ['Packages', fmtNum(head.no_of_packages)],
                ['Quantity', `${fmtNum(head.quantity_out_of_charged)} ${head.unit_of_quantity ?? ''}`.trim()],
              ])}

              {section('Importer')}
              {facts([
                ['Importer', val(head.importer_name)],
                ['IE code', val(head.ie_code)],
                ['CHA code', val(head.cha_code)],
                ['City', val(d?.ooc?.importer_city)],
                ['PIN', val(d?.ooc?.pin_code)],
              ])}

              {section('Out-of-Charge')}
              {facts([
                ['OOC number', val(head.out_of_charge_no)],
                ['OOC date', fmtDate(head.out_of_charge_date)],
                ['Assessable value', fmtNum(head.assessable_value)],
                ['CIF value', fmtNum(head.cif_value)],
                ['Customs duty paid', fmtNum(head.total_customs_duty)],
                ['Containers', (d?.containers ?? []).join(', ') || '—'],
              ])}

              {section(`Invoice items (${items.length})`)}
              {items.length === 0 ? (
                <CalciteNotice open kind="info" icon="information" scale="s">
                  <div slot="message">No invoice line items are recorded on this Bill of Entry.</div>
                </CalciteNotice>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <CalciteTable caption={`invoice items on BE ${beNo}`}>
                    <CalciteTableRow slot="table-header">
                      <CalciteTableHeader heading="#" />
                      <CalciteTableHeader heading="Invoice" />
                      <CalciteTableHeader heading="Description" />
                      <CalciteTableHeader heading="HS code" />
                      <CalciteTableHeader heading="Container" />
                      <CalciteTableHeader heading="CIF value" />
                      <CalciteTableHeader heading="Assessable value" />
                    </CalciteTableRow>
                    {items.map((it, i) => (
                      <CalciteTableRow key={`${it.container_no}-${it.invoice_number}-${it.item_sr_no}-${i}`}>
                        <CalciteTableCell>{val(it.item_sr_no)}</CalciteTableCell>
                        <CalciteTableCell>{val(it.invoice_number)}</CalciteTableCell>
                        <CalciteTableCell title={it.item_description ?? undefined}>
                          <span style={{ display: 'inline-block', maxWidth: 300, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                            {val(it.item_description)}
                          </span>
                        </CalciteTableCell>
                        <CalciteTableCell>{val(it.hs_classification)}</CalciteTableCell>
                        <CalciteTableCell>{val(it.container_no)}</CalciteTableCell>
                        <CalciteTableCell>{fmtNum(it.cif_value)}</CalciteTableCell>
                        <CalciteTableCell>{fmtNum(it.assessable_value)}</CalciteTableCell>
                      </CalciteTableRow>
                    ))}
                  </CalciteTable>
                </div>
              )}
            </>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, padding: '10px 14px', borderTop: `1px solid ${tokens.color.border}` }}>
          <CalciteButton scale="s" onClick={onClose}>Close</CalciteButton>
        </div>
      </div>
    </>
  );
}

/** The OOC list — one row per Bill of Entry, each opening the detail popup. */
export function OocPanel() {
  const { adapter } = useApp();
  const [target, setTarget] = useState<OocRecord | null>(null);
  const [search, setSearch] = useState('');

  const state = useAsync<OocRecord[]>(
    () => (adapter.getOocRecords
      ? adapter.getOocRecords()
      : Promise.reject(new Error('The customs API is unavailable in this data mode.'))),
    [adapter],
  );

  const q = search.trim().toUpperCase();
  const rows = (state.data ?? []).filter((r) =>
    !q ||
    String(r.bill_of_entry_no).includes(q) ||
    String(r.out_of_charge_no ?? '').includes(q) ||
    r.importer_name?.toUpperCase().includes(q) ||
    String(r.igm_no ?? '').includes(q));

  return (
    <>
      <SourceBadge source="ICEGATE · CHPOI10 (Out-Of-Charge / Bill of Entry)" live />

      {state.loading ? (
        <CalciteLoader scale="s" label="Loading bills of entry" />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load out-of-charge records</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <CalciteLabel scale="s" style={{ minWidth: 250 }}>Search (BE / OOC / importer / IGM)
              <CalciteInput
                scale="s"
                value={search}
                placeholder="9259230"
                onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
              />
            </CalciteLabel>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={rows.map((r) => ({
                  'BE No': r.bill_of_entry_no,
                  'BE Date': r.bill_of_entry_date,
                  'IGM No': r.igm_no,
                  'Line No': r.line_no,
                  'Importer': r.importer_name,
                  'IE Code': r.ie_code,
                  'CHA Code': r.cha_code,
                  'OOC No': r.out_of_charge_no,
                  'OOC Date': r.out_of_charge_date,
                  'Country of Origin': r.country_of_origin,
                  'Packages': r.no_of_packages,
                  'Assessable Value': r.assessable_value,
                  'Customs Duty': r.total_customs_duty,
                  'Containers': r.container_count,
                }))}
                filename="ooc-bills-of-entry.csv"
              />
            </div>
          </div>

          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
            {rows.length} bill{rows.length === 1 ? '' : 's'} of entry cleared
          </p>

          {rows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No bills of entry</div>
              <div slot="message">No out-of-charge record matches the current search.</div>
            </CalciteNotice>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="bills of entry with out-of-charge">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="BE No" />
                  <CalciteTableHeader heading="BE date" />
                  <CalciteTableHeader heading="Importer" />
                  <CalciteTableHeader heading="OOC No" />
                  <CalciteTableHeader heading="OOC date" />
                  <CalciteTableHeader heading="IGM / line" />
                  <CalciteTableHeader heading="Origin" />
                  <CalciteTableHeader heading="Duty" />
                  <CalciteTableHeader heading="Detail" />
                </CalciteTableRow>
                {rows.map((r) => (
                  <CalciteTableRow key={String(r.bill_of_entry_no)}>
                    <CalciteTableCell><strong>{val(r.bill_of_entry_no)}</strong></CalciteTableCell>
                    <CalciteTableCell>{fmtDate(r.bill_of_entry_date)}</CalciteTableCell>
                    <CalciteTableCell title={r.importer_name ?? undefined}>
                      <span style={{ display: 'inline-block', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                        {val(r.importer_name)}
                      </span>
                    </CalciteTableCell>
                    <CalciteTableCell>
                      {r.out_of_charge_no
                        ? <CalciteChip scale="s" value={r.out_of_charge_no} style={{ ['--calcite-chip-text-color' as never]: tokens.congestion.GREEN }}>{r.out_of_charge_no}</CalciteChip>
                        : '—'}
                    </CalciteTableCell>
                    <CalciteTableCell>{fmtDate(r.out_of_charge_date)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.igm_no)} / {val(r.line_no)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.country_of_origin)}</CalciteTableCell>
                    <CalciteTableCell>{fmtNum(r.total_customs_duty)}</CalciteTableCell>
                    <CalciteTableCell>
                      <CalciteButton
                        scale="s"
                        appearance="outline"
                        kind="brand"
                        iconStart="file-report"
                        title="BE, importer, out-of-charge and invoice items"
                        onClick={() => setTarget(r)}
                      >
                        OOC
                      </CalciteButton>
                    </CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          )}
        </>
      )}

      {target && <OocDetailDialog record={target} onClose={() => setTarget(null)} />}
    </>
  );
}
