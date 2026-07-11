/**
 * Container pendency board (prompt §10) — CFS/ICD-wise pendency from the adapter,
 * the spatial view is the map's pendency choropleth (A.1). This is the tabular
 * read-out hung off the map.
 */
import { useState } from 'react';
import { CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip, CalciteSelect, CalciteOption, CalciteButton, CalciteIcon } from '@esri/calcite-components-react';
import type { PendencyDTO } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { RULE_BY_ID } from '../workflow/workflowStore.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';

const sev = (n: number) => (n > 150 ? tokens.congestion.RED : n > 50 ? tokens.congestion.AMBER : tokens.congestion.GREEN);

/**
 * Yard Planning / Optimization info sections — reuse the existing automation
 * rules (workflowStore) as the step-by-step content. WF-PENDENCY governs
 * yard/CFS dwell planning; WF-RAKE-ETA covers rake-driven siding/yard placement
 * re-planning (UC2-R5: rake visibility for terminal-operator yard planning);
 * WF-REEFER-PLUG notifies the 'Yard Planner' role (yard plug allocation +
 * evacuation prioritisation).
 */
const YARD_INFO_SECTIONS: Array<{ title: string; ruleId: string }> = [
  { title: 'Yard Planning', ruleId: 'WF-PENDENCY' },
  { title: 'Rake-Based Siding Planning', ruleId: 'WF-RAKE-ETA' },
  { title: 'Yard Operation Optimization', ruleId: 'WF-REEFER-PLUG' },
];

/**
 * Slide-over info drawer (reuses the Container Movements timeline / Integration
 * Console pattern). Renders each section as a Step 1 ↓ Step 2 ↓ … breakdown
 * built from the reused rule `actions` — no invented content.
 */
function YardInfoDrawer({ onClose }: { onClose: () => void }) {
  return (
    <>
      <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.35)', zIndex: 1100 }} aria-hidden />
      <aside
        role="dialog"
        aria-label="Yard planning and optimization"
        style={{
          position: 'fixed', top: 0, right: 0, bottom: 0, width: 'min(440px, 100vw)',
          background: tokens.color.bgPanel, borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-12px 0 40px rgba(12,20,33,0.28)', zIndex: 1101, display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '12px 14px', background: tokens.color.brand, color: '#fff' }}>
          <CalciteIcon icon="information" scale="s" />
          <strong style={{ fontSize: 14 }}>Yard Planning &amp; Optimization</strong>
          <button onClick={onClose} aria-label="Close" style={{ marginLeft: 'auto', background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>
        <div style={{ padding: '12px 14px', overflowY: 'auto', flex: 1 }}>
          {YARD_INFO_SECTIONS.map((sec, si) => {
            const rule = RULE_BY_ID[sec.ruleId];
            const steps = rule ? rule.actions.split(/;\s*/).filter(Boolean) : [];
            return (
              <div key={sec.ruleId} style={{ marginBottom: si < YARD_INFO_SECTIONS.length - 1 ? 22 : 0 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: tokens.color.text }}>{sec.title}</div>
                {rule && (
                  <div style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '2px 0 10px' }}>
                    {rule.when} — {rule.then}
                  </div>
                )}
                {steps.map((step, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: tokens.color.brand }}>Step {i + 1}</span>
                      <span style={{ fontSize: 12.5, color: tokens.color.text }}>{step}</span>
                    </div>
                    {i < steps.length - 1 && <div style={{ color: tokens.color.textMuted, fontSize: 14, margin: '2px 0 2px 8px' }}>↓</div>}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </aside>
    </>
  );
}

export function Pendency() {
  const { adapter, lang } = useApp();
  const simDep = useSimDep();
  // Shipping-document filter (same pattern as Empty Pool). Scopes the rows to
  // facilities whose predominant shipping-document type is the selected one
  // (IAL/EAL/D-O), using the per-facility classification the adapter derives.
  const [docFilter, setDocFilter] = useState<string>('ALL');
  // Yard planning & optimization info drawer (ⓘ), mirroring the Container
  // Movements timeline info button.
  const [infoOpen, setInfoOpen] = useState(false);
  const state = useAsync<PendencyDTO[]>(() => adapter.getPendency(true), [adapter, simDep]);
  return (
    <>
    <Panel heading={t('panel_pendency', lang)} state={state} isEmpty={(d) => d.length === 0}>
      {(rows) => (
        <>
          <ImportExportToolbar
            data={rows.map((r) => ({
              'Facility': r.facilityId,
              'Facility Name': r.facilityName,
              'Type': r.facilityType,
              'Pendency': r.pendency,
              'Doc Type': r.primaryDoc ?? '',
            }))}
            filename="pendency.csv"
          />
          {/* Yard-planning action (left) and the data-source note (right) share one
              aligned row, so the two info indicators are separated and no longer
              stack/conflict. Derived KPI folded from terminal gate/yard (TOS) events. */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', margin: '2px 0 10px' }}>
            <CalciteButton
              scale="s"
              appearance="outline"
              iconStart="information"
              title="How yard planning & optimization works"
              onClick={() => setInfoOpen(true)}
            >
              Yard planning info
            </CalciteButton>
            <SourceBadge source="Terminal API (TOS)" />
          </div>
          <CalciteSelect
            label="Document filter"
            onCalciteSelectChange={(e) => setDocFilter((e.target as unknown as { value: string }).value)}
          >
            <CalciteOption value="ALL" selected={docFilter === 'ALL'}>All</CalciteOption>
            <CalciteOption value="IAL" selected={docFilter === 'IAL'}>IAL</CalciteOption>
            <CalciteOption value="EAL" selected={docFilter === 'EAL'}>EAL</CalciteOption>
            <CalciteOption value="DO" selected={docFilter === 'DO'}>D/O</CalciteOption>
          </CalciteSelect>
          <CalciteTable caption="pendency by facility">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Facility" />
            <CalciteTableHeader heading="Type" />
            <CalciteTableHeader heading="Pendency" />
          </CalciteTableRow>
          {[...rows]
            .filter((r) => docFilter === 'ALL' || r.primaryDoc === docFilter)
            .sort((a, b) => b.pendency - a.pendency)
            .map((r) => (
              <CalciteTableRow key={r.facilityId} data-asset={r.facilityId}>
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
        </>
      )}
    </Panel>
    {infoOpen && <YardInfoDrawer onClose={() => setInfoOpen(false)} />}
    </>
  );
}
