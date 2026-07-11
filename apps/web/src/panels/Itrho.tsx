/**
 * ITRHO — Inter-Terminal Road/Rail Handover legs (UC2-R5). JNPT's terminals are
 * split (BMCT sits ~5.5 km SW of the NSICT/NSIGT/GTI cluster), so trans-shipment
 * and mixed-rake boxes shuttle between terminals; this panel is the tabular
 * readout of those legs — from→to, mode, out/in timestamps and per-leg TAT — that
 * backs the Inter-Terminal TAT KPI and the map's ITRHO flow line.
 */
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
} from '@esri/calcite-components-react';
import type { ITRHOMovement } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { useSimDep } from '../sim/useSimStore.js';
import { tokens } from '../theme/tokens.js';

const hm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
/** Per-leg TAT = received − handed-out (hours), when both stamps exist. */
const tat = (out?: string, inn?: string) =>
  out && inn ? `${((new Date(inn).getTime() - new Date(out).getTime()) / 3.6e6).toFixed(1)}h` : '—';

type StageStatus = 'Done' | 'Current' | 'Pending';
const STAGE_COLOR: Record<StageStatus, string> = {
  Done: tokens.congestion.GREEN,
  Current: tokens.color.brand,
  Pending: tokens.color.textMuted,
};

/**
 * The ITRHO leg workflow is three timestamp-driven stages (reusing the DTO's
 * requested/out/in stamps): Requested → Handed Out → Received. A stage is Done
 * once its timestamp exists; the first stamp-less stage is the Current (active)
 * stage; later stages are Pending — so a leg only reads fully Done once it has
 * actually been received, never sooner.
 */
function legStages(m: ITRHOMovement): Array<{ label: string; status: StageStatus }> {
  const stamps = [m.requestedTs, m.outTs, m.inTs];
  const labels = ['Requested', 'Handed Out', 'Received'];
  const currentIdx = stamps.findIndex((ts) => !ts);
  return labels.map((label, i) => ({
    label,
    status: stamps[i] ? 'Done' : i === currentIdx ? 'Current' : 'Pending',
  }));
}

export function Itrho({ window }: { window: { from: string; to: string } }) {
  const { adapter } = useApp();
  const simDep = useSimDep();
  const state = useAsync<ITRHOMovement[]>(
    () => adapter.getITRHO(window),
    [adapter, window.from, window.to, simDep],
  );

  return (
    <Panel heading="ITRHO · Inter-Terminal Transfers" state={state} isEmpty={(d) => d.length === 0}>
      {(legs) => {
        const inTransit = legs.filter((m) => m.outTs && !m.inTs).length;
        const done = legs.filter((m) => m.inTs).length;
        return (
          <>
            <ImportExportToolbar data={legs} filename="itrho.csv" />
            {/* ITRHO_OUT/IN events are sourced from TOS (see sim cargo.ts). */}
            <div><SourceBadge source="Terminal API (TOS)" /></div>
            <p style={{ fontSize: 12, color: 'var(--calcite-color-text-3)' }}>
              {legs.length} legs in window · {inTransit} in-transit · {done} completed
            </p>
            <CalciteTable caption="ITRHO legs">
              <CalciteTableRow slot="table-header">
                <CalciteTableHeader heading="Container" />
                <CalciteTableHeader heading="Route" />
                <CalciteTableHeader heading="Mode" />
                <CalciteTableHeader heading="Out" />
                <CalciteTableHeader heading="In" />
                <CalciteTableHeader heading="TAT" />
                <CalciteTableHeader heading="Status" />
              </CalciteTableRow>
              {legs.slice(0, 50).map((m) => (
                <CalciteTableRow key={m.itrhoId}>
                  <CalciteTableCell>{m.containerNo}</CalciteTableCell>
                  <CalciteTableCell>{m.fromTerminalId} → {m.toTerminalId}</CalciteTableCell>
                  <CalciteTableCell>{m.mode}</CalciteTableCell>
                  <CalciteTableCell>{hm(m.outTs)}</CalciteTableCell>
                  <CalciteTableCell>{hm(m.inTs)}</CalciteTableCell>
                  <CalciteTableCell>{tat(m.outTs, m.inTs)}</CalciteTableCell>
                  <CalciteTableCell>
                    {/* Full leg workflow, each stage coloured by its status. */}
                    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                      {legStages(m).map((s, i) => (
                        <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                          {i > 0 && <span style={{ color: tokens.color.textMuted }}>→</span>}
                          <span
                            title={s.status}
                            style={{ color: STAGE_COLOR[s.status], fontWeight: s.status === 'Current' ? 700 : 500, fontSize: 12 }}
                          >
                            {s.label}
                          </span>
                        </span>
                      ))}
                    </span>
                  </CalciteTableCell>
                </CalciteTableRow>
              ))}
            </CalciteTable>
          </>
        );
      }}
    </Panel>
  );
}
