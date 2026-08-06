/**
 * Import — the container lifecycle from vessel manifest to truck gate-out.
 *
 * The counterpart of the Export tab. Until now the import leg had no lifecycle
 * surface at all: its ten canonical steps (markdowns/02_Import_Container_
 * Lifecycle.md) were spread across the Customs, Scan, Gate and Movements tabs as
 * separate document REGISTERS, with nothing stating that they are one sequence
 * and no way to follow a single box through them.
 *
 * This tab adds the two things that were missing and nothing else:
 *   1. the step strip — the canonical order, and what this corpus can evidence;
 *   2. a per-container chain view, assembled from the filed documents.
 *
 * It deliberately does NOT duplicate the registers. Each step links to the panel
 * that already renders it well. This is a spine, not a second copy of the data.
 *
 * Data sources (POC-3, all container-keyed and all pre-existing):
 *   GET /api/customs/containers/{cn}   -> IGM line, OOC, SMTP, RMS selection
 *   GET /api/gate-docs/container/{cn}  -> EIR, PIN ticket, Form 13
 *   GET /api/shipping-lines/edo?container_no={cn} -> the delivery order
 *   GET /api/shipping-lines/gate-movements        -> the CODECO gate-out
 *
 * ⚠ WHAT THIS PANEL MUST NOT IMPLY.
 * No container in this corpus traverses all ten steps — the document families are
 * disjoint by design. A chain here is therefore expected to be PARTIAL, and every
 * step it cannot fill states the documented reason rather than rendering blank.
 * Nothing is inferred to bridge a gap.
 */
import { useEffect, useState } from 'react';
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteInput, CalciteLabel,
  CalciteLoader, CalciteNotice, CalciteSegmentedControl, CalciteSegmentedControlItem,
} from '@esri/calcite-components-react';
import type {
  ContainerCustomsView, ContainerGateDocs, EdoRecord, GateMovement,
} from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { SourceBadge } from './SourceBadge.js';
import { LifecycleSteps, IMPORT_STEPS, IMPORT_VIEWS, SHARED_SURFACES } from './LifecycleSteps.js';
import { Igm } from './Igm.js';
import { ScanQueueTable } from './ScanQueue.js';
import { OocPanel } from './OocPanel.js';
import { EdoPanel } from './EdoPanel.js';
import { Smtp } from './CustomsRegisters.js';
import { tokens } from '../theme/tokens.js';

const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));

const fmtTs = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};

/**
 * The five containers whose joins actually resolve in this corpus — the "heroes"
 * of markdowns/02_Import_Container_Lifecycle.md. Between them they span every
 * step; individually each covers a different stretch.
 *
 * Offered as one-click examples because a blank search box over a corpus this
 * disjoint is unusable: most container numbers legitimately return nothing, and a
 * viewer cannot distinguish that from a broken lookup.
 */
const HEROES: Array<{ container: string; covers: string }> = [
  { container: 'DPWU9011100', covers: 'Manifest → gate-out on truck (the headline chain)' },
  { container: 'CSNU1399404', covers: 'Manifest → Bill of Entry → out-of-charge' },
  { container: 'DFSU1691030', covers: 'Manifest → electronic delivery order' },
  { container: 'NYKU4768188', covers: 'Vessel → EIR gate transaction, with driver and TAT' },
  { container: 'OOLU9340457', covers: 'PIN pickup ticket → truck' },
];

/** One step row in the chain. `evidence` is empty when the step has no document. */
interface ChainStep {
  no: number;
  label: string;
  /** Facts read verbatim off the filed document. */
  evidence: Array<[string, string]>;
  /** Why the step is empty. Rendered ONLY when `evidence` is empty. */
  absentReason: string;
}

/**
 * Assemble the ten canonical steps for one container from whatever documents name
 * it. Pure — every value is copied off a fetched record, nothing is derived across
 * documents, and an unfilled step falls through to its documented reason.
 */
function buildChain(
  customs: ContainerCustomsView | null,
  gateDocs: ContainerGateDocs | null,
  edos: EdoRecord[],
  gateMove: GateMovement | undefined,
): ChainStep[] {
  const igmLine = customs?.igm?.[0];
  const vessel = customs?.vessel;
  const ooc = customs?.ooc?.[0];
  const rms = customs?.rms?.[0];
  const eir = gateDocs?.eir?.[0];
  const pin = gateDocs?.pin?.[0];
  const edo = edos[0];

  return [
    {
      no: 1,
      label: 'Manifested on IGM',
      evidence: igmLine ? [
        ['IGM number', val(igmLine.igm_no)],
        ['Line number', val(igmLine.line_no)],
        ['Seal', val(igmLine.seal_no)],
        ['Status', val(igmLine.container_status)],
        ['ISO size/type', val(igmLine.iso_size_type)],
        ['Container agent', val(igmLine.container_agent_code)],
      ] : [],
      absentReason: 'This container is not declared on any manifest in the corpus. 16 CHPOI03 '
        + 'manifests were supplied, covering 11,914 distinct containers.',
    },
    {
      no: 2,
      label: 'Vessel arrival',
      evidence: vessel ? [
        ['Vessel code', val(vessel.vessel_code)],
        ['IMO', val(vessel.imo_code)],
        ['Voyage', val(vessel.voyage_no)],
        ['Shipping line', val(vessel.shipping_line_code)],
        ['Terminal', val(vessel.terminal_operator_code)],
        ['ETA', fmtTs(vessel.expected_arrival)],
        ['Entry inward', fmtTs(vessel.entry_inward)],
        ...(gateMove?.arrival_ts
          ? [['Actual arrival (CODECO)', fmtTs(gateMove.arrival_ts)] as [string, string]]
          : []),
      ] : [],
      absentReason: 'No vessel is bound to this container — the binding runs through the '
        + 'manifest, and this box is on none.',
    },
    {
      no: 3,
      label: 'Discharge confirmation (COARRI)',
      evidence: [],
      absentReason: 'No COARRI discharge confirmation exists for ANY JNPA call in this corpus — '
        + 'the only sample is a Visakhapatnam call, usable for schema only. So the discharge '
        + 'timestamp and crane/bay detail cannot be shown for any container.',
    },
    {
      no: 4,
      label: 'Yard',
      evidence: [],
      absentReason: 'Yard occupancy is published per terminal, not per container — the daily '
        + 'status reports carry no container numbers. See the Pendency tab for the terminal view.',
    },
    {
      no: 5,
      label: 'RMS scan selection',
      evidence: rms ? [
        ['Selected on IGM', val(rms.igm_no)],
        ['Scanner', rms.scan_machine === 'M' ? 'Mobile' : rms.scan_machine === 'D' ? 'Drive-through' : val(rms.scan_machine)],
        ['Scan location', val(rms.scan_location)],
        ['Bound CFS', val(rms.cfs_name)],
      ] : [],
      // Not selected is the normal case, and a branch — not a missing step.
      absentReason: customs?.status?.rms_selected
        ? 'Flagged on the manifest, but no scanning-division list assigns this box a machine.'
        : 'Not selected for scanning. This is a risk-based branch, not a step every container '
          + 'takes — most boxes are never selected.',
    },
    {
      no: 6,
      label: 'Customs out-of-charge',
      evidence: ooc ? [
        ['Bill of Entry', val(ooc.bill_of_entry_no)],
        ['Out-of-charge number', val(ooc.out_of_charge_no)],
        ['Out-of-charge date', fmtTs(ooc.out_of_charge_date)],
        ['Importer', val(ooc.importer_name)],
      ] : [],
      absentReason: 'No Bill of Entry names this container. 8 bills of entry are on file between '
        + 'them covering 9 containers, against 11,914 manifested boxes.',
    },
    {
      no: 7,
      label: 'Electronic delivery order',
      evidence: edo ? [
        ['DO number', val(edo.do_number)],
        ['Issued', fmtTs(edo.do_date)],
        ['Valid until', fmtTs(edo.valid_upto)],
        ['Agency', val(edo.agency_name)],
        ['Cites IGM', val(edo.igm_no)],
        ['VCN', val(edo.vcn)],
      ] : [],
      absentReason: 'No delivery order names this container. 6 delivery orders are on file, '
        + 'covering 9 containers between them.',
    },
    {
      no: 8,
      label: 'PIN pickup ticket',
      evidence: pin ? [
        ['PIN number', val(pin.pin_number)],
        ['Ticket type', val(pin.ticket_type)],
        ['Terminal', val(pin.terminal)],
        ['Lane', val(pin.gate)],
        ['Yard position', val(pin.yard_location)],
        ['Vehicle', val(pin.truck_no)],
        ['Trucking company', val(pin.company)],
        ['Issued', fmtTs(pin.issued_at)],
      ] : [],
      absentReason: 'No pickup ticket names this container. Only 2 tickets are on file — one at '
        + 'NSFT and one at Nhava Sheva IGT — and the IGT ticket records no container number.',
    },
    {
      no: 9,
      label: 'EIR at the gate',
      evidence: eir ? [
        ['EIR number', val(eir.eir_no)],
        ['Terminal', val(eir.terminal)],
        ['Truck in', fmtTs(eir.truck_in_time)],
        ['Truck out', fmtTs(eir.truck_out_time)],
        ['Turnaround', eir.tat_minutes != null ? `${eir.tat_minutes} min` : '—'],
        ['Truck', val(eir.truck_no)],
        ['Driver', val(eir.driver_name)],
        ['Licence', val(eir.driver_licence)],
        ['Vessel / VIA', `${val(eir.vessel)}${eir.via_no ? ` · ${eir.via_no}` : ''}`],
        ['Group code (CFS)', val(eir.group_code)],
      ] : [],
      absentReason: 'No Equipment Interchange Report names this container. 5 EIRs are on file.',
    },
    {
      no: 10,
      label: 'Gate-out on truck (CODECO)',
      evidence: gateMove ? [
        ['Gate pass', val(gateMove.gate_pass_no)],
        ['Gate-out time', fmtTs(gateMove.gate_pass_ts)],
        ['Gate', val(gateMove.gate_no)],
        ['Vehicle', val(gateMove.vehicle_no)],
        ['Delivery mode', gateMove.delivery_mode === 'G' ? 'G (gate delivery)' : val(gateMove.delivery_mode)],
        ['VCN', val(gateMove.vcn)],
        ['POL → POD', `${val(gateMove.pol)} → ${val(gateMove.final_pod)}`],
        ['Dwell', gateMove.dwell_hours != null
          ? `${(Number(gateMove.dwell_hours) / 24).toFixed(2)} days`
          : '—'],
      ] : [],
      absentReason: 'No CODECO gate message names this container. The corpus holds 5 CODECO '
        + 'messages in total, of which one is an import gate-out.',
    },
  ];
}

/**
 * The chain for one container, rendered as the ten canonical steps in order.
 *
 * Steps with evidence show it verbatim; steps without show WHY. That asymmetry is
 * the point of the view — a partial chain over real documents is the honest
 * picture, and it is far more useful than a full chain over inferred links.
 */
function ImportChainDialog({ containerNo, onClose }: { containerNo: string; onClose: () => void }) {
  const { adapter } = useApp();

  const customs = useAsync<ContainerCustomsView | null>(
    () => (adapter.getContainerCustoms
      ? adapter.getContainerCustoms(containerNo)
      : Promise.reject(new Error('The customs API is unavailable in this data mode.'))),
    [adapter, containerNo],
  );
  const gateDocs = useAsync<ContainerGateDocs | null>(
    () => (adapter.getContainerGateDocs ? adapter.getContainerGateDocs(containerNo) : Promise.resolve(null)),
    [adapter, containerNo],
  );
  const edos = useAsync<EdoRecord[]>(
    () => (adapter.getEdoForContainer ? adapter.getEdoForContainer(containerNo) : Promise.resolve([])),
    [adapter, containerNo],
  );
  // Only 5 CODECO messages exist, so one unfiltered read and a client-side find is
  // cheaper than a per-container endpoint that does not exist.
  const moves = useAsync<GateMovement[]>(
    () => (adapter.getGateMovements ? adapter.getGateMovements(undefined, { limit: 500 }) : Promise.resolve([])),
    [adapter],
  );

  const loading = customs.loading || gateDocs.loading || edos.loading || moves.loading;
  const gateMove = (moves.data ?? []).find((m) => m.container_no === containerNo);
  const steps = buildChain(customs.data ?? null, gateDocs.data ?? null, edos.data ?? [], gateMove);
  const evidenced = steps.filter((s) => s.evidence.length > 0).length;

  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <div
        role="dialog"
        aria-label={`Import chain for container ${containerNo}`}
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
          <strong style={{ fontSize: 14 }}>{containerNo}</strong>
          <span style={{ fontSize: 12, opacity: 0.85 }}>
            {loading ? 'assembling chain…' : `${evidenced} of 10 steps evidenced`}
          </span>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>

        <div style={{ padding: '12px 14px', overflowY: 'auto' }}>
          {loading ? (
            <CalciteLoader scale="s" label="Assembling the import chain" />
          ) : customs.error ? (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not load the customs view</div>
              <div slot="message">{customs.error}</div>
            </CalciteNotice>
          ) : (
            <>
              {evidenced === 0 && (
                <CalciteNotice open kind="info" icon="information" scale="s" style={{ marginBottom: 12 }}>
                  <div slot="title">No filed document names this container</div>
                  <div slot="message">
                    The lookup succeeded — this box appears in no manifest, customs document or
                    gate document in the corpus. That is the expected answer for most container
                    numbers here: the document families are disjoint and each covers a different
                    small set of boxes. Try one of the example containers on the tab behind this
                    dialog.
                  </div>
                </CalciteNotice>
              )}

              <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 12px' }}>
                Every value below is read verbatim from a filed document. No step is inferred
                from another, and a step with no document states why rather than rendering empty.
              </p>

              {steps.map((s) => {
                const has = s.evidence.length > 0;
                return (
                  <div
                    key={s.no}
                    style={{
                      display: 'flex', gap: 10, alignItems: 'flex-start',
                      padding: '10px 0', borderBottom: `1px solid ${tokens.color.border}`,
                    }}
                  >
                    {/* Rail: filled for an evidenced step, hollow for an absent one. */}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingTop: 2 }}>
                      <span
                        style={{
                          width: 12, height: 12, borderRadius: '50%', flexShrink: 0,
                          background: has ? tokens.congestion.GREEN : tokens.color.bgPanel,
                          border: `2px solid ${has ? tokens.congestion.GREEN : tokens.color.textMuted}`,
                        }}
                        aria-hidden
                      />
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted }}>{s.no}</span>
                        <strong style={{ fontSize: 13, color: has ? tokens.color.text : tokens.color.textMuted }}>
                          {s.label}
                        </strong>
                        <CalciteChip
                          scale="s"
                          value={has ? 'filed' : 'no document'}
                          style={{
                            ['--calcite-chip-text-color' as never]:
                              has ? tokens.congestion.GREEN : tokens.color.textMuted,
                          }}
                        >
                          {has ? 'Filed document' : 'No document'}
                        </CalciteChip>
                      </div>

                      {has ? (
                        <div
                          style={{
                            display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                            gap: '6px 16px', marginTop: 8,
                            background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
                            borderRadius: 6, padding: '10px 12px',
                          }}
                        >
                          {s.evidence.map(([label, value]) => (
                            <div key={label}>
                              <div style={{ fontSize: 10.5, textTransform: 'uppercase', letterSpacing: 0.4, color: tokens.color.textMuted }}>
                                {label}
                              </div>
                              <strong style={{ color: tokens.color.text, fontSize: 12.5, wordBreak: 'break-word' }}>
                                {value}
                              </strong>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 11.5, color: tokens.color.textMuted, marginTop: 4, lineHeight: 1.4 }}>
                          {s.absentReason}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
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

/** Views within the Import tab. `overview` is the strip + chain search. */
type ImportView = (typeof IMPORT_VIEWS)[number];

/**
 * The import surface — the canonical step order IS the navigation.
 *
 * Steps 1, 5, 6 and 7 own their registers as sub-views here (they were previously
 * scattered across the Customs and Scan tabs). Steps 2, 3, 4, 8, 9 and 10 live on
 * shared surfaces — Gate and Pendency serve both legs — so they link out rather
 * than being duplicated inbound.
 */
export function ImportList({ onOpenTab, jumpToView }: {
  onOpenTab?: (tab: string) => void;
  /** A guided-tour step asking for a specific sub-view. See Dashboard.goToTab. */
  jumpToView?: { view: string; nonce: number } | null;
} = {}) {
  const [view, setView] = useState<ImportView>('overview');

  // Apply a tour's requested view. Keyed on the nonce, not the view string, so a
  // later step asking for the same view still re-applies it — and so the user is
  // free to navigate away in between without being snapped back.
  useEffect(() => {
    if (jumpToView) setView(jumpToView.view as ImportView);
  }, [jumpToView?.nonce]);

  return (
    <>
      <LifecycleSteps
        steps={IMPORT_STEPS}
        title="Import container lifecycle — vessel manifest to truck gate-out"
        activeView={view}
        onSelectView={(v) => setView(v as ImportView)}
        onOpenTab={onOpenTab}
        related={[SHARED_SURFACES.gate!, SHARED_SURFACES.pendency!, SHARED_SURFACES.cfsecy!]}
      />

      <div style={{ marginBottom: 10 }}>
        <CalciteSegmentedControl
          scale="s"
          onCalciteSegmentedControlChange={(e) =>
            setView((e.target as unknown as { selectedItem?: { value?: string } })
              .selectedItem?.value as ImportView)}
        >
          <CalciteSegmentedControlItem value="overview" checked={view === 'overview'}>
            Overview · container chain
          </CalciteSegmentedControlItem>
          {/* Transhipment is a branch off the manifest, not a numbered step, so it
              sits beside the overview rather than in the strip. */}
          <CalciteSegmentedControlItem value="smtp" checked={view === 'smtp'}>
            SMTP (transhipment)
          </CalciteSegmentedControlItem>
        </CalciteSegmentedControl>
      </div>

      {view === 'igm' && <Igm />}
      {view === 'scan' && <ScanQueueTable />}
      {view === 'ooc' && <OocPanel />}
      {view === 'edo' && <EdoPanel />}
      {view === 'smtp' && <Smtp />}
      {view === 'overview' && <ImportOverview />}
    </>
  );
}

/** The strip's landing view: what the corpus holds, and the chain lookup. */
function ImportOverview() {
  const [search, setSearch] = useState('');
  const [target, setTarget] = useState<string | null>(null);

  const open = (cn: string) => {
    const norm = cn.trim().toUpperCase().replace(/\s+/g, '');
    if (norm) setTarget(norm);
  };

  return (
    <>
      <SourceBadge source="ICEGATE customs documents · terminal gate documents · shipping-line E-DO" live />

      <CalciteNotice open kind="info" icon="information" scale="s" style={{ margin: '8px 0 10px' }}>
        <div slot="title">No container in this corpus traverses all ten steps</div>
        <div slot="message">
          The document families are disjoint by design: the manifests, the bills of entry, the
          delivery orders and the gate documents each cover a different small set of boxes. A
          chain here is expected to be partial, and each unfilled step says which document is
          missing and why. Nothing is inferred to close a gap.
        </div>
      </CalciteNotice>

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', margin: '4px 0 12px' }}>
        <CalciteLabel scale="s" style={{ minWidth: 320 }}>Follow a container through its filed documents
          <div style={{ display: 'flex', gap: 6 }}>
            <CalciteInput
              scale="s"
              value={search}
              placeholder="DPWU9011100"
              onCalciteInputInput={(e) => setSearch((e.target as unknown as { value: string }).value)}
              onKeyDown={(e) => { if (e.key === 'Enter') open(search); }}
            />
            <CalciteButton scale="s" iconStart="search" disabled={!search.trim()} onClick={() => open(search)}>
              Open chain
            </CalciteButton>
          </div>
        </CalciteLabel>
      </div>

      {/* The boxes whose joins actually resolve. Without these, a viewer searching
          arbitrary container numbers gets "no document" every time and cannot tell
          a disjoint corpus from a broken lookup. */}
      <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4, margin: '4px 0 6px' }}>
        Containers with filed documents
      </div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {HEROES.map((h) => (
          <button
            key={h.container}
            type="button"
            onClick={() => open(h.container)}
            style={{
              flex: '1 1 240px', minWidth: 240, textAlign: 'left', cursor: 'pointer',
              background: tokens.color.bgElevated, border: `1px solid ${tokens.color.border}`,
              borderRadius: tokens.radius.md, padding: '9px 11px', font: 'inherit', color: 'inherit',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <CalciteIcon icon="container" scale="s" style={{ color: tokens.color.brand }} />
              <strong style={{ fontSize: 12.5, color: tokens.color.text }}>{h.container}</strong>
            </div>
            <div style={{ fontSize: 11, color: tokens.color.textMuted, marginTop: 3, lineHeight: 1.35 }}>
              {h.covers}
            </div>
          </button>
        ))}
      </div>

      {target && <ImportChainDialog containerNo={target} onClose={() => setTarget(null)} />}
    </>
  );
}
