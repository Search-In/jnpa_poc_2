/**
 * Gate operations panel (prompt §10) — per-gate queue length + avg transaction
 * time, plus a predicted gate-queue overlay (30–120 min) for a selected gate.
 * The live density heatmap is on the map's Gates layer (A.1).
 */
import { Fragment, useState } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip, CalciteNotice, CalciteIcon,
  CalciteLoader,
} from '@esri/calcite-components-react';
import type { EirTransaction, GateEvent, GateMovement, GateMovementGate, GateOpsDTO, GateQueueForecastDTO, PinTicket } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { InfoPopover } from '../components/InfoPopover.js';
import { UPLOAD_TARGETS } from './uploadTargets.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

/** CSV projection for the PIN table — shared by the toolbar in every panel state. */
const pinExportRows = (rows: PinTicket[]) => rows.map((p) => ({
  'PIN No': p.pin_number,
  'Ticket Type': p.ticket_type,
  'Terminal': p.terminal,
  'Container': p.container_number,
  'Lane': p.gate,
  'Vehicle No': p.truck_no,
  'Trucking Company': p.company,
  'Yard Position': p.yard_location,
  'Group Code (CFS)': p.group_code,
  'Move Type': p.move_type,
  'Leg': p.leg_seq,
  'Issued At': p.issued_at,
}));

/** CSV projection for the EIR table — shared by the toolbar in every panel state. */
const eirExportRows = (rows: EirTransaction[]) => rows.map((e) => ({
  'EIR No': e.eir_no,
  'Terminal': e.terminal,
  'Container': e.container_number,
  'Gate In': e.truck_in_time,
  'Gate Out': e.truck_out_time,
  'TAT (min)': e.tat_minutes,
  'Truck No': e.truck_no,
  'Driver Name': e.driver_name,
  'Driver Licence': e.driver_licence,
  'Vessel': e.vessel,
  'VIA': e.via_no,
  'Seal Number': e.seal_number,
  'Group Code (CFS)': e.group_code,
  'Company': e.company,
  'Scanner Stamp': e.scanner_stamp,
}));

const qColor = (n: number) => (n > 16 ? tokens.congestion.RED : n > 8 ? tokens.congestion.AMBER : tokens.congestion.GREEN);

const val = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v));
const fmtTs = (v?: string | null) => {
  if (!v) return '—';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
};

/**
 * Dwell cell — the time the box sat in the terminal, DERIVED from the two
 * timestamps on its own CODECO message (vessel arrival → gate pass).
 *
 * The breakdown opens on CLICK rather than as a native `title` tooltip: a title
 * only appears after a hover pause, never on click, and multi-line titles are
 * unreliable across browsers — so the icon looked inert. This renders a real
 * panel, so the derivation is always reachable and the number stays traceable
 * to its source values.
 */
function DwellCell({ m }: { m: GateMovement }) {
  const hours = m.dwell_hours == null ? null : Number(m.dwell_hours);
  if (hours == null || Number.isNaN(hours)) {
    return <span style={{ color: tokens.color.textMuted }}>—</span>;
  }
  const days = hours / 24;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <strong>{days.toFixed(2)} d</strong>
      <InfoPopover label={`How dwell was derived for ${m.container_no}`} width={300}>
        <strong style={{ display: 'block', marginBottom: 4 }}>
          Dwell = gate-out − vessel arrival
        </strong>
        <span style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px' }}>
          <span style={{ color: tokens.color.textMuted }}>arrival</span>
          <span>{fmtTs(m.arrival_ts)}</span>
          <span style={{ color: tokens.color.textMuted }}>gate-out</span>
          <span>{fmtTs(m.gate_pass_ts)}</span>
          <span style={{ color: tokens.color.textMuted }}>elapsed</span>
          <strong>{hours.toFixed(2)} h ({days.toFixed(2)} days)</strong>
        </span>
        <span style={{ display: 'block', marginTop: 6, color: tokens.color.textMuted }}>
          Derived from this container&apos;s CODECO message.
        </span>
      </InfoPopover>
    </span>
  );
}

/**
 * Gate-in cell with the transaction detail behind an (i) — driver, licence,
 * vessel, seal and CFS group code, all from the container's own EIR.
 *
 * Click-to-open (not a native `title`), matching DwellCell: a title tooltip only
 * appears after a hover pause and never on click.
 *
 * Fields the EIR import left empty render as "not recorded" rather than being
 * hidden, so a gap in the source is visible instead of looking like the field
 * does not exist.
 */
function EirDetailCell({ e }: { e: EirTransaction }) {
  const facts: Array<[string, string | null | undefined]> = [
    ['Driver', e.driver_name],
    ['Licence (DL)', e.driver_licence],
    ['Vessel', e.vessel ? `${e.vessel}${e.via_no ? ` · ${e.via_no}` : ''}` : null],
    ['Seal number', e.seal_number],
    ['Group code (CFS)', e.group_code],
    ['Truck', e.truck_no],
    ['Company', e.company],
    ['Scan stamp', e.scanner_stamp],
  ];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <span>{fmtTs(e.truck_in_time)}</span>
      <InfoPopover label={`Gate transaction detail for ${e.eir_no ?? e.truck_no ?? 'this EIR'}`}>
        <strong style={{ display: 'block', marginBottom: 6 }}>
          {val(e.eir_no)} · {val(e.container_number)}
        </strong>
        <span style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px' }}>
          {facts.map(([label, value]) => (
            <Fragment key={label}>
              <span style={{ color: tokens.color.textMuted }}>{label}</span>
              {value
                ? <strong>{value}</strong>
                : <span style={{ color: tokens.color.textMuted, fontStyle: 'italic' }}>not recorded</span>}
            </Fragment>
          ))}
        </span>
        <span style={{ display: 'block', marginTop: 6, color: tokens.color.textMuted }}>
          Gate in {fmtTs(e.truck_in_time)} → out {fmtTs(e.truck_out_time)}
          {e.tat_minutes != null ? ` · TAT ${e.tat_minutes} min` : ''}
        </span>
      </InfoPopover>
    </span>
  );
}

/**
 * EIR gate transactions — the truck-level record of a container moving through
 * the gate (lifecycle step: EIR at gate). One row per Equipment Interchange
 * Report: the truck in, the box, the truck out.
 *
 * Source: POC-3 `GET /api/gate-docs/eir`, from the terminals' EIR documents.
 *
 * Scoped to the selected gate by matching that gate's TERMINAL code against the
 * EIR's free-text terminal ("Gateway (GTI)" contains GTI). The EIR names a
 * terminal, not a gate number, so a gate id narrows to its terminal — every EIR
 * at that terminal is shown rather than pretending a per-lane split exists.
 */
function EirSection({ gate }: { gate: string }) {
  const { adapter } = useApp();
  // Terminal code from the dashboard gate id: "NSICT-G1" -> "NSICT".
  const terminal = (/^(.*)-G\w+$/i.exec(gate)?.[1] ?? gate).toUpperCase();

  const state = useAsync<EirTransaction[]>(
    () => (adapter.getEirTransactions
      ? adapter.getEirTransactions()
      : Promise.reject(new Error('The gate-document API is unavailable in this data mode.'))),
    [adapter],
  );

  const all = state.data ?? [];
  // Match the canonical code the backend resolved (via core.ref_terminal_alias).
  // Fall back to the free-text label only when a terminal could not be resolved.
  const rows = all.filter((e) => (e.terminal_code
    ? e.terminal_code.toUpperCase() === terminal
    : (e.terminal ?? '').toUpperCase().includes(terminal)));

  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.color.text }}>EIR gate transactions</div>
          <div style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
            Trucks through the gate at this terminal (Equipment Interchange Report)
          </div>
        </div>
        <CalciteChip scale="s" icon="filter" value={terminal} style={{ marginLeft: 'auto' }}>
          {terminal}
        </CalciteChip>
      </div>

      <SourceBadge source="Terminal EIR (Equipment Interchange Report)" live />

      {/* Outside the ternary below on purpose. The empty branch replaces the
          table AND everything with it, so leaving the toolbar inside meant a
          terminal with no EIRs offered no way to import any — a dead end at
          exactly the moment Import is the only useful control. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <ImportExportToolbar
          data={eirExportRows(rows)}
          filename={`eir-${terminal.toLowerCase()}.csv`}
          importTarget={UPLOAD_TARGETS.eir}
          onImported={() => state.data && window.location.reload()}
        />
      </div>

      {state.loading ? (
        <CalciteLoader scale="s" label="Loading gate transactions" />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load gate transactions</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : rows.length === 0 ? (
        <CalciteNotice open kind="info" icon="information" scale="s">
          <div slot="title">No EIR transactions for {terminal}</div>
          <div slot="message">
            No Equipment Interchange Report names this terminal.
            {all.length > 0
              ? ` EIRs on file cover: ${[...new Set(all.map((e) => e.terminal_code || e.terminal).filter(Boolean))].join(', ')}.`
              : ''}
          </div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              {rows.length} gate transaction{rows.length === 1 ? '' : 's'} at {terminal}
            </p>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <CalciteTable caption="EIR gate transactions">
              <CalciteTableRow slot="table-header">
                <CalciteTableHeader heading="EIR" />
                <CalciteTableHeader heading="Container" />
                <CalciteTableHeader heading="Gate in" />
                <CalciteTableHeader heading="Gate out" />
                <CalciteTableHeader heading="TAT" />
                <CalciteTableHeader heading="Truck" />
                <CalciteTableHeader heading="Company" />
              </CalciteTableRow>
              {rows.map((e) => (
                <CalciteTableRow key={`${e.id}-${e.eir_no}`}>
                  <CalciteTableCell>{val(e.eir_no)}</CalciteTableCell>
                  <CalciteTableCell>
                    {e.container_number
                      ? <strong>{e.container_number}</strong>
                      : <span style={{ color: tokens.color.textMuted }} title="EIR recorded with no container (empty truck move)">no container</span>}
                  </CalciteTableCell>
                  {/* Gate-in carries the (i): the transaction detail hangs off the
                      moment the truck entered. */}
                  <CalciteTableCell><EirDetailCell e={e} /></CalciteTableCell>
                  <CalciteTableCell>{fmtTs(e.truck_out_time)}</CalciteTableCell>
                  <CalciteTableCell>
                    {e.tat_minutes != null
                      ? <CalciteChip scale="s" value={`${e.tat_minutes} min`}>{`${e.tat_minutes} min`}</CalciteChip>
                      : '—'}
                  </CalciteTableCell>
                  <CalciteTableCell>{val(e.truck_no)}</CalciteTableCell>
                  <CalciteTableCell>{val(e.company)}</CalciteTableCell>
                </CalciteTableRow>
              ))}
            </CalciteTable>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * PIN pickup tickets — the ticket a trucker quotes at the gate to collect a
 * specific container (lifecycle step: PIN/pickup ticket, before the EIR).
 *
 * Source: POC-3 `GET /api/gate-docs/pin`. Scoped to the selected gate by matching
 * that gate's TERMINAL code against the ticket's free-text terminal, the same way
 * the EIR section does.
 *
 * The source ticket also carries a TRANSACTION number and the SHIPPING LINE code,
 * but `core.pin_ticket` has no column for either, so they are not shown. Once the
 * columns exist they slot into this table with no other change.
 */
function PinTicketSection({ gate }: { gate: string }) {
  const { adapter } = useApp();
  const terminal = (/^(.*)-G\w+$/i.exec(gate)?.[1] ?? gate).toUpperCase();

  const state = useAsync<PinTicket[]>(
    () => (adapter.getPinTickets
      ? adapter.getPinTickets()
      : Promise.reject(new Error('The gate-document API is unavailable in this data mode.'))),
    [adapter],
  );

  const all = state.data ?? [];
  const rows = all.filter((p) => (p.terminal_code
    ? p.terminal_code.toUpperCase() === terminal
    : (p.terminal ?? '').toUpperCase().includes(terminal)));

  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.color.text }}>Pick-up tickets (PIN)</div>
          <div style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
            Tickets issued to collect a container at this terminal
          </div>
        </div>
        <CalciteChip scale="s" icon="filter" value={terminal} style={{ marginLeft: 'auto' }}>
          {terminal}
        </CalciteChip>
      </div>

      <SourceBadge source="Terminal pick-up ticket (PIN)" live />

      {/* Hoisted for the same reason as the EIR toolbar: core.pin_ticket holds
          only 2 rows today, so most terminals render the empty branch — which is
          exactly when the operator needs Import. */}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <ImportExportToolbar
          data={pinExportRows(rows)}
          filename={`pin-tickets-${terminal.toLowerCase()}.csv`}
          importTarget={UPLOAD_TARGETS.pin}
        />
      </div>

      {state.loading ? (
        <CalciteLoader scale="s" label="Loading pick-up tickets" />
      ) : state.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load pick-up tickets</div>
          <div slot="message">{state.error}</div>
        </CalciteNotice>
      ) : rows.length === 0 ? (
        // No tickets have been imported yet, so this is the normal state today.
        // Say which case it is rather than showing a bare empty table.
        <CalciteNotice open kind="info" icon="information" scale="s">
          <div slot="title">No pick-up tickets for {terminal}</div>
          <div slot="message">
            {all.length === 0
              ? 'No PIN pickup ticket has been imported yet — core.pin_ticket is empty.'
              : `No ticket names this terminal. Tickets on file cover: ${[...new Set(all.map((p) => p.terminal_code || p.terminal).filter(Boolean))].join(', ')}.`}
          </div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              {rows.length} pick-up ticket{rows.length === 1 ? '' : 's'} at {terminal}
            </p>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <CalciteTable caption="PIN pick-up tickets">
              <CalciteTableRow slot="table-header">
                <CalciteTableHeader heading="PIN no" />
                <CalciteTableHeader heading="Container" />
                <CalciteTableHeader heading="Lane" />
                <CalciteTableHeader heading="Vehicle" />
                <CalciteTableHeader heading="Issued" />
                <CalciteTableHeader heading="Move" />
              </CalciteTableRow>
              {rows.map((p) => (
                <CalciteTableRow key={`${p.id}-${p.pin_number}-${p.leg_seq ?? 0}`}>
                  <CalciteTableCell>
                    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <strong>{val(p.pin_number)}</strong>
                      <InfoPopover label={`Pick-up ticket detail for PIN ${p.pin_number ?? ''}`}>
                        <strong style={{ display: 'block', marginBottom: 6 }}>
                          PIN {val(p.pin_number)} · {val(p.container_number)}
                        </strong>
                        <span style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '3px 12px' }}>
                          {([
                            ['Ticket type', p.ticket_type],
                            ['Terminal', p.terminal],
                            ['Lane', p.gate],
                            ['Yard position', p.yard_location],
                            ['Group code (CFS)', p.group_code],
                            ['Vehicle', p.truck_no],
                            ['Trucking company', p.company],
                            ['Move type', p.move_type],
                            ['Remarks', p.remarks],
                          ] as Array<[string, string | null | undefined]>).map(([label, value]) => (
                            <Fragment key={label}>
                              <span style={{ color: tokens.color.textMuted }}>{label}</span>
                              {value
                                ? <strong>{value}</strong>
                                : <span style={{ color: tokens.color.textMuted, fontStyle: 'italic' }}>not recorded</span>}
                            </Fragment>
                          ))}
                        </span>
                      </InfoPopover>
                    </span>
                  </CalciteTableCell>
                  <CalciteTableCell>{val(p.container_number)}</CalciteTableCell>
                  <CalciteTableCell>{val(p.gate)}</CalciteTableCell>
                  {/* Trucking company sits UNDER the vehicle number. */}
                  <CalciteTableCell>
                    <span style={{ display: 'inline-block', lineHeight: 1.35 }}>
                      <strong>{val(p.truck_no)}</strong>
                      <span style={{ display: 'block', fontSize: 11, color: tokens.color.textMuted }}>
                        {val(p.company)}
                      </span>
                    </span>
                  </CalciteTableCell>
                  <CalciteTableCell>{fmtTs(p.issued_at)}</CalciteTableCell>
                  <CalciteTableCell>
                    {p.move_type
                      ? <CalciteChip scale="s" value={p.move_type}>{p.move_type}</CalciteChip>
                      : '—'}
                  </CalciteTableCell>
                </CalciteTableRow>
              ))}
            </CalciteTable>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Gate-out on truck (lifecycle final step) — every container that left through
 * the selected gate, from the terminal's CODECO messages: gate pass, vehicle,
 * gate number, delivery mode, plus the derived dwell.
 *
 * Source: POC-3 `GET /api/shipping-lines/gate-movements`. Read directly from the
 * CODECO records rather than via the delivery-order join, because a container can
 * be gated out with no E-DO on file (the two document sets do not fully overlap).
 */
/**
 * Recorded gate crossings — the UC-III return leg.
 *
 * `core.gate_event` is written by `POST /api/gate/events` when a truck actually
 * passes a lane, and until this section existed NO UC-2 panel read it. The three
 * tables above come from filed documents (`core.eir`, `core.pin_ticket`, CODECO),
 * none of which UC-III writes — so a container could be assigned a truck and
 * gated out in UC-III and leave no trace anywhere in this dashboard.
 *
 * ⚠ Deliberately NOT merged into the CODECO table above. A recorded crossing and
 * a filed CODECO movement are different evidence: one is UC-III's operational
 * log, the other the terminal's EDI message. Showing them as one list would let
 * an operational event pass as a filed document.
 */
function GateCrossingSection() {
  const { adapter } = useApp();
  const events = useAsync<GateEvent[]>(
    () => (adapter.getGateEvents ? adapter.getGateEvents({ limit: 200 }) : Promise.resolve([])),
    [adapter],
  );
  const rows = events.data ?? [];

  return (
    <div style={{ marginTop: 18 }}>
      <h4 style={{ margin: '0 0 6px', fontSize: 13 }}>
        Recorded gate crossings (UC-III)
        <InfoPopover label="About recorded gate crossings">
          Live crossings logged by UC-III when a truck passes a lane
          (<code>core.gate_event</code>), not filed documents. This is the only place UC-2
          can show that a box physically moved: UC-III writes here and updates nothing on
          the cargo record but <code>customs_status</code>, so a gate-out performed there
          does not change a container&apos;s lifecycle in Movements.
        </InfoPopover>
      </h4>
      <div><SourceBadge source="UC-III gate events" live /></div>
      {/* Say this on screen, not only in the code. An unfiltered table sitting
          under a gate selector reads as broken; the reason it cannot be scoped is
          a real data gap the operator should know about. */}
      <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 6px' }}>
        <CalciteIcon icon="information" scale="s" style={{ marginRight: 6 }} />
        <strong>Not scoped to the selected gate — every recorded crossing is listed.</strong>{' '}
        The two systems name gates differently and nothing joins them: this dashboard
        uses simulated ids from the terminal config (<code>NSICT-G1</code>), while a
        crossing carries the terminal&apos;s own gate code as filed
        (<code>IGTK01</code>, <code>OGTK05</code>). Filtering one against the other
        would hide every real crossing, so the filter is deliberately not applied.
        Scoping needs a JNPA gate reference — the equivalent of{' '}
        <code>core.ref_terminal_alias</code> for gates.
      </p>
      {events.loading ? (
        <CalciteLoader inline label="Loading gate crossings" />
      ) : events.error ? (
        <CalciteNotice open kind="warning" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not read recorded crossings</div>
          <div slot="message">{String(events.error)}</div>
        </CalciteNotice>
      ) : rows.length === 0 ? (
        <CalciteNotice open kind="info" icon="information" scale="s">
          <div slot="title">No crossings recorded</div>
          <div slot="message">
            UC-III has logged no gate crossing yet. This table stays empty until a truck is
            assigned and driven through a lane there — it is not fed by the filed gate
            documents above.
          </div>
        </CalciteNotice>
      ) : (
        <>
          <ImportExportToolbar
            data={rows.map((e) => ({
              'Event': e.event_type ?? '',
              'Timestamp': e.ts ?? '',
              'Container': e.container_number ?? '',
              'Plate': e.plate ?? '',
              'Gate': e.gate_id ?? '',
              'BAT Lane': e.bat_lane ?? '',
              'Document': `${e.document_type ?? ''} ${e.document_reference ?? ''}`.trim(),
              'Job': e.job_id ?? '',
            }))}
            filename="gate-crossings.csv"
          />
          <CalciteTable scale="s" caption="Gate crossings recorded by UC-III">
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Event" />
              <CalciteTableHeader heading="Time" />
              <CalciteTableHeader heading="Container" />
              <CalciteTableHeader heading="Plate" />
              <CalciteTableHeader heading="Gate" />
              <CalciteTableHeader heading="Lane" />
              <CalciteTableHeader heading="Document" />
              <CalciteTableHeader heading="Job" />
            </CalciteTableRow>
            {rows.map((e) => (
              <CalciteTableRow key={e.id ?? `${e.ts}-${e.plate}-${e.event_type}`}>
                <CalciteTableCell>
                  <CalciteChip scale="s" value={e.event_type ?? '—'}
                    style={{ ['--calcite-chip-text-color' as never]:
                      (e.event_type ?? '').toUpperCase() === 'GATE_OUT'
                        ? tokens.kpi.better : tokens.color.textMuted }}>
                    {e.event_type ?? '—'}
                  </CalciteChip>
                </CalciteTableCell>
                <CalciteTableCell>
                  {e.ts ? new Date(e.ts).toLocaleString() : '—'}
                </CalciteTableCell>
                <CalciteTableCell>{e.container_number || '—'}</CalciteTableCell>
                <CalciteTableCell>{e.plate || '—'}</CalciteTableCell>
                <CalciteTableCell>{e.gate_id || '—'}</CalciteTableCell>
                <CalciteTableCell>{e.bat_lane || '—'}</CalciteTableCell>
                <CalciteTableCell>
                  {e.document_type
                    ? `${e.document_type}${e.document_reference ? ` ${e.document_reference}` : ''}`
                    : '—'}
                </CalciteTableCell>
                <CalciteTableCell>{e.job_id != null ? `#${e.job_id}` : '—'}</CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>
        </>
      )}
    </div>
  );
}

function GateOutSection({ gate }: { gate: string }) {
  const { adapter } = useApp();

  // Which gates actually have movements — used to tell "this gate had none" apart
  // from "no CODECO data at all", so an empty table is explained rather than bare.
  const gates = useAsync<GateMovementGate[]>(
    () => (adapter.getGateMovementGates ? adapter.getGateMovementGates() : Promise.resolve([])),
    [adapter],
  );
  const moves = useAsync<GateMovement[]>(
    () => (adapter.getGateMovements
      ? adapter.getGateMovements(gate)
      : Promise.reject(new Error('The gate-movement API is unavailable in this data mode.'))),
    [adapter, gate],
  );

  const rows = moves.data ?? [];
  const withMovements = (gates.data ?? []).filter((g) => (g.movements ?? 0) > 0);

  /**
   * Export gate-in vs import gate-out.
   *
   * CODECO carries the direction in its header `StuffDestuffFlag` ('E' / 'I'),
   * but `core.codeco_movement` has no column for it, so the flag is not
   * persisted. It is reliably derivable from the ports instead: a box whose
   * port-of-loading IS Nhava Sheva is being loaded here, i.e. it came IN through
   * the gate for export. A foreign POL with `final_pod = INNSA` is the import
   * leg going out. Verified against all 5 corpus messages.
   */
  const isExportGateIn = (m: GateMovement) => (m.pol ?? '').toUpperCase().startsWith('INNSA');

  /**
   * A truck that brought an export box in and took an import box out is doing a
   * dual run — the single most useful decongestion signal in this data, and the
   * thing an empty-running trailer is not doing. Pair them by vehicle.
   */
  const roundTrips = (() => {
    const byVehicle = new Map<string, { in?: GateMovement; out?: GateMovement }>();
    for (const m of rows) {
      const v = (m.vehicle_no ?? '').trim().toUpperCase();
      if (!v) continue;
      const slot = byVehicle.get(v) ?? {};
      if (isExportGateIn(m)) slot.in = m; else slot.out = m;
      byVehicle.set(v, slot);
    }
    return [...byVehicle.entries()]
      .filter(([, s]) => s.in && s.out)
      .map(([vehicle, s]) => {
        const inTs = s.in!.gate_pass_ts ? new Date(s.in!.gate_pass_ts).getTime() : null;
        const outTs = s.out!.gate_pass_ts ? new Date(s.out!.gate_pass_ts).getTime() : null;
        const gapH = inTs !== null && outTs !== null ? Math.abs(outTs - inTs) / 3_600_000 : null;
        return { vehicle, in: s.in!, out: s.out!, gapH };
      });
  })();

  return (
    <div style={{ marginTop: 18, borderTop: `1px solid ${tokens.color.border}`, paddingTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: tokens.color.text }}>Gate-out on truck</div>
          <div style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
            Containers released through the selected gate (terminal CODECO)
          </div>
        </div>
        <CalciteChip scale="s" icon="filter" value={gate} style={{ marginLeft: 'auto' }}>
          {gate}
        </CalciteChip>
      </div>

      <SourceBadge source="Terminal CODECO (gate-out message)" live />

      {moves.loading ? (
        <CalciteLoader scale="s" label="Loading gate movements" />
      ) : moves.error ? (
        <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
          <div slot="title">Could not load gate movements</div>
          <div slot="message">{moves.error}</div>
        </CalciteNotice>
      ) : rows.length === 0 ? (
        <CalciteNotice open kind="info" icon="information" scale="s">
          <div slot="title">No gate-out movements for {gate}</div>
          <div slot="message">
            No CODECO gate-out message names this gate.
            {withMovements.length > 0
              ? ` Gate-out records exist for: ${withMovements.map((g) => `${g.gate_id ?? g.gate_no} (${g.movements})`).join(', ')}.`
              : ''}
          </div>
        </CalciteNotice>
      ) : (
        <>
          {/* Dual-run evidence: the same trailer delivering an export box and
              collecting an import one, rather than running back empty. */}
          {roundTrips.length > 0 && (
            <div
              style={{
                margin: '8px 0 10px', padding: '10px 12px',
                background: tokens.color.bgElevated,
                border: `1px solid ${tokens.congestion.GREEN}`, borderRadius: tokens.radius.md,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <CalciteIcon icon="refresh" scale="s" />
                <strong style={{ fontSize: 12.5, color: tokens.color.text }}>
                  Truck round-trip — {roundTrips.length} dual run{roundTrips.length === 1 ? '' : 's'} at this gate
                </strong>
              </div>
              {roundTrips.map((rt) => (
                <div key={rt.vehicle} style={{ fontSize: 12, color: tokens.color.textMuted }}>
                  <strong style={{ color: tokens.color.text }}>{rt.vehicle}</strong>
                  {' delivered export '}<strong style={{ color: tokens.color.text }}>{rt.in.container_no}</strong>
                  {' and collected import '}<strong style={{ color: tokens.color.text }}>{rt.out.container_no}</strong>
                  {rt.gapH !== null && ` — ${rt.gapH.toFixed(1)} h apart`}
                  {'. One trip, two boxes: no empty leg.'}
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              {rows.length} movement{rows.length === 1 ? '' : 's'} at {gate}
              {' — '}{rows.filter(isExportGateIn).length} export gate-in,
              {' '}{rows.filter((m) => !isExportGateIn(m)).length} import gate-out
            </p>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={rows.map((m) => ({
                  'Container No': m.container_no,
                  'Direction': isExportGateIn(m) ? 'EXPORT_GATE_IN' : 'IMPORT_GATE_OUT',
                  'Gate No': m.gate_no,
                  'Gate Pass No': m.gate_pass_no,
                  'Gate Pass Time': m.gate_pass_ts,
                  'Vehicle No': m.vehicle_no,
                  'Delivery Mode': m.delivery_mode,
                  'Status': m.equipment_status,
                  'ISO Code': m.iso_code,
                  'VCN': m.vcn,
                  'Vessel IMO': m.imo_no,
                  // NOT the shipping agent — see the interface note on GateMovement.agent_code.
                  'Container Agent (CACode)': m.agent_code,
                  'POL': m.pol,
                  'Final POD': m.final_pod,
                  'Arrival': m.arrival_ts,
                  'Receipt Date': m.receipt_date,
                  'Dwell (hours)': m.dwell_hours,
                }))}
                filename={`gate-out-${gate.toLowerCase()}.csv`}
              />
            </div>
          </div>

          <div style={{ overflowX: 'auto' }}>
            <CalciteTable caption="containers gated out on truck">
              <CalciteTableRow slot="table-header">
                <CalciteTableHeader heading="Container" />
                <CalciteTableHeader heading="Direction" />
                <CalciteTableHeader heading="Gate" />
                <CalciteTableHeader heading="Gate pass" />
                <CalciteTableHeader heading="Gate-out time" />
                <CalciteTableHeader heading="Vehicle" />
                <CalciteTableHeader heading="Mode" />
                <CalciteTableHeader heading="Status" />
                <CalciteTableHeader heading="ISO" />
                <CalciteTableHeader heading="VCN / IMO" />
                <CalciteTableHeader heading="POL → POD" />
                <CalciteTableHeader heading="Arrival" />
                <CalciteTableHeader heading="Dwell" />
              </CalciteTableRow>
              {rows.map((m) => (
                <CalciteTableRow key={`${m.id}-${m.container_no}`}>
                  <CalciteTableCell><strong>{val(m.container_no)}</strong></CalciteTableCell>
                  <CalciteTableCell>
                    {/* Derived from POL, not stored — see isExportGateIn. */}
                    <CalciteChip
                      scale="s"
                      value={isExportGateIn(m) ? 'EXPORT-IN' : 'IMPORT-OUT'}
                      title={isExportGateIn(m)
                        ? `Export gate-in: loading at ${val(m.pol)} for ${val(m.final_pod)}`
                        : `Import gate-out: discharged from ${val(m.pol)} at ${val(m.final_pod)}`}
                      style={{
                        ['--calcite-chip-text-color' as never]:
                          isExportGateIn(m) ? tokens.flow.EXPORT : tokens.flow.IMPORT,
                      }}
                    >
                      {isExportGateIn(m) ? 'Export in' : 'Import out'}
                    </CalciteChip>
                  </CalciteTableCell>
                  <CalciteTableCell>{val(m.gate_no)}</CalciteTableCell>
                  <CalciteTableCell>{val(m.gate_pass_no)}</CalciteTableCell>
                  <CalciteTableCell>{fmtTs(m.gate_pass_ts)}</CalciteTableCell>
                  <CalciteTableCell>{val(m.vehicle_no)}</CalciteTableCell>
                  <CalciteTableCell>
                    {/* G = gate delivery, per the CODECO DeliveryMode field. */}
                    {m.delivery_mode
                      ? <CalciteChip scale="s" value={m.delivery_mode} title={m.delivery_mode === 'G' ? 'Gate delivery' : m.delivery_mode}>{m.delivery_mode}</CalciteChip>
                      : '—'}
                  </CalciteTableCell>
                  <CalciteTableCell>{val(m.equipment_status)}</CalciteTableCell>
                  <CalciteTableCell>{val(m.iso_code)}</CalciteTableCell>
                  <CalciteTableCell>
                    {val(m.vcn)}{m.imo_no ? ` · ${m.imo_no}` : ''}
                  </CalciteTableCell>
                  <CalciteTableCell>{val(m.pol)} → {val(m.final_pod)}</CalciteTableCell>
                  <CalciteTableCell>{fmtTs(m.arrival_ts)}</CalciteTableCell>
                  <CalciteTableCell><DwellCell m={m} /></CalciteTableCell>
                </CalciteTableRow>
              ))}
            </CalciteTable>
          </div>
        </>
      )}
    </div>
  );
}

export function GateOps({ window }: { window: { from: string; to: string } }) {
  const { adapter, lang } = useApp();
  const simDep = useSimDep();
  const ops = useAsync<GateOpsDTO[]>(() => adapter.getGateOps(window), [adapter, window.from, window.to, simDep]);
  const [gate, setGate] = useState<string>('NSICT-G1');
  const forecast = useAsync<GateQueueForecastDTO>(() => adapter.getGateQueueForecast(gate), [adapter, gate]);

  return (
    <Panel
      heading={t('panel_gate', lang)}
      state={ops}
      isEmpty={(d) => d.length === 0}
      // In the persistent slot, not inside children: Panel's empty branch
      // replaces children wholesale, which used to take the toolbar with it.
      toolbar={(
        <ImportExportToolbar
          data={(ops.data ?? []).map((g) => ({
            'Gate': g.gateId,
            'Terminal': g.terminalId,
            'Queue Length': g.queueLength,
            'Avg Txn Time (min)': g.avgTxnTimeMin,
            'Transactions': g.transactions.length,
          }))}
          filename="gate-ops.csv"
        />
      )}
    >
      {(rows) => (
        <>
          {/* GATE_IN/OUT events are sourced from TOS (see sim cargo.ts). */}
          <div><SourceBadge source="Terminal API (TOS)" /></div>
          <CalciteTable caption="gate ops">
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Gate" />
              <CalciteTableHeader heading="Terminal" />
              <CalciteTableHeader heading="Queue" />
              <CalciteTableHeader heading="Avg txn (min)" />
              <CalciteTableHeader heading="Open lanes" />
            </CalciteTableRow>
            {rows.map((g) => (
              // Clicking a gate row selects it — the forecast AND the gate-out
              // table below both follow this one selection.
              <CalciteTableRow
                key={g.gateId}
                data-asset={g.gateId}
                onClick={() => setGate(g.gateId)}
                style={{
                  cursor: 'pointer',
                  ...(g.gateId === gate ? { background: tokens.color.bgElevated } : {}),
                }}
              >
                <CalciteTableCell>
                  <strong style={{ color: g.gateId === gate ? tokens.color.brand : undefined }}>
                    {g.gateId}
                  </strong>
                </CalciteTableCell>
                <CalciteTableCell>{g.terminalId}</CalciteTableCell>
                <CalciteTableCell>
                  <CalciteChip value={String(g.queueLength)} style={{ ['--calcite-chip-text-color' as never]: qColor(g.queueLength) }}>
                    {g.queueLength}
                  </CalciteChip>
                </CalciteTableCell>
                <CalciteTableCell>{g.avgTxnTimeMin}</CalciteTableCell>
                <CalciteTableCell>{(g as GateOpsDTO & { openLanes?: number }).openLanes ?? '—'}</CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>

          <div style={{ marginTop: 12 }}>
            <CalciteSelect
              label="Selected gate"
              onCalciteSelectChange={(e) => setGate((e.target as unknown as { value: string }).value)}
            >
              {rows.map((g) => (
                <CalciteOption key={g.gateId} value={g.gateId} selected={g.gateId === gate}>
                  {g.gateId}
                </CalciteOption>
              ))}
            </CalciteSelect>
            {forecast.data && (
              <div style={{ marginTop: 8 }}>
                {/* WHICH engine produced this curve (UC2-015). The Python model,
                    or the deterministic fallback — never ambiguous. Stop the
                    ai-gate-queue container and this flips to HEURISTIC with the
                    reason, which is how the wire proves it is real. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: 13 }}>Predicted queue (30–120 min):</strong>
                  {forecast.data.source === 'MODEL' ? (
                    <CalciteChip scale="s" icon="lightning" value="MODEL"
                      title={`Served by the gate-queue-forecaster model service${forecast.data.modelVersion ? ` v${forecast.data.modelVersion}` : ''}`}
                      style={{ ['--calcite-chip-text-color' as never]: tokens.kpi.better }}>
                      MODEL{forecast.data.modelVersion ? ` v${forecast.data.modelVersion}` : ''}
                    </CalciteChip>
                  ) : (
                    <CalciteChip scale="s" icon="exclamation-mark-triangle" value="HEURISTIC"
                      title={forecast.data.fallbackReason
                        ?? 'The model service did not answer; this is the deterministic fallback curve.'}
                      style={{ ['--calcite-chip-text-color' as never]: tokens.severity.WARN }}>
                      HEURISTIC — model unavailable
                    </CalciteChip>
                  )}
                </div>
                {forecast.data.source !== 'MODEL' && forecast.data.fallbackReason && (
                  <p style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '0 0 6px' }}>
                    {forecast.data.fallbackReason} The curve below is a deterministic
                    arrival/service model, not a trained forecast.
                  </p>
                )}
                <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 60, marginTop: 6 }}>
                  {forecast.data.curve.map((c) => (
                    <div
                      key={c.ts}
                      title={`${new Date(c.ts).toLocaleTimeString()}: ${c.predictedQueue}`}
                      style={{
                        width: 18,
                        height: Math.max(4, c.predictedQueue * 3),
                        background: qColor(c.predictedQueue),
                        borderRadius: 2,
                      }}
                    />
                  ))}
                </div>
                {forecast.data.recommendedDeferralWindows.length > 0 && (
                  <p style={{ fontSize: 12, color: tokens.congestion.AMBER, marginTop: 6 }}>
                    ⚠ {forecast.data.recommendedDeferralWindows.length} recommended deferred-arrival window(s)
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Lifecycle: the pickup ticket that sends a truck for a container. */}
          <PinTicketSection gate={gate} />

          {/* Lifecycle: the truck transactions at this terminal's gate. */}
          <EirSection gate={gate} />

          {/* Lifecycle final step: the containers that actually left on a truck. */}
          <GateOutSection gate={gate} />

          {/* The UC-III return leg — recorded crossings, not filed documents.
              Gate-scoped filtering is deliberately NOT applied: core.gate_event
              carries a terminal gate code (IGTK01), not the dashboard's
              terminal-plus-number id, and guessing a mapping would silently hide
              crossings under the wrong gate. */}
          <GateCrossingSection />
        </>
      )}
    </Panel>
  );
}
