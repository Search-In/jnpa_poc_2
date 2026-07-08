/**
 * ITRHO — Inter-Terminal Road/Rail Handover legs (UC2-R5). JNPT's terminals are
 * split (BMCT sits ~5.5 km SW of the NSICT/NSIGT/GTI cluster), so trans-shipment
 * and mixed-rake boxes shuttle between terminals; this panel is the tabular
 * readout of those legs — from→to, mode, out/in timestamps and per-leg TAT — that
 * backs the Inter-Terminal TAT KPI and the map's ITRHO flow line.
 */
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip,
} from '@esri/calcite-components-react';
import type { ITRHOMovement } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { useSimDep } from '../sim/useSimStore.js';

const hm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
/** Per-leg TAT = received − handed-out (hours), when both stamps exist. */
const tat = (out?: string, inn?: string) =>
  out && inn ? `${((new Date(inn).getTime() - new Date(out).getTime()) / 3.6e6).toFixed(1)}h` : '—';

function legStatus(m: ITRHOMovement): { label: string; kind: 'brand' | 'neutral' | 'inverse' } {
  if (m.inTs) return { label: 'DONE', kind: 'inverse' };
  if (m.outTs) return { label: 'IN-TRANSIT', kind: 'brand' };
  return { label: 'REQUESTED', kind: 'neutral' };
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
            <ImportExportToolbar data={legs} filename="itrho.json" />
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
              {legs.slice(0, 50).map((m) => {
                const st = legStatus(m);
                return (
                  <CalciteTableRow key={m.itrhoId}>
                    <CalciteTableCell>{m.containerNo}</CalciteTableCell>
                    <CalciteTableCell>{m.fromTerminalId} → {m.toTerminalId}</CalciteTableCell>
                    <CalciteTableCell>{m.mode}</CalciteTableCell>
                    <CalciteTableCell>{hm(m.outTs)}</CalciteTableCell>
                    <CalciteTableCell>{hm(m.inTs)}</CalciteTableCell>
                    <CalciteTableCell>{tat(m.outTs, m.inTs)}</CalciteTableCell>
                    <CalciteTableCell><CalciteChip scale="s" kind={st.kind} value={st.label}>{st.label}</CalciteChip></CalciteTableCell>
                  </CalciteTableRow>
                );
              })}
            </CalciteTable>
          </>
        );
      }}
    </Panel>
  );
}
