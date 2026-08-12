/**
 * RMS scanning branch — the risk-based container-scanning step that applies
 * between discharge and delivery when Customs' Container Scanning Division
 * selects a box (see markdowns/02_Import_Container_Lifecycle.md, "RMS scanning
 * branch").
 *
 * A master–detail slide-over: the scan lists issued per vessel/IGM on the left,
 * and the containers that list selected for scanning on the right. Opened from
 * the IGM panel rather than hung off a manifest row, because the scan lists and
 * the filed manifests are DISJOINT in this corpus (see the notice below) — no
 * RMS selection joins to an IGM container, so there is no manifest row to
 * attach it to.
 *
 * Data source (POC-3 customs layer, parsed from the official scanning-division
 * .txt lists):
 *   GET /api/customs/rms                      -> the scan lists
 *   GET /api/customs/rms/{igm_no}/containers  -> the selected containers
 *
 * An empty container list is a REAL outcome — the scan list literally records
 * "No container selected for scanning" — so it renders as that statement, not
 * as an error or a bare empty table.
 */
import { useEffect, useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteChip, CalciteIcon, CalciteNotice, CalciteLoader, CalciteInput, CalciteLabel,
} from '@esri/calcite-components-react';
import type { RmsScanContainer, RmsScanList } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { InfoPopover } from '../components/InfoPopover.js';
import { tokens } from '../theme/tokens.js';

const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

function fmtDate(v?: string | null): string {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString();
}

/**
 * Scanner class as filed on the selection line. The .txt lists render the pair
 * as e.g. "(D-INNSA1RSDT01)", so the two fields are shown joined the same way.
 */
const MACHINE_LABEL: Record<string, string> = {
  D: 'Drive-through',
  M: 'Mobile',
};

/** The scan lists a vessel's IGM produced, keyed by IGM number (the natural key). */
function ScanListRow({
  list, active, onSelect,
}: { list: RmsScanList; active: boolean; onSelect: () => void }) {
  const selected = list.selected_count ?? 0;
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'block', width: '100%', textAlign: 'left', cursor: 'pointer',
        background: active ? tokens.color.bgElevated : 'transparent',
        border: `1px solid ${active ? tokens.color.brand : tokens.color.border}`,
        borderRadius: 6, padding: '8px 10px', marginBottom: 6, font: 'inherit',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>{val(list.vessel_name)}</strong>
        <CalciteChip
          scale="s"
          value={selected ? `${selected} selected` : 'none selected'}
          style={{
            ['--calcite-chip-text-color' as never]:
              selected ? tokens.congestion.AMBER : tokens.color.textMuted,
          }}
        >
          {selected ? `${selected} selected` : 'none selected'}
        </CalciteChip>
      </div>
      <div style={{ fontSize: 11.5, color: tokens.color.textMuted, marginTop: 2 }}>
        IGM {val(list.igm_no)}{list.igm_year ? `/${list.igm_year}` : ''} · {val(list.shipping_line)}
      </div>
      <div style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
        Agent {val(list.shipping_agent)} · processed {fmtDate(list.processing_end_date)}
      </div>
    </button>
  );
}

export function RmsScanDrawer({ onClose }: { onClose: () => void }) {
  const { adapter } = useApp();
  // IGM number of the scan list whose containers are shown (null until loaded).
  const [activeIgm, setActiveIgm] = useState<string | number | null>(null);
  const [search, setSearch] = useState('');
  // Search over the scan LISTS (vessel / IGM / shipping line). Without this the
  // only searchable thing was a container number, so "GFS PERFECT" or "1194273"
  // matched nothing anywhere in the app.
  const [listSearch, setListSearch] = useState('');

  const lists = useAsync<RmsScanList[]>(
    () => (adapter.getRmsScanLists
      ? adapter.getRmsScanLists()
      : Promise.reject(new Error('The customs API is unavailable in this data mode.'))),
    [adapter],
  );

  const lq = listSearch.trim().toUpperCase();
  const visibleLists = (lists.data ?? []).filter((l) =>
    !lq ||
    String(l.igm_no).includes(lq) ||
    l.vessel_name?.toUpperCase().includes(lq) ||
    l.shipping_line?.toUpperCase().includes(lq) ||
    l.shipping_agent?.toUpperCase().includes(lq));

  // Keep the detail pane on a list that is actually visible. On first load prefer
  // one that selected something, so the drawer opens on evidence rather than on
  // an empty "none selected" pane; while searching, follow the first match.
  useEffect(() => {
    if (!visibleLists.length) return;
    const stillVisible = visibleLists.some((l) => String(l.igm_no) === String(activeIgm));
    if (stillVisible) return;
    const withSelection = visibleLists.find((l) => (l.selected_count ?? 0) > 0);
    setActiveIgm((withSelection ?? visibleLists[0])!.igm_no);
  }, [visibleLists, activeIgm]);

  const containers = useAsync<RmsScanContainer[]>(
    () => {
      if (activeIgm == null) return Promise.resolve([]);
      if (!adapter.getRmsScanContainers) {
        return Promise.reject(new Error('The customs API is unavailable in this data mode.'));
      }
      return adapter.getRmsScanContainers(activeIgm);
    },
    [adapter, activeIgm],
  );

  const active = lists.data?.find((l) => String(l.igm_no) === String(activeIgm));
  const q = search.trim().toUpperCase();
  // Vessel and IGM are matched too, so the same string works in either box.
  const rows = (containers.data ?? []).filter((c) =>
    !q ||
    c.container_no?.toUpperCase().includes(q) ||
    c.cfs_name?.toUpperCase().includes(q) ||
    c.scan_location?.toUpperCase().includes(q) ||
    c.vessel_name?.toUpperCase().includes(q) ||
    String(c.igm_no).includes(q));

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <aside
        role="dialog"
        aria-label="RMS container scanning selections"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(1080px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="magnifying-glass" scale="s" />
          <strong style={{ fontSize: 14 }}>RMS container scanning</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            Risk-based selection between discharge and delivery
          </span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
          {/* Master: the scan lists, one per vessel/IGM. */}
          <div style={{ width: 300, flexShrink: 0, borderRight: `1px solid ${tokens.color.border}`, overflowY: 'auto', padding: '10px 12px' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, marginBottom: 8 }}>
              Scan lists issued
            </div>
            <CalciteLabel scale="s" style={{ marginBottom: 6 }}>Find a list (vessel / IGM / line)
              <CalciteInput
                scale="s"
                value={listSearch}
                placeholder="GFS PERFECT"
                onCalciteInputInput={(e) => setListSearch((e.target as unknown as { value: string }).value)}
              />
            </CalciteLabel>
            {lists.loading ? (
              <CalciteLoader scale="s" label="Loading scan lists" />
            ) : lists.error ? (
              <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
                <div slot="message">{lists.error}</div>
              </CalciteNotice>
            ) : visibleLists.length === 0 ? (
              <CalciteNotice open kind="info" icon="information" scale="s">
                <div slot="message">
                  {(lists.data ?? []).length === 0
                    ? 'No scan lists have been issued.'
                    : `No scan list matches "${listSearch}".`}
                </div>
              </CalciteNotice>
            ) : (
              visibleLists.map((l) => (
                <ScanListRow
                  key={String(l.igm_no)}
                  list={l}
                  active={String(l.igm_no) === String(activeIgm)}
                  onSelect={() => { setActiveIgm(l.igm_no); setSearch(''); }}
                />
              ))
            )}
          </div>

          {/* Detail: the containers this list selected for scanning. */}
          <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '10px 14px' }}>
            {/* The corpus splits RMS and IGM on purpose; still said here — behind the
                (i) — rather than let a user read the absent join as a bug. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, fontSize: 12, color: tokens.color.textMuted }}>
              Scan lists do not join to the filed manifests
              <InfoPopover label="Scan lists do not join to the filed manifests">
                <strong style={{ display: 'block', marginBottom: 4 }}>
                  Scan lists do not join to the filed manifests
                </strong>
                These scan lists reference IGM numbers that are not among the filed manifests in
                this dataset, so a selected container never appears on the IGM tab&apos;s manifest
                rows. The two sets are disjoint by design.
              </InfoPopover>
            </div>

            {active && (
              <div
                style={{
                  display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
                  gap: '6px 16px', fontSize: 12, color: tokens.color.textMuted,
                  background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
                  borderRadius: 6, padding: '10px 12px', marginBottom: 12,
                }}
              >
                {([
                  ['Vessel', val(active.vessel_name)],
                  ['IGM', `${val(active.igm_no)}${active.igm_year ? `/${active.igm_year}` : ''}`],
                  ['Shipping line', val(active.shipping_line)],
                  ['Agent PAN', val(active.shipping_agent)],
                  ['Processing end', fmtDate(active.processing_end_date)],
                  ['Selected', String(active.selected_count ?? 0)],
                ] as [string, string][]).map(([label, value]) => (
                  <div key={label}>
                    <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
                    <strong style={{ color: tokens.color.text, fontSize: 12.5 }}>{value}</strong>
                  </div>
                ))}
              </div>
            )}

            {containers.loading ? (
              <CalciteLoader scale="s" label="Loading selected containers" />
            ) : containers.error ? (
              <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
                <div slot="title">Could not load selected containers</div>
                <div slot="message">{containers.error}</div>
              </CalciteNotice>
            ) : (containers.data ?? []).length === 0 ? (
              // The scan list's own verbatim outcome — not an error, not missing data.
              <CalciteNotice open kind="success" icon="check-circle" scale="s">
                <div slot="title">No container selected for scanning</div>
                <div slot="message">
                  This scan list was issued for {val(active?.vessel_name)} and selected no container,
                  so nothing on this vessel was held for a risk scan.
                </div>
              </CalciteNotice>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                  <CalciteLabel scale="s" style={{ minWidth: 260 }}>Filter (container / CFS / scanner)
                    <CalciteInput
                      scale="s"
                      value={search}
                      placeholder="MRKU9527629"
                      onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
                    />
                  </CalciteLabel>
                  <div style={{ marginLeft: 'auto' }}>
                    <ImportExportToolbar
                      data={rows.map((c) => ({
                        'IGM No': c.igm_no,
                        'IGM Year': c.igm_year,
                        'Vessel': c.vessel_name,
                        'Shipping Line': c.shipping_line,
                        'Sl No': c.sl_no,
                        'Container No': c.container_no,
                        'Machine Type': c.machine_type,
                        'Scan Location': c.scan_location,
                        'Machine Code': c.machine_type && c.scan_location ? `${c.machine_type}-${c.scan_location}` : null,
                        'CFS': c.cfs_name,
                        'Goods Description': c.goods_description,
                      }))}
                      filename={`rms-scan-${val(active?.igm_no)}.csv`}
                    />
                  </div>
                </div>

                <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
                  {rows.length} of {(containers.data ?? []).length} containers selected for scanning
                </p>

                <div style={{ overflowX: 'auto' }}>
                  <CalciteTable caption={`containers selected for scanning on IGM ${val(active?.igm_no)}`}>
                    <CalciteTableRow slot="table-header">
                      <CalciteTableHeader heading="Sl" />
                      <CalciteTableHeader heading="Container" />
                      <CalciteTableHeader heading="Scanner" />
                      <CalciteTableHeader heading="Machine code" />
                      <CalciteTableHeader heading="CFS / ICD" />
                      <CalciteTableHeader heading="Goods" />
                    </CalciteTableRow>
                    {rows.map((c) => (
                      <CalciteTableRow key={`${c.sl_no}-${c.container_no}`}>
                        <CalciteTableCell>{val(c.sl_no)}</CalciteTableCell>
                        <CalciteTableCell><strong>{val(c.container_no)}</strong></CalciteTableCell>
                        <CalciteTableCell>
                          {c.machine_type ? (
                            <CalciteChip scale="s" value={c.machine_type} title={MACHINE_LABEL[c.machine_type] ?? c.machine_type}>
                              {MACHINE_LABEL[c.machine_type] ?? c.machine_type}
                            </CalciteChip>
                          ) : '—'}
                        </CalciteTableCell>
                        <CalciteTableCell>
                          {/* Rendered the way the scan list itself prints it, e.g. "D-INNSA1RSDT01". */}
                          {c.machine_type && c.scan_location ? `${c.machine_type}-${c.scan_location}` : val(c.scan_location)}
                        </CalciteTableCell>
                        <CalciteTableCell>{val(c.cfs_name)}</CalciteTableCell>
                        <CalciteTableCell title={c.goods_description ?? undefined}>
                          <span style={{ display: 'inline-block', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}>
                            {val(c.goods_description)}
                          </span>
                        </CalciteTableCell>
                      </CalciteTableRow>
                    ))}
                  </CalciteTable>
                </div>
              </>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}
