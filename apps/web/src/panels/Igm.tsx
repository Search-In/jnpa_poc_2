/**
 * IGM — Import General Manifest (ICEGATE CHPOI03).
 *
 * Step 1 of the import container lifecycle (see markdowns/02_Import_Container_
 * Lifecycle.md): "Manifested on IGM". The shipping line files the manifest before
 * the vessel arrives, declaring the vessel/voyage and every cargo line and
 * container on board. Everything downstream — discharge, yard, RMS scan, customs
 * out-of-charge, delivery order, gate-out — hangs off the IGM number + line number
 * declared here.
 *
 * Data source: the POC-3 customs layer, parsed from the official ICEGATE CHPOI03
 * XML files.
 *   GET /api/customs/igm                       -> the manifest headers (this list)
 *   GET /api/customs/igm/{igm_no}/containers   -> the container lines (drill-down)
 * Nothing on this panel is simulated or derived — every cell is a value the
 * shipping line actually filed. Fields the manifest leaves blank render as "—".
 *
 * RBAC: /api/customs is scoped to CONTROL_ROOM + CUSTOMS on POC-3, so a token
 * minted for another role gets a 403, which surfaces as the panel's error notice.
 */
import { useMemo, useState } from 'react';
import {
  CalciteTable, CalciteTableRow, CalciteTableHeader, CalciteTableCell,
  CalciteChip, CalciteButton, CalciteIcon, CalciteNotice, CalciteInput,
  CalciteLabel, CalciteLoader, CalciteSelect, CalciteOption,
} from '@esri/calcite-components-react';
import type { IgmContainer, IgmManifest, RmsScanList } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { RmsScanDrawer } from './RmsScanDrawer.js';
import { tokens } from '../theme/tokens.js';

/** Render a possibly-absent manifest value; blanks read as an em-dash, never "null". */
const val = (v: unknown): string =>
  v === null || v === undefined || v === '' ? '—' : String(v);

/** ISO date/timestamp → local display. Invalid/absent input falls back to an em-dash. */
function fmtDate(v?: string | null, withTime = false): string {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

/**
 * Numbers are filed with varying precision; show them as filed, grouped. The API
 * serialises Postgres `numeric` as a decimal STRING ("1.350"), so coerce first —
 * a non-numeric value is shown verbatim rather than as NaN.
 */
function fmtNum(v?: number | string | null): string {
  if (v === null || v === undefined || v === '') return '—';
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return String(v);
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

/**
 * Container status as filed on the manifest container block (FCL / LCL / EMPTY).
 * Colours reuse the existing tokens; unknown codes fall through to a plain chip.
 */
const STATUS_COLOR: Record<string, string> = {
  FCL: tokens.congestion.GREEN,
  LCL: tokens.congestion.AMBER,
  EMPTY: tokens.color.textMuted,
};

/**
 * Drill-down slide-over: every container declared on one manifest. Reuses the
 * app's fixed slide-over pattern (see ContainerMovements TimelineDrawer). The
 * container rows come straight from `/api/customs/igm/{igm_no}/containers`; the
 * search box filters the already-loaded page client-side.
 */
function ContainerDrawer({ manifest, onClose }: { manifest: IgmManifest; onClose: () => void }) {
  const { adapter } = useApp();
  const igmNo = manifest.igm_no;
  const [search, setSearch] = useState('');
  // No `limit` → the adapter pages through the whole manifest, so a 2 794-container
  // manifest lists in full instead of being silently cut at one page.
  const state = useAsync<IgmContainer[]>(
    () => (adapter.getIgmContainers
      ? adapter.getIgmContainers(igmNo)
      : Promise.reject(new Error('The customs API is unavailable in this data mode.'))),
    [adapter, igmNo],
  );

  const rows = useMemo(() => {
    const all = state.data ?? [];
    const q = search.trim().toUpperCase();
    if (!q) return all;
    return all.filter((c) =>
      c.container_no?.toUpperCase().includes(q) ||
      c.bl_no?.toUpperCase().includes(q) ||
      c.seal_no?.toUpperCase().includes(q) ||
      c.importer_name?.toUpperCase().includes(q));
  }, [state.data, search]);

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <aside
        role="dialog"
        aria-label={`Containers declared on IGM ${igmNo}`}
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(920px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="file-report" scale="s" />
          <strong style={{ fontSize: 14 }}>IGM {val(igmNo)}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            {val(manifest.vessel_code)} · voy {val(manifest.voyage_no)} · IMO {val(manifest.imo_code)}
          </span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '10px 14px', overflowY: 'auto', flex: 1 }}>
          {/* Manifest header facts, as filed. */}
          <div
            style={{
              display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: '6px 16px', fontSize: 12, color: tokens.color.textMuted,
              background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
              borderRadius: 6, padding: '10px 12px', marginBottom: 12,
            }}
          >
            {([
              ['IGM date', fmtDate(manifest.igm_date)],
              ['Customs house', val(manifest.customs_house_code)],
              ['Shipping line', val(manifest.shipping_line_code)],
              ['Shipping agent', val(manifest.shipping_agent_code)],
              ['Terminal operator', val(manifest.terminal_operator_code)],
              ['Master', val(manifest.master_name)],
              ['Cargo brief', val(manifest.brief_cargo_desc)],
              ['ETA', fmtDate(manifest.expected_arrival, true)],
              ['Entry inward', fmtDate(manifest.entry_inward, true)],
              ['Declared lines', fmtNum(manifest.total_no_of_lines)],
              ['Lines filed', fmtNum(manifest.line_count)],
              ['Containers', fmtNum(manifest.container_count)],
            ] as [string, string][]).map(([label, value]) => (
              <div key={label}>
                <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</div>
                <strong style={{ color: tokens.color.text, fontSize: 12.5 }}>{value}</strong>
              </div>
            ))}
          </div>

          {state.loading ? (
            <CalciteLoader label="Loading containers" text="Loading declared containers…" />
          ) : state.error ? (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not load containers</div>
              <div slot="message">{state.error}</div>
            </CalciteNotice>
          ) : (
            <>
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
                <CalciteLabel scale="s" style={{ minWidth: 260 }}>Filter (container / BL / seal / importer)
                  <CalciteInput
                    scale="s"
                    value={search}
                    placeholder="DPWU9011100"
                    onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
                  />
                </CalciteLabel>
                <div style={{ marginLeft: 'auto' }}>
                  <ImportExportToolbar
                    data={rows.map((c) => ({
                      'IGM No': c.igm_no,
                      'Line No': c.line_no,
                      'Subline No': c.subline_no,
                      'Container No': c.container_no,
                      'Seal No': c.seal_no,
                      'Container Agent': c.container_agent_code,
                      'Status': c.container_status,
                      'ISO Size/Type': c.iso_size_type,
                      'Packages': c.no_of_packages,
                      'Container Weight': c.container_weight,
                      'SOC': c.soc_flag,
                      'BL No': c.bl_no,
                      'BL Date': c.bl_date,
                      'Port of Loading': c.port_of_loading,
                      'Port of Destination': c.port_of_destination,
                      'Importer': c.importer_name,
                      'Gross Weight': c.gross_weight,
                      'Weight Unit': c.unit_of_weight,
                      'Goods Description': c.goods_description,
                      'Selected for Scan': c.selected_scan,
                    }))}
                    filename={`igm-${igmNo}-containers.csv`}
                  />
                </div>
              </div>

              <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
                {rows.length} of {(state.data ?? []).length} containers declared on this manifest
              </p>

              {rows.length === 0 ? (
                <CalciteNotice open kind="info" icon="information" scale="s">
                  <div slot="title">No containers</div>
                  <div slot="message">No container on this manifest matches the filter.</div>
                </CalciteNotice>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <CalciteTable caption={`containers declared on IGM ${igmNo}`}>
                    <CalciteTableRow slot="table-header">
                      <CalciteTableHeader heading="Line" />
                      <CalciteTableHeader heading="Container" />
                      <CalciteTableHeader heading="Seal" />
                      <CalciteTableHeader heading="Status" />
                      <CalciteTableHeader heading="ISO" />
                      <CalciteTableHeader heading="Pkgs" />
                      <CalciteTableHeader heading="Weight" />
                      <CalciteTableHeader heading="Agent" />
                      <CalciteTableHeader heading="BL No" />
                      <CalciteTableHeader heading="POL → POD" />
                      <CalciteTableHeader heading="Importer" />
                      <CalciteTableHeader heading="Scan" />
                    </CalciteTableRow>
                    {rows.map((c) => (
                      <CalciteTableRow key={`${c.line_no}-${c.subline_no}-${c.container_no}`}>
                        <CalciteTableCell>
                          {val(c.line_no)}{c.subline_no ? `/${c.subline_no}` : ''}
                        </CalciteTableCell>
                        <CalciteTableCell>
                          <strong>{val(c.container_no)}</strong>
                        </CalciteTableCell>
                        <CalciteTableCell>{val(c.seal_no)}</CalciteTableCell>
                        <CalciteTableCell>
                          {c.container_status ? (
                            <CalciteChip
                              scale="s"
                              value={c.container_status}
                              style={{ ['--calcite-chip-text-color' as never]: STATUS_COLOR[c.container_status] ?? tokens.color.text }}
                            >
                              {c.container_status}
                            </CalciteChip>
                          ) : '—'}
                        </CalciteTableCell>
                        <CalciteTableCell>{val(c.iso_size_type)}</CalciteTableCell>
                        <CalciteTableCell>{fmtNum(c.no_of_packages)}</CalciteTableCell>
                        <CalciteTableCell>{fmtNum(c.container_weight)}</CalciteTableCell>
                        <CalciteTableCell>{val(c.container_agent_code)}</CalciteTableCell>
                        <CalciteTableCell>{val(c.bl_no)}</CalciteTableCell>
                        <CalciteTableCell>
                          {val(c.port_of_loading)} → {val(c.port_of_destination)}
                        </CalciteTableCell>
                        <CalciteTableCell title={c.goods_description ?? undefined}>
                          {val(c.importer_name)}
                        </CalciteTableCell>
                        <CalciteTableCell>
                          {/* Machine code when a scanning-division list assigned one,
                              otherwise the manifest's own SELECTED_SCAN flag. */}
                          {c.machine_type && c.scan_location ? (
                            <CalciteChip
                              scale="s"
                              value={`${c.machine_type}-${c.scan_location}`}
                              title={`Scanner ${c.machine_type === 'M' ? 'mobile' : 'drive-through'} at ${c.scan_location}${c.scan_cfs_name ? ` · CFS ${c.scan_cfs_name}` : ''}`}
                              style={{ ['--calcite-chip-text-color' as never]: tokens.color.brand }}
                            >
                              {c.machine_type}-{c.scan_location}
                            </CalciteChip>
                          ) : c.selected_scan ? (
                            <CalciteChip
                              scale="s"
                              value="Flagged"
                              title="The filed manifest declares SELECTED_SCAN=Y for this cargo line"
                              style={{ ['--calcite-chip-text-color' as never]: tokens.congestion.AMBER }}
                            >
                              Flagged
                            </CalciteChip>
                          ) : '—'}
                        </CalciteTableCell>
                      </CalciteTableRow>
                    ))}
                  </CalciteTable>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}

export function Igm() {
  const { adapter } = useApp();
  // Manifest whose containers are open in the drill-down (null = closed).
  const [selected, setSelected] = useState<IgmManifest | null>(null);
  // RMS scanning slide-over open state. Opened from the toolbar rather than a
  // manifest row because the scan lists are disjoint from the filed manifests.
  const [rmsOpen, setRmsOpen] = useState(false);
  const [search, setSearch] = useState('');
  // Terminal operator filter — the manifests span every JNPA terminal.
  const [terminal, setTerminal] = useState<string>('ALL');

  const state = useAsync<IgmManifest[]>(
    () => (adapter.getIgmManifests
      ? adapter.getIgmManifests({ limit: 200 })
      : Promise.reject(new Error('The customs API is unavailable in this data mode.'))),
    [adapter],
  );

  // The issued RMS scan lists reference IGM numbers that are NOT filed manifests,
  // so searching one here legitimately finds nothing. Loading them lets the empty
  // state name the match and point at the right place instead of dead-ending.
  // (The drawer requests the same URL; the adapter de-dupes it to one call.)
  const scanLists = useAsync<RmsScanList[]>(
    () => (adapter.getRmsScanLists ? adapter.getRmsScanLists() : Promise.resolve([])),
    [adapter],
  );

  const terminals = useMemo(
    () => Array.from(new Set((state.data ?? []).map((m) => m.terminal_operator_code).filter(Boolean) as string[])).sort(),
    [state.data],
  );

  const manifests = useMemo(() => {
    const all = state.data ?? [];
    const q = search.trim().toUpperCase();
    return all.filter((m) => {
      if (terminal !== 'ALL' && m.terminal_operator_code !== terminal) return false;
      if (!q) return true;
      return String(m.igm_no).includes(q) ||
        m.vessel_code?.toUpperCase().includes(q) ||
        m.imo_code?.toUpperCase().includes(q) ||
        m.voyage_no?.toUpperCase().includes(q) ||
        m.shipping_line_code?.toUpperCase().includes(q);
    });
  }, [state.data, search, terminal]);

  return (
    <>
      <Panel
        heading="IGM — Import General Manifest"
        description="Filed pre-arrival manifests (ICEGATE CHPOI03) and the containers declared on each"
        state={state}
        isEmpty={(d) => d.length === 0}
      >
        {() => (
          <>
            <SourceBadge source="ICEGATE · CHPOI03 (Import General Manifest)" live />

            {/* The RMS scanning branch of the lifecycle. It opens from here rather
                than from a manifest row because the scan lists reference IGMs that
                are not among the filed manifests — there is no row to hang it off. */}
            <div style={{ margin: '0 0 8px' }}>
              <CalciteButton
                scale="s"
                appearance="outline"
                kind="brand"
                iconStart="magnifying-glass"
                title="Customs risk-based container scanning selections (between discharge and delivery)"
                onClick={() => setRmsOpen(true)}
              >
                RMS scanning
              </CalciteButton>
            </div>

            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 8px' }}>
              <CalciteLabel scale="s" style={{ minWidth: 240 }}>Search (IGM / vessel / IMO / voyage / line)
                <CalciteInput
                  scale="s"
                  value={search}
                  placeholder="1194313"
                  onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
                />
              </CalciteLabel>
              <CalciteLabel scale="s" style={{ minWidth: 170 }}>Terminal operator
                <CalciteSelect
                  label="Terminal operator filter"
                  scale="s"
                  onCalciteSelectChange={(e) => setTerminal((e.target as unknown as { value: string }).value)}
                >
                  <CalciteOption value="ALL" selected={terminal === 'ALL'}>All terminals</CalciteOption>
                  {terminals.map((t) => (
                    <CalciteOption key={t} value={t} selected={t === terminal}>{t}</CalciteOption>
                  ))}
                </CalciteSelect>
              </CalciteLabel>
              <div style={{ marginLeft: 'auto' }}>
                <ImportExportToolbar
                  data={manifests.map((m) => ({
                    'IGM No': m.igm_no,
                    'IGM Date': m.igm_date,
                    'Customs House': m.customs_house_code,
                    'Vessel IMO': m.imo_code,
                    'Vessel Code': m.vessel_code,
                    'Voyage No': m.voyage_no,
                    'Master': m.master_name,
                    'Shipping Line': m.shipping_line_code,
                    'Shipping Agent': m.shipping_agent_code,
                    'Terminal Operator': m.terminal_operator_code,
                    'Port of Arrival': m.port_of_arrival,
                    'Cargo Brief': m.brief_cargo_desc,
                    'Declared Lines': m.total_no_of_lines,
                    'Lines Filed': m.line_count,
                    'Containers': m.container_count,
                    'ETA': m.expected_arrival,
                    'Entry Inward': m.entry_inward,
                  }))}
                  filename="igm-manifests.csv"
                />
              </div>
            </div>

            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: '0 0 6px' }}>
              {manifests.length} manifests · {fmtNum(manifests.reduce((n, m) => n + (m.container_count ?? 0), 0))} declared containers
            </p>

            {manifests.length === 0 ? (() => {
              // Did the search actually name an RMS scan list? If so, say which one
              // and send the user to the drawer rather than leaving a bare "no match".
              const q = search.trim().toUpperCase();
              const hit = q
                ? (scanLists.data ?? []).find((l) =>
                    String(l.igm_no).includes(q) || l.vessel_name?.toUpperCase().includes(q))
                : undefined;
              return hit ? (
                <CalciteNotice open kind="warning" icon="magnifying-glass" scale="s">
                  <div slot="title">That is an RMS scan list, not a filed manifest</div>
                  <div slot="message">
                    IGM {val(hit.igm_no)}{hit.igm_year ? `/${hit.igm_year}` : ''} ({val(hit.vessel_name)})
                    is a Container Scanning Division list with {fmtNum(hit.selected_count)} container(s)
                    selected. It is not among the filed manifests, so it has no row here — open it
                    from RMS scanning above.
                  </div>
                  <CalciteButton slot="link" scale="s" appearance="transparent" onClick={() => setRmsOpen(true)}>
                    Open RMS scanning
                  </CalciteButton>
                </CalciteNotice>
              ) : (
                <CalciteNotice open kind="info" icon="information" scale="s">
                  <div slot="title">No manifests</div>
                  <div slot="message">No filed manifest matches the current search or terminal filter.</div>
                </CalciteNotice>
              );
            })() : (
              <div style={{ overflowX: 'auto' }}>
                <CalciteTable caption="filed import general manifests">
                  <CalciteTableRow slot="table-header">
                    <CalciteTableHeader heading="IGM No" />
                    <CalciteTableHeader heading="IGM Date" />
                    <CalciteTableHeader heading="Vessel IMO" />
                    <CalciteTableHeader heading="Vessel" />
                    <CalciteTableHeader heading="Voyage" />
                    <CalciteTableHeader heading="Line" />
                    <CalciteTableHeader heading="Terminal" />
                    <CalciteTableHeader heading="ETA" />
                    <CalciteTableHeader heading="Entry inward" />
                    <CalciteTableHeader heading="Lines" />
                    <CalciteTableHeader heading="Containers" />
                  </CalciteTableRow>
                  {manifests.map((m) => (
                    <CalciteTableRow key={String(m.igm_no)}>
                      <CalciteTableCell>
                        <strong>{val(m.igm_no)}</strong>
                      </CalciteTableCell>
                      <CalciteTableCell>{fmtDate(m.igm_date)}</CalciteTableCell>
                      <CalciteTableCell>{val(m.imo_code)}</CalciteTableCell>
                      <CalciteTableCell>{val(m.vessel_code)}</CalciteTableCell>
                      <CalciteTableCell>{val(m.voyage_no)}</CalciteTableCell>
                      <CalciteTableCell>{val(m.shipping_line_code)}</CalciteTableCell>
                      <CalciteTableCell>{val(m.terminal_operator_code)}</CalciteTableCell>
                      <CalciteTableCell>{fmtDate(m.expected_arrival, true)}</CalciteTableCell>
                      <CalciteTableCell>
                        {m.entry_inward
                          ? fmtDate(m.entry_inward, true)
                          : <CalciteChip scale="s" value="Awaited" title="Customs has not granted entry inward on this manifest">Awaited</CalciteChip>}
                      </CalciteTableCell>
                      <CalciteTableCell>{fmtNum(m.line_count)}</CalciteTableCell>
                      <CalciteTableCell>
                        <CalciteButton
                          scale="s"
                          appearance="transparent"
                          kind="brand"
                          iconStart="container"
                          title="View the containers declared on this manifest"
                          disabled={!m.container_count}
                          onClick={() => setSelected(m)}
                        >
                          {fmtNum(m.container_count)}
                        </CalciteButton>
                      </CalciteTableCell>
                    </CalciteTableRow>
                  ))}
                </CalciteTable>
              </div>
            )}
          </>
        )}
      </Panel>
      {/* Mounted OUTSIDE the Panel so the drawer survives a Panel refetch
          (the Panel unmounts its children while useAsync reloads). */}
      {selected && <ContainerDrawer manifest={selected} onClose={() => setSelected(null)} />}
      {rmsOpen && <RmsScanDrawer onClose={() => setRmsOpen(false)} />}
    </>
  );
}
