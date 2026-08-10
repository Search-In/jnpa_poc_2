/**
 * E-DO — Electronic Delivery Order (AGDORD).
 *
 * The shipping line's authority to release a container to its consignee, filed
 * between customs clearance and gate-out (see markdowns/02_Import_Container_
 * Lifecycle.md, Hero C: DFSU1691030 + DFSU1687214). Sits in the Scan tab beside
 * the scan queue and OOC, so the three customs/release documents a container
 * needs are in one place.
 *
 * Data source (POC-3, parsed from the official EDO/AGDORD files):
 *   GET /api/shipping-lines/edo             -> the delivery orders (this list)
 *   GET /api/shipping-lines/edo/{do_number} -> one DO + its container lines
 *
 * The E-DO column opens the detail popup. `manifest_linked` marks the DOs whose
 * containers are also on a filed IGM — the only cross-document join that
 * resolves in this dataset, so it is surfaced rather than left implicit.
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteButton, CalciteChip, CalciteIcon, CalciteNotice, CalciteLoader,
  CalciteInput, CalciteLabel,
} from '@esri/calcite-components-react';
import type { EdoDetail, EdoRecord } from '@jnpa/data';
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

/** Weights arrive as decimal STRINGS (Postgres numeric) — coerce before formatting. */
function fmtNum(v?: number | string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/** Detail popup for one delivery order: the DO facts plus every container line. */
function EdoDetailDialog({ record, onClose }: { record: EdoRecord; onClose: () => void }) {
  const { adapter } = useApp();
  const doNo = record.do_number;
  const detail = useAsync<EdoDetail | null>(
    () => (adapter.getEdoDetail
      ? adapter.getEdoDetail(doNo)
      : Promise.reject(new Error('The shipping-line API is unavailable in this data mode.'))),
    [adapter, doNo],
  );
  const head = detail.data?.header ?? record;
  const lines = detail.data?.lines ?? [];

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
        aria-label={`Delivery order detail for ${doNo}`}
        style={{
          position: 'fixed', top: '50%', left: '50%', transform: 'translate(-50%,-50%)',
          width: 'min(940px, 96vw)', maxHeight: '90vh', background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`, borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff', borderRadius: '12px 12px 0 0' }}>
          <CalciteIcon icon="file-report" scale="s" />
          <strong style={{ fontSize: 14 }}>E-DO {val(doNo)}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>{val(head.agency_name)}</span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {detail.loading ? (
            <CalciteLoader scale="s" label="Loading delivery order" />
          ) : detail.error ? (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not load the delivery order</div>
              <div slot="message">{detail.error}</div>
            </CalciteNotice>
          ) : (
            <>
              {section('Delivery order')}
              {facts([
                ['DO number', val(head.do_number)],
                ['Issued', fmtDate(head.do_date)],
                ['Valid up to', fmtDate(head.valid_upto)],
                ['Delivery type', val(head.delivery_type)],
                ['Total weight', `${fmtNum(head.total_weight)} ${head.weight_unit ?? ''}`.trim()],
                ['Containers', String(head.container_count ?? lines.length)],
              ])}

              {section('Vessel & manifest')}
              {facts([
                ['VCN', val(head.vcn)],
                ['Vessel IMO', val(head.imo_no)],
                ['Voyage', val(head.voyage_no)],
                ['IGM number', val(head.igm_no)],
                ['IGM date', fmtDate(head.igm_date)],
                ['Custodian terminal', val(head.custodian_code)],
              ])}

              {section('Issuing agency')}
              {facts([
                ['Agency', val(head.agency_name)],
                ['Notify email', val(head.notify_email)],
              ])}

              {section(`Containers (${lines.length})`)}
              {lines.length === 0 ? (
                <CalciteNotice open kind="info" icon="information" scale="s">
                  <div slot="message">No container lines are recorded on this delivery order.</div>
                </CalciteNotice>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <CalciteTable caption={`containers on delivery order ${doNo}`}>
                    <CalciteTableRow slot="table-header">
                      <CalciteTableHeader heading="Container" />
                      <CalciteTableHeader heading="Seal" />
                      <CalciteTableHeader heading="ISO" />
                      <CalciteTableHeader heading="BL" />
                      <CalciteTableHeader heading="Consignee" />
                      <CalciteTableHeader heading="Cargo" />
                      <CalciteTableHeader heading="Pkgs" />
                      <CalciteTableHeader heading="Gross wt" />
                      <CalciteTableHeader heading="POL → POD" />
                      <CalciteTableHeader heading="On manifest" />
                    </CalciteTableRow>
                    {lines.map((l, i) => (
                      <CalciteTableRow key={`${l.line_no}-${l.container_no}-${i}`}>
                        <CalciteTableCell><strong>{val(l.container_no)}</strong></CalciteTableCell>
                        <CalciteTableCell>{val(l.seal_no)}</CalciteTableCell>
                        <CalciteTableCell>{val(l.iso_code)}</CalciteTableCell>
                        <CalciteTableCell>{val(l.bl_no)}</CalciteTableCell>
                        <CalciteTableCell title={l.consignee_addr ?? undefined}>
                          <span style={{ display: 'inline-block', maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                            {val(l.consignee_name)}
                          </span>
                        </CalciteTableCell>
                        <CalciteTableCell title={l.cargo_desc ?? undefined}>
                          <span style={{ display: 'inline-block', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                            {val(l.cargo_desc)}
                          </span>
                        </CalciteTableCell>
                        <CalciteTableCell>{fmtNum(l.packages)} {l.package_code ?? ''}</CalciteTableCell>
                        <CalciteTableCell>{fmtNum(l.gross_weight)}</CalciteTableCell>
                        <CalciteTableCell>{val(l.pol)} → {val(l.pod)}</CalciteTableCell>
                        <CalciteTableCell>
                          {/* The container was found on a filed IGM — the real link
                              back to lifecycle step 1. */}
                          {l.manifest_igm_no
                            ? (
                              <CalciteChip
                                scale="s"
                                icon="check"
                                value={`IGM ${l.manifest_igm_no}`}
                                title={`Declared on IGM ${l.manifest_igm_no}, line ${l.manifest_line_no ?? '—'}`}
                                style={{ ['--calcite-chip-text-color' as never]: tokens.congestion.GREEN }}
                              >
                                {`IGM ${l.manifest_igm_no} / ${l.manifest_line_no ?? '—'}`}
                              </CalciteChip>
                            )
                            : <span style={{ color: tokens.color.textMuted }}>not on file</span>}
                        </CalciteTableCell>
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

/** The E-DO list — one row per delivery order, each opening the detail popup. */
export function EdoPanel() {
  const { adapter } = useApp();
  const [target, setTarget] = useState<EdoRecord | null>(null);
  const [search, setSearch] = useState('');

  const state = useAsync<EdoRecord[]>(
    () => (adapter.getEdoRecords
      ? adapter.getEdoRecords()
      : Promise.reject(new Error('The shipping-line API is unavailable in this data mode.'))),
    [adapter],
  );

  const q = search.trim().toUpperCase();
  const rows = (state.data ?? []).filter((r) =>
    !q ||
    r.do_number.includes(q) ||
    String(r.igm_no ?? '').includes(q) ||
    r.agency_name?.toUpperCase().includes(q) ||
    r.vcn?.toUpperCase().includes(q));

  return (
    <>
      <SourceBadge source="Shipping line · AGDORD (Electronic Delivery Order)" live />

      {state.loading ? (
        <CalciteLoader scale="s" label="Loading delivery orders" />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load delivery orders</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
            <CalciteLabel scale="s" style={{ minWidth: 250 }}>Search (DO / IGM / agency / VCN)
              <CalciteInput
                scale="s"
                value={search}
                placeholder="120260611441759"
                onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
              />
            </CalciteLabel>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                importTarget={UPLOAD_TARGETS.edo}
                data={rows.map((r) => ({
                  'DO Number': r.do_number,
                  'DO Date': r.do_date,
                  'Valid Up To': r.valid_upto,
                  'VCN': r.vcn,
                  'Vessel IMO': r.imo_no,
                  'Voyage': r.voyage_no,
                  'IGM No': r.igm_no,
                  'IGM Date': r.igm_date,
                  'Agency': r.agency_name,
                  'Custodian': r.custodian_code,
                  'Delivery Type': r.delivery_type,
                  'Containers': r.container_count,
                  'On Filed Manifest': r.manifest_linked,
                }))}
                filename="edo-delivery-orders.csv"
              />
            </div>
          </div>

          <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
            {rows.length} delivery order{rows.length === 1 ? '' : 's'}
          </p>

          {rows.length === 0 ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No delivery orders</div>
              <div slot="message">No E-DO matches the current search.</div>
            </CalciteNotice>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <CalciteTable caption="electronic delivery orders">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="DO number" />
                  <CalciteTableHeader heading="Issued" />
                  <CalciteTableHeader heading="Valid to" />
                  <CalciteTableHeader heading="Agency" />
                  <CalciteTableHeader heading="IGM" />
                  <CalciteTableHeader heading="VCN" />
                  <CalciteTableHeader heading="Terminal" />
                  <CalciteTableHeader heading="Containers" />
                  <CalciteTableHeader heading="E-DO" />
                </CalciteTableRow>
                {rows.map((r) => (
                  <CalciteTableRow key={r.do_number}>
                    <CalciteTableCell><strong>{val(r.do_number)}</strong></CalciteTableCell>
                    <CalciteTableCell>{fmtDate(r.do_date)}</CalciteTableCell>
                    <CalciteTableCell>{fmtDate(r.valid_upto)}</CalciteTableCell>
                    <CalciteTableCell title={r.agency_name ?? undefined}>
                      <span style={{ display: 'inline-block', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                        {val(r.agency_name)}
                      </span>
                    </CalciteTableCell>
                    <CalciteTableCell>
                      {/* A green IGM chip means the DO's containers were found on a
                          filed manifest — the lifecycle link back to step 1. */}
                      {r.manifest_linked
                        ? (
                          <CalciteChip
                            scale="s"
                            icon="check"
                            value={String(r.igm_no)}
                            title="Containers on this DO are declared on a filed IGM"
                            style={{ ['--calcite-chip-text-color' as never]: tokens.congestion.GREEN }}
                          >
                            {val(r.igm_no)}
                          </CalciteChip>
                        )
                        : <span title="The cited IGM is not among the filed manifests">{val(r.igm_no)}</span>}
                    </CalciteTableCell>
                    <CalciteTableCell>{val(r.vcn)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.custodian_code)}</CalciteTableCell>
                    <CalciteTableCell>{val(r.container_count)}</CalciteTableCell>
                    <CalciteTableCell>
                      <CalciteButton
                        scale="s"
                        appearance="outline"
                        kind="brand"
                        iconStart="file-report"
                        title="DO, vessel/manifest, agency and container lines"
                        onClick={() => setTarget(r)}
                      >
                        E-DO
                      </CalciteButton>
                    </CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          )}
        </>
      )}

      {target && <EdoDetailDialog record={target} onClose={() => setTarget(null)} />}
    </>
  );
}
