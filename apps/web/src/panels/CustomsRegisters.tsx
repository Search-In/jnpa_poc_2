/**
 * The three customs registers that are NOT the import manifest — Shipping Bill,
 * LEO and SMTP — each rendered on its own terms.
 *
 * Extracted from the former `CustomsDocs` tab, which wrapped four registers
 * belonging to three different legs behind one switch. They now sit at their
 * actual lifecycle position:
 *   Shipping Bill -> Export step 5      (ExportList)
 *   LEO           -> Export step 6      (ExportList)
 *   SMTP          -> transhipment branch (ImportList)
 * IGM went to ImportList step 1 as `Igm` itself.
 *
 * Data source (POC-3 customs layer, parsed from the filed documents):
 *   GET /api/customs/shipping-bills  -> export declarations
 *   GET /api/customs/leo             -> Let Export Orders
 *   GET /api/customs/smtp            -> Sub-Manifest Transhipment Permits (CHPOI13)
 *
 * ⚠ SHIPPING BILL AND LEO DO NOT JOIN — see the notice rendered on the LEO view.
 * The two sets share no `sb_no` in this dataset. They are shown as two separate
 * document registers, never as one document's status, and nothing here joins them.
 * Being adjacent inside the Export tab does NOT change that; the notice stays.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteNotice, CalciteLoader, CalciteInput, CalciteLabel, CalciteChip,
} from '@esri/calcite-components-react';
import type { LeoRecord, ShippingBillRecord, SmtpRecord } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { UPLOAD_TARGETS } from './uploadTargets.js';
import { SourceBadge } from './SourceBadge.js';
import { tokens } from '../theme/tokens.js';

const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

const fmtDate = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
};

/** Shared empty/error/loading shell so the three registers read identically. */
function Register<T>({
  state, source, caption, search, setSearch, searchLabel, placeholder,
  exportRows, exportName, notice, columns, row, keyOf, emptyMessage,
}: {
  state: { data?: T[]; loading: boolean; error?: string | null };
  source: string;
  caption: string;
  search: string;
  setSearch: (v: string) => void;
  searchLabel: string;
  placeholder: string;
  exportRows: (rows: T[]) => Array<Record<string, unknown>>;
  exportName: string;
  notice?: React.ReactNode;
  columns: string[];
  row: (r: T) => React.ReactNode;
  keyOf: (r: T, i: number) => string;
  emptyMessage: string;
}) {
  const rows = state.data ?? [];
  return (
    <>
      <SourceBadge source={source} live />
      {notice}
      {state.loading ? (
        <CalciteLoader scale="s" label={`Loading ${caption}`} />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load {caption}</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <CalciteLabel scale="s" style={{ minWidth: 250 }}>{searchLabel}
              <CalciteInput
                scale="s"
                value={search}
                placeholder={placeholder}
                onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
              />
            </CalciteLabel>
            <div style={{ marginLeft: 'auto' }}>
              {/* Customs ingest (UC2-036). One target serves every register here:
                  the server identifies IGM / OOC / SMTP / RMS / LEO / SB from the
                  filename, so the operator picks a file rather than declaring a
                  type — and picking the wrong tab cannot mis-file a document. */}
              <ImportExportToolbar
                data={exportRows(rows)}
                filename={exportName}
                importTarget={UPLOAD_TARGETS.customs}
                onImported={() => window.location.reload()}
              />
            </div>
          </div>

          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
            {rows.length} {caption}
          </p>

          {rows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">Nothing to show</div>
              <div slot="message">{emptyMessage}</div>
            </CalciteNotice>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption={caption}>
                <CalciteTableRow slot="table-header">
                  {columns.map((c) => <CalciteTableHeader key={c} heading={c} />)}
                </CalciteTableRow>
                {rows.map((r, i) => (
                  <CalciteTableRow key={keyOf(r, i)}>{row(r)}</CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          )}
        </>
      )}
    </>
  );
}

const unavailable = () =>
  Promise.reject(new Error('The customs API is unavailable in this data mode.'));

/** Shipping Bills — the filed export declarations. */
export function ShippingBills() {
  const { adapter } = useApp();
  const [search, setSearch] = useState('');
  const state = useAsync<ShippingBillRecord[]>(
    () => (adapter.getShippingBills ? adapter.getShippingBills({ limit: 200 }) : unavailable()),
    [adapter],
  );
  const q = search.trim().toUpperCase();
  const filtered = (state.data ?? []).filter(
    (r) => !q || String(r.sb_no).includes(q) || (r.site_id ?? '').toUpperCase().includes(q));

  return (
    <Register<ShippingBillRecord>
      state={{ ...state, data: filtered }}
      source="ICEGATE · Shipping Bill (export declaration)"
      caption="shipping bills"
      search={search}
      setSearch={setSearch}
      searchLabel="Search (SB number / site)"
      placeholder="4014226"
      exportRows={(rows) => rows.map((r) => ({ 'SB No': r.sb_no, 'SB Date': r.sb_date, 'Site': r.site_id }))}
      exportName="shipping-bills.csv"
      columns={['SB number', 'SB date', 'Filing site']}
      keyOf={(r, i) => `${r.sb_no}-${i}`}
      emptyMessage="No shipping bill matches the current search."
      row={(r) => (
        <>
          <CalciteTableCell><strong>{val(r.sb_no)}</strong></CalciteTableCell>
          <CalciteTableCell>{fmtDate(r.sb_date)}</CalciteTableCell>
          <CalciteTableCell>{val(r.site_id)}</CalciteTableCell>
        </>
      )}
    />
  );
}

/** Let Export Orders — customs clearance for an export declaration. */
export function Leo() {
  const { adapter } = useApp();
  const [search, setSearch] = useState('');
  const state = useAsync<LeoRecord[]>(
    () => (adapter.getLeoRecords ? adapter.getLeoRecords({ limit: 200 }) : unavailable()),
    [adapter],
  );
  const q = search.trim().toUpperCase();
  const filtered = (state.data ?? []).filter(
    (r) => !q || String(r.sb_no).includes(q) || String(r.rotation_no ?? '').includes(q));

  return (
    <Register<LeoRecord>
      state={{ ...state, data: filtered }}
      source="ICEGATE · Let Export Order"
      caption="let export orders"
      search={search}
      setSearch={setSearch}
      searchLabel="Search (SB number / rotation)"
      placeholder="2343823"
      exportRows={(rows) => rows.map((r) => ({
        'SB No': r.sb_no, 'SB Date': r.sb_date, 'Site': r.site_id,
        'Rotation No': r.rotation_no, 'LEO Date': r.leo_date,
      }))}
      exportName="let-export-orders.csv"
      // The single most important thing on this screen: these LEOs are NOT the
      // clearance status of the shipping bills on the previous view.
      notice={(
        <CalciteNotice open kind="warning" icon="information" scale="s" style={{ margin: '4px 0 10px' }}>
          <div slot="title">Not linked to the Shipping Bills view</div>
          <div slot="message">
            These Let Export Orders and the filed Shipping Bills are two separate document
            sets in this dataset — they share no SB number, so no LEO here is the clearance
            status of any shipping bill shown under “Shipping Bill”. Treat each register on
            its own until customs supply matching records.
          </div>
        </CalciteNotice>
      )}
      columns={['SB number', 'SB date', 'LEO date', 'Rotation', 'Site']}
      keyOf={(r, i) => `${r.sb_no}-${i}`}
      emptyMessage="No let export order matches the current search."
      row={(r) => (
        <>
          <CalciteTableCell><strong>{val(r.sb_no)}</strong></CalciteTableCell>
          <CalciteTableCell>{fmtDate(r.sb_date)}</CalciteTableCell>
          <CalciteTableCell>
            {r.leo_date
              ? <CalciteChip scale="s" value={String(r.leo_date)}>{fmtDate(r.leo_date)}</CalciteChip>
              : '—'}
          </CalciteTableCell>
          <CalciteTableCell>{val(r.rotation_no)}</CalciteTableCell>
          <CalciteTableCell>{val(r.site_id)}</CalciteTableCell>
        </>
      )}
    />
  );
}

/** SMTP — Sub-Manifest Transhipment Permits (ICEGATE CHPOI13). */
export function Smtp() {
  const { adapter } = useApp();
  const [search, setSearch] = useState('');
  const state = useAsync<SmtpRecord[]>(
    () => (adapter.getSmtpRecords ? adapter.getSmtpRecords({ limit: 200 }) : unavailable()),
    [adapter],
  );
  const q = search.trim().toUpperCase();
  const filtered = (state.data ?? []).filter(
    (r) => !q
      || String(r.smtp_no).includes(q)
      || String(r.igm_no ?? '').includes(q)
      || String(r.bond_no ?? '').includes(q)
      || (r.destination_code ?? '').toUpperCase().includes(q));

  return (
    <Register<SmtpRecord>
      state={{ ...state, data: filtered }}
      source="ICEGATE · CHPOI13 (Sub-Manifest Transhipment Permit)"
      caption="transhipment permits"
      search={search}
      setSearch={setSearch}
      searchLabel="Search (SMTP / IGM / bond / destination)"
      placeholder="2697411"
      exportRows={(rows) => rows.map((r) => ({
        'SMTP No': r.smtp_no, 'SMTP Date': r.smtp_date, 'IGM No': r.igm_no,
        'IGM Date': r.igm_date, 'Destination': r.destination_code,
        'Carrier': r.carrier_code, 'Bond No': r.bond_no,
        'Terminal': r.terminal_operator_code, 'Containers': r.line_count,
      }))}
      exportName="transhipment-permits.csv"
      columns={['SMTP number', 'SMTP date', 'IGM', 'Destination', 'Bond', 'Terminal', 'Containers']}
      keyOf={(r, i) => `${r.smtp_no}-${i}`}
      emptyMessage="No transhipment permit matches the current search."
      row={(r) => (
        <>
          <CalciteTableCell><strong>{val(r.smtp_no)}</strong></CalciteTableCell>
          <CalciteTableCell>{fmtDate(r.smtp_date)}</CalciteTableCell>
          <CalciteTableCell>{val(r.igm_no)}</CalciteTableCell>
          <CalciteTableCell>{val(r.destination_code)}</CalciteTableCell>
          <CalciteTableCell>{val(r.bond_no)}</CalciteTableCell>
          <CalciteTableCell>{val(r.terminal_operator_code)}</CalciteTableCell>
          {/* Count only — there is no per-permit container endpoint, so this
              must not look clickable. */}
          <CalciteTableCell>{val(r.line_count)}</CalciteTableCell>
        </>
      )}
    />
  );
}
