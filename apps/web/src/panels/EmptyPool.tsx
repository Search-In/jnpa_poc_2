/**
 * Empty-container visibility (prompt §10) — line/depot availability vs projected
 * demand, for CFS planning. Surplus/deficit highlighted.
 */
import { CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip } from '@esri/calcite-components-react';
import type { EmptyPoolDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';

export function EmptyPool() {
  const { adapter, lang } = useApp();
  const state = useAsync<EmptyPoolDTO>(() => adapter.getEmptyPool(), [adapter]);
  return (
    <Panel heading={t('panel_empty', lang)} state={state} isEmpty={(d) => d.pools.length === 0}>
      {(dto) => (
        <CalciteTable caption="empty pool">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Line" />
            <CalciteTableHeader heading="Depot" />
            <CalciteTableHeader heading="Available" />
            <CalciteTableHeader heading="Demand" />
            <CalciteTableHeader heading="Balance" />
          </CalciteTableRow>
          {dto.pools.map((p) => {
            const balance = p.availableQty - p.projectedDemandQty;
            return (
              <CalciteTableRow key={`${p.lineId}-${p.depotId}`}>
                <CalciteTableCell>{p.lineId}</CalciteTableCell>
                <CalciteTableCell>{p.depotId}</CalciteTableCell>
                <CalciteTableCell>{p.availableQty}</CalciteTableCell>
                <CalciteTableCell>{p.projectedDemandQty}</CalciteTableCell>
                <CalciteTableCell>
                  <CalciteChip
                    value={String(balance)}
                    style={{ ['--calcite-chip-text-color' as never]: balance >= 0 ? tokens.kpi.better : tokens.kpi.worse }}
                  >
                    {balance >= 0 ? `+${balance}` : balance}
                  </CalciteChip>
                </CalciteTableCell>
              </CalciteTableRow>
            );
          })}
        </CalciteTable>
      )}
    </Panel>
  );
}
