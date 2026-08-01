/**
 * Gate operations panel (prompt §10) — per-gate queue length + avg transaction
 * time, plus a predicted gate-queue overlay (30–120 min) for a selected gate.
 * The live density heatmap is on the map's Gates layer (A.1).
 */
import { Fragment, useState } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip, CalciteNotice,
  CalciteLoader,
} from '@esri/calcite-components-react';
import type { EirTransaction, GateMovement, GateMovementGate, GateOpsDTO, GateQueueForecastDTO, PinTicket } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { InfoPopover } from '../components/InfoPopover.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

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
  const rows = all.filter((e) => (e.terminal ?? '').toUpperCase().includes(terminal));

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
              ? ` EIRs on file cover: ${[...new Set(all.map((e) => e.terminal).filter(Boolean))].join(', ')}.`
              : ''}
          </div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              {rows.length} gate transaction{rows.length === 1 ? '' : 's'} at {terminal}
            </p>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={rows.map((e) => ({
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
                }))}
                filename={`eir-${terminal.toLowerCase()}.csv`}
              />
            </div>
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
  const rows = all.filter((p) => (p.terminal ?? '').toUpperCase().includes(terminal));

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
              : `No ticket names this terminal. Tickets on file cover: ${[...new Set(all.map((p) => p.terminal).filter(Boolean))].join(', ')}.`}
          </div>
        </CalciteNotice>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              {rows.length} pick-up ticket{rows.length === 1 ? '' : 's'} at {terminal}
            </p>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={rows.map((p) => ({
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
                }))}
                filename={`pin-tickets-${terminal.toLowerCase()}.csv`}
              />
            </div>
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
          <div style={{ display: 'flex', alignItems: 'center', marginBottom: 6 }}>
            <p style={{ fontSize: 12, color: tokens.color.textMuted, margin: 0 }}>
              {rows.length} container{rows.length === 1 ? '' : 's'} gated out through {gate}
            </p>
            <div style={{ marginLeft: 'auto' }}>
              <ImportExportToolbar
                data={rows.map((m) => ({
                  'Container No': m.container_no,
                  'Gate No': m.gate_no,
                  'Gate Pass No': m.gate_pass_no,
                  'Gate Pass Time': m.gate_pass_ts,
                  'Vehicle No': m.vehicle_no,
                  'Delivery Mode': m.delivery_mode,
                  'Status': m.equipment_status,
                  'ISO Code': m.iso_code,
                  'VCN': m.vcn,
                  'Vessel IMO': m.imo_no,
                  'Agent': m.agent_code,
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
    <Panel heading={t('panel_gate', lang)} state={ops} isEmpty={(d) => d.length === 0}>
      {(rows) => (
        <>
          <ImportExportToolbar
            data={rows.map((g) => ({
              'Gate': g.gateId,
              'Terminal': g.terminalId,
              'Queue Length': g.queueLength,
              'Avg Txn Time (min)': g.avgTxnTimeMin,
              'Transactions': g.transactions.length,
            }))}
            filename="gate-ops.csv"
          />
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
                <strong style={{ fontSize: 13 }}>Predicted queue (30–120 min):</strong>
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
        </>
      )}
    </Panel>
  );
}
