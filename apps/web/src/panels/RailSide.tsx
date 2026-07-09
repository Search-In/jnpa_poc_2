/**
 * 360° rail-side panel for T1/T2 (prompt §10): incoming/outgoing trains,
 * container details, placement/removal time, next-24-hr forecast, and ITRHO
 * mixed-container movements. Siding switch toggles T1/T2.
 */
import { useState } from 'react';
import {
  CalciteSegmentedControl,
  CalciteSegmentedControlItem,
  CalciteTable,
  CalciteTableHeader,
  CalciteTableRow,
  CalciteTableCell,
  CalciteChip,
  CalciteButton,
} from '@esri/calcite-components-react';
import type { SidingId } from '@jnpa/schemas';
import type { RailSideDTO, RakeForecastDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { t } from '../i18n/strings.js';
import { useSimDep } from '../sim/useSimStore.js';

const hrs = (a?: string, b?: string) =>
  a && b ? `${((new Date(b).getTime() - new Date(a).getTime()) / 3.6e6).toFixed(1)}h` : '—';

const hm = (iso?: string) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');

export function RailSide({ window }: { window: { from: string; to: string } }) {
  const { adapter, lang } = useApp();
  const [siding, setSiding] = useState<SidingId>('T1');
  // Rake whose wagon composition is expanded below the table (null = collapsed).
  const [openRake, setOpenRake] = useState<string | null>(null);
  const simDep = useSimDep();
  const state = useAsync<RailSideDTO>(() => adapter.getRailSide(siding, window), [adapter, siding, window.from, window.to, simDep]);
  // Next-24h forecast: project ETA placement/removal/departure for every rake on
  // this siding that has not yet departed (UC2-R5 "next-24-hr forecast"). Backed
  // by adapter.getRakeForecast so it moves with the sim, not a static caption.
  const forecast = useAsync<RakeForecastDTO[]>(
    async () => {
      const rail = await adapter.getRailSide(siding, window);
      const pending = rail.rakes.filter((r) => !r.departureTs).slice(0, 6);
      return Promise.all(pending.map((r) => adapter.getRakeForecast(r.rakeId)));
    },
    [adapter, siding, window.from, window.to, simDep],
  );

  return (
    <Panel heading={t('panel_rail', lang)} state={state} isEmpty={(d) => d.rakes.length === 0}>
      {(rail) => (
        <>
          <ImportExportToolbar data={rail} filename="rail-side.json" />
          {/* RAIL_IN/OUT events are sourced from FOIS / CTO (see sim cargo.ts). */}
          <div><SourceBadge source="FOIS" /></div>
          <CalciteSegmentedControl
            onCalciteSegmentedControlChange={(e) => setSiding((e.target as unknown as { value: SidingId }).value)}
          >
            <CalciteSegmentedControlItem value="T1" checked={siding === 'T1'}>T1</CalciteSegmentedControlItem>
            <CalciteSegmentedControlItem value="T2" checked={siding === 'T2'}>T2</CalciteSegmentedControlItem>
          </CalciteSegmentedControl>

          {(() => {
            const sim = rail as RailSideDTO & { simInbound?: number; simPlaced?: number };
            if (!sim.simInbound && !sim.simPlaced) return null;
            return (
              <p style={{ fontSize: 12, marginTop: 8, color: 'var(--calcite-color-brand)' }}>
                ⚡ Simulator: {sim.simInbound ?? 0} inbound rake(s) queued · {sim.simPlaced ?? 0} placed on {siding}
              </p>
            );
          })()}

          {/* Next-24h forecast (UC2-R5): ETA placement / removal / departure for
              rakes still in the yard, projected from arrival + median dwells. */}
          {forecast.data && forecast.data.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--calcite-color-text-2)', marginBottom: 4 }}>
                Next-24h forecast · {forecast.data.length} rake(s)
              </div>
              <CalciteTable caption={`Forecast for ${siding}`} scale="s">
                <CalciteTableRow slot="table-header">
                  <CalciteTableHeader heading="Rake" />
                  <CalciteTableHeader heading="ETA place" />
                  <CalciteTableHeader heading="ETA remove" />
                  <CalciteTableHeader heading="ETA depart" />
                </CalciteTableRow>
                {forecast.data.map((f) => (
                  <CalciteTableRow key={f.rakeId}>
                    <CalciteTableCell>{f.rakeId}</CalciteTableCell>
                    <CalciteTableCell>{hm(f.etaPlacement)}</CalciteTableCell>
                    <CalciteTableCell>{hm(f.etaRemoval)}</CalciteTableCell>
                    <CalciteTableCell>{hm(f.etaDeparture)}</CalciteTableCell>
                  </CalciteTableRow>
                ))}
              </CalciteTable>
            </div>
          )}

          <CalciteTable caption={`Rakes on ${siding}`} style={{ marginTop: 8 }}>
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Rake" />
              <CalciteTableHeader heading="Train" />
              <CalciteTableHeader heading="CTO" />
              <CalciteTableHeader heading="FOIS" />
              <CalciteTableHeader heading="Dir" />
              <CalciteTableHeader heading="Arrival" />
              <CalciteTableHeader heading="Placement" />
              <CalciteTableHeader heading="Removal" />
              <CalciteTableHeader heading="TAT" />
              <CalciteTableHeader heading="Wagons" />
              <CalciteTableHeader heading="Mixed" />
            </CalciteTableRow>
            {rail.rakes.slice(0, 20).map((r) => (
              <CalciteTableRow key={r.rakeId}>
                <CalciteTableCell>{r.rakeId}</CalciteTableCell>
                <CalciteTableCell>{r.trainNo}</CalciteTableCell>
                <CalciteTableCell>{r.ctoOperator}</CalciteTableCell>
                <CalciteTableCell>{r.foisRef}</CalciteTableCell>
                <CalciteTableCell>{r.direction === 'INBOUND' ? '⬇ IN' : '⬆ OUT'}</CalciteTableCell>
                <CalciteTableCell>{new Date(r.arrivalTs).toLocaleString()}</CalciteTableCell>
                <CalciteTableCell>{r.placementTs ? new Date(r.placementTs).toLocaleTimeString() : '—'}</CalciteTableCell>
                <CalciteTableCell>{r.removalTs ? new Date(r.removalTs).toLocaleTimeString() : '—'}</CalciteTableCell>
                <CalciteTableCell>{hrs(r.arrivalTs, r.departureTs)}</CalciteTableCell>
                <CalciteTableCell>
                  <CalciteButton
                    scale="s"
                    appearance="transparent"
                    kind="brand"
                    iconStart="table"
                    title="View wagon composition"
                    onClick={() => setOpenRake((cur) => (cur === r.rakeId ? null : r.rakeId))}
                  >
                    {r.wagonCount}
                  </CalciteButton>
                </CalciteTableCell>
                <CalciteTableCell>
                  {r.mixedFlag ? <CalciteChip kind="brand" value="mixed">mixed</CalciteChip> : '—'}
                </CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>

          {/* Wagon composition for the expanded rake (position → containers),
              from the DTO's wagons list (FOIS wagon composition, UC2-R5). */}
          {openRake && (() => {
            const ws = rail.wagons.filter((w) => w.rakeId === openRake).slice().sort((a, b) => a.position - b.position);
            return (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--calcite-color-text-2)', marginBottom: 4 }}>
                  Wagon composition · {openRake} · {ws.length} wagons
                </div>
                <CalciteTable caption={`Wagons of ${openRake}`} scale="s">
                  <CalciteTableRow slot="table-header">
                    <CalciteTableHeader heading="Pos" />
                    <CalciteTableHeader heading="Wagon" />
                    <CalciteTableHeader heading="Containers" />
                    <CalciteTableHeader heading="Container nos" />
                  </CalciteTableRow>
                  {ws.map((w) => (
                    <CalciteTableRow key={w.wagonId}>
                      <CalciteTableCell>{w.position}</CalciteTableCell>
                      <CalciteTableCell>{w.wagonId}</CalciteTableCell>
                      <CalciteTableCell>{w.containerNos.length}</CalciteTableCell>
                      <CalciteTableCell>{w.containerNos.join(', ') || '—'}</CalciteTableCell>
                    </CalciteTableRow>
                  ))}
                </CalciteTable>
              </div>
            );
          })()}
          <p style={{ fontSize: 12, color: 'var(--calcite-color-text-3)' }}>
            {rail.rakes.length} rakes · {rail.wagons.length} wagons on {siding} in window.
          </p>
        </>
      )}
    </Panel>
  );
}
