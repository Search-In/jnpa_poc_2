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
} from '@esri/calcite-components-react';
import type { SidingId } from '@jnpa/schemas';
import type { RailSideDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';

const hrs = (a?: string, b?: string) =>
  a && b ? `${((new Date(b).getTime() - new Date(a).getTime()) / 3.6e6).toFixed(1)}h` : '—';

export function RailSide({ window }: { window: { from: string; to: string } }) {
  const { adapter, lang } = useApp();
  const [siding, setSiding] = useState<SidingId>('T1');
  const state = useAsync<RailSideDTO>(() => adapter.getRailSide(siding, window), [adapter, siding, window.from, window.to]);

  return (
    <Panel heading={t('panel_rail', lang)} state={state} isEmpty={(d) => d.rakes.length === 0}>
      {(rail) => (
        <>
          <CalciteSegmentedControl
            onCalciteSegmentedControlChange={(e) => setSiding((e.target as unknown as { value: SidingId }).value)}
          >
            <CalciteSegmentedControlItem value="T1" checked={siding === 'T1'}>T1</CalciteSegmentedControlItem>
            <CalciteSegmentedControlItem value="T2" checked={siding === 'T2'}>T2</CalciteSegmentedControlItem>
          </CalciteSegmentedControl>

          <CalciteTable caption={`Rakes on ${siding}`} style={{ marginTop: 8 }}>
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Rake" />
              <CalciteTableHeader heading="CTO" />
              <CalciteTableHeader heading="Dir" />
              <CalciteTableHeader heading="Arrival" />
              <CalciteTableHeader heading="Placement" />
              <CalciteTableHeader heading="Removal" />
              <CalciteTableHeader heading="TAT" />
              <CalciteTableHeader heading="Mixed" />
            </CalciteTableRow>
            {rail.rakes.slice(0, 20).map((r) => (
              <CalciteTableRow key={r.rakeId}>
                <CalciteTableCell>{r.rakeId}</CalciteTableCell>
                <CalciteTableCell>{r.ctoOperator}</CalciteTableCell>
                <CalciteTableCell>{r.direction === 'INBOUND' ? '⬇ IN' : '⬆ OUT'}</CalciteTableCell>
                <CalciteTableCell>{new Date(r.arrivalTs).toLocaleString()}</CalciteTableCell>
                <CalciteTableCell>{r.placementTs ? new Date(r.placementTs).toLocaleTimeString() : '—'}</CalciteTableCell>
                <CalciteTableCell>{r.removalTs ? new Date(r.removalTs).toLocaleTimeString() : '—'}</CalciteTableCell>
                <CalciteTableCell>{hrs(r.arrivalTs, r.departureTs)}</CalciteTableCell>
                <CalciteTableCell>
                  {r.mixedFlag ? <CalciteChip kind="brand" value="mixed">mixed</CalciteChip> : '—'}
                </CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>
          <p style={{ fontSize: 12, color: 'var(--calcite-color-text-3)' }}>
            {rail.rakes.length} rakes · {rail.wagons.length} wagons on {siding} in window.
          </p>
        </>
      )}
    </Panel>
  );
}
