/**
 * Customs scanner flagging + damage-assessment status (prompt §10). Shows the
 * live scan queue (flagged → start → clear), drives Scanner TAT visibility.
 */
import { CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip } from '@esri/calcite-components-react';
import type { ScanEvent } from '@jnpa/schemas';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

const resultColor = (r?: string) =>
  r === 'EXAM' ? tokens.severity.CRIT : r === 'HOLD' ? tokens.severity.WARN : tokens.kpi.better;

export function ScanQueue() {
  const { adapter, lang } = useApp();
  const simDep = useSimDep();
  const state = useAsync<ScanEvent[]>(() => adapter.getScanQueue(), [adapter, simDep]);
  return (
    <Panel heading={t('panel_scan', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(scans) => (
        <CalciteTable caption="scan queue">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Container" />
            <CalciteTableHeader heading="Flagged by" />
            <CalciteTableHeader heading="Start" />
            <CalciteTableHeader heading="Result" />
          </CalciteTableRow>
          {scans.slice(0, 25).map((s) => (
            <CalciteTableRow key={s.scanId}>
              <CalciteTableCell>{s.containerNo}</CalciteTableCell>
              <CalciteTableCell>{s.flaggedBy}</CalciteTableCell>
              <CalciteTableCell>{new Date(s.startTs).toLocaleString()}</CalciteTableCell>
              <CalciteTableCell>
                <CalciteChip value={s.result ?? 'PENDING'} style={{ ['--calcite-chip-text-color' as never]: resultColor(s.result) }}>
                  {s.result ?? 'PENDING'}
                </CalciteChip>
              </CalciteTableCell>
            </CalciteTableRow>
          ))}
        </CalciteTable>
      )}
    </Panel>
  );
}
