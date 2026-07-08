/**
 * Empty-container visibility (prompt §10) — line/depot availability vs projected
 * demand, for CFS planning. Surplus/deficit highlighted.
 */
import { useState } from 'react';
import { CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip, CalciteSelect, CalciteOption } from '@esri/calcite-components-react';
import type { EmptyPoolDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

export function EmptyPool() {
  const { adapter, lang } = useApp();
  const simDep = useSimDep();
  // Shipping-document filter (same pattern as Container Movements). Kept
  // non-destructive: EmptyPoolDTO exposes no ShippingDoc.type field yet, so this
  // does not filter rows until that backend data is available.
  const [docFilter, setDocFilter] = useState<string>('ALL');
  const state = useAsync<EmptyPoolDTO>(() => adapter.getEmptyPool(), [adapter, simDep]);
  return (
    <Panel heading={t('panel_empty', lang)} state={state} isEmpty={(d) => d.pools.length === 0}>
      {(dto) => (
        <>
          <ImportExportToolbar data={dto} filename="empty-pool.json" />
          {/* Empty pool = shipping-line depot availability (IAL/EAL, D/O) — UC2-R4. */}
          <div><SourceBadge source="Shipping Line" /></div>
          <CalciteSelect
            label="Document filter"
            onCalciteSelectChange={(e) => setDocFilter((e.target as unknown as { value: string }).value)}
          >
            <CalciteOption value="ALL" selected={docFilter === 'ALL'}>All</CalciteOption>
            <CalciteOption value="IAL" selected={docFilter === 'IAL'}>IAL</CalciteOption>
            <CalciteOption value="EAL" selected={docFilter === 'EAL'}>EAL</CalciteOption>
            <CalciteOption value="DO" selected={docFilter === 'DO'}>D/O</CalciteOption>
          </CalciteSelect>
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
        </>
      )}
    </Panel>
  );
}
