/**
 * Gate operations panel (prompt §10) — per-gate queue length + avg transaction
 * time, plus a predicted gate-queue overlay (30–120 min) for a selected gate.
 * The live density heatmap is on the map's Gates layer (A.1).
 */
import { useState } from 'react';
import {
  CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell,
  CalciteSelect, CalciteOption, CalciteChip,
} from '@esri/calcite-components-react';
import type { GateOpsDTO, GateQueueForecastDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

const qColor = (n: number) => (n > 16 ? tokens.congestion.RED : n > 8 ? tokens.congestion.AMBER : tokens.congestion.GREEN);

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
          <ImportExportToolbar data={rows} filename="gate-ops.json" />
          {/* GATE_IN/OUT events are sourced from TOS (see sim cargo.ts). */}
          <div><SourceBadge source="Terminal API (TOS)" /></div>
          <CalciteTable caption="gate ops">
            <CalciteTableRow slot="table-header">
              <CalciteTableHeader heading="Gate" />
              <CalciteTableHeader heading="Terminal" />
              <CalciteTableHeader heading="Queue" />
              <CalciteTableHeader heading="Avg txn (min)" />
            </CalciteTableRow>
            {rows.map((g) => (
              <CalciteTableRow key={g.gateId} data-asset={g.gateId}>
                <CalciteTableCell>{g.gateId}</CalciteTableCell>
                <CalciteTableCell>{g.terminalId}</CalciteTableCell>
                <CalciteTableCell>
                  <CalciteChip value={String(g.queueLength)} style={{ ['--calcite-chip-text-color' as never]: qColor(g.queueLength) }}>
                    {g.queueLength}
                  </CalciteChip>
                </CalciteTableCell>
                <CalciteTableCell>{g.avgTxnTimeMin}</CalciteTableCell>
              </CalciteTableRow>
            ))}
          </CalciteTable>

          <div style={{ marginTop: 12 }}>
            <CalciteSelect
              label="Forecast gate"
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
        </>
      )}
    </Panel>
  );
}
