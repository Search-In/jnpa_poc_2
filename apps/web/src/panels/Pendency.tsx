/**
 * Container pendency board (prompt §10) — CFS/ICD-wise pendency from the adapter,
 * the spatial view is the map's pendency choropleth (A.1). This is the tabular
 * read-out hung off the map.
 */
import { CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip } from '@esri/calcite-components-react';
import type { PendencyDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

const sev = (n: number) => (n > 150 ? tokens.congestion.RED : n > 50 ? tokens.congestion.AMBER : tokens.congestion.GREEN);

export function Pendency() {
  const { adapter, lang } = useApp();
  const simDep = useSimDep();
  const state = useAsync<PendencyDTO[]>(() => adapter.getPendency(true), [adapter, simDep]);
  return (
    <Panel heading={t('panel_pendency', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(rows) => (
        <CalciteTable caption="pendency by facility">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Facility" />
            <CalciteTableHeader heading="Type" />
            <CalciteTableHeader heading="Pendency" />
          </CalciteTableRow>
          {[...rows]
            .sort((a, b) => b.pendency - a.pendency)
            .map((r) => (
              <CalciteTableRow key={r.facilityId}>
                <CalciteTableCell>{r.facilityName}</CalciteTableCell>
                <CalciteTableCell>{r.facilityType}</CalciteTableCell>
                <CalciteTableCell>
                  <CalciteChip value={String(r.pendency)} style={{ ['--calcite-chip-text-color' as never]: sev(r.pendency) }}>
                    {r.pendency}
                  </CalciteChip>
                </CalciteTableCell>
              </CalciteTableRow>
            ))}
        </CalciteTable>
      )}
    </Panel>
  );
}
