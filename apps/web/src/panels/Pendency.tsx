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
import { workflowStore, RULE_BY_ID, type WorkflowRun } from '../workflow/workflowStore.js';
import { useWorkflowStore } from '../workflow/useWorkflowStore.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';
import { useCargoRefresh } from '../state/cargoRefreshStore.js';

const sev = (n: number) => (n > 150 ? tokens.congestion.RED : n > 50 ? tokens.congestion.AMBER : tokens.congestion.GREEN);

/**
 * Yard Planning / Optimization workflow sections — each maps to a rule in the
 * existing §8.3 automation engine (workflowStore). WF-PENDENCY governs yard/CFS
 * dwell planning; WF-RAKE-ETA covers rake-driven siding/yard re-planning;
 * WF-REEFER-PLUG covers reefer plug allocation + evacuation prioritisation.
 * `liveTrigger` is null when the panel has no live data for that rule's trigger
 * (rake ETA-slip and reefer-plug telemetry are NOT exposed by the read DTOs — see
 * the task report), so no run is invented for those; the operator can still act
 * on runs the What-If scenarios fire into the shared ledger.
 */
const YARD_INFO_SECTIONS: Array<{ title: string; ruleId: string }> = [
  { title: 'Yard Planning', ruleId: 'WF-PENDENCY' },
  { title: 'Rake-Based Siding Planning', ruleId: 'WF-RAKE-ETA' },
  { title: 'Yard Operation Optimization', ruleId: 'WF-REEFER-PLUG' },
];

/** Map the engine's real run status → the workflow display status + colour.
 *  No run yet = Pending; awaiting-approval = Current; fired/approved = Completed;
 *  dismissed = Blocked. (The engine has no Failed state — its actions are simulated
 *  orchestrations, so there is no real backend failure to surface.) */
function displayStatus(run?: WorkflowRun): { label: string; color: string } {
  switch (run?.status) {
    case 'PENDING_APPROVAL': return { label: 'Current', color: tokens.congestion.AMBER };
    case 'FIRED':
    case 'APPROVED': return { label: 'Completed', color: tokens.congestion.GREEN };
    case 'DISMISSED': return { label: 'Blocked', color: tokens.congestion.RED };
    default: return { label: 'Pending', color: tokens.color.textMuted };
  }
}

/**
 * Slide-over workflow drawer (reuses the Container Movements timeline / Integration
 * Console overlay pattern). Each section is a live workflow: its status comes from
 * the shared workflow ledger (useWorkflowStore), its steps from the rule (not
 * hardcoded), and its actions drive the existing engine — Run (fire the rule with a
 * live-data trigger, WF-PENDENCY only) and Approve / Dismiss for a pending run.
 */
function YardInfoDrawer({ rows, onClose }: { rows: PendencyDTO[]; onClose: () => void }) {
  const { mode, runs } = useWorkflowStore();
  // Live WF-PENDENCY trigger: facilities above the existing pendency-severity
  // threshold (reuses `sev`, no new hardcoded number), worst first.
  const breaching = [...rows]
    .filter((r) => sev(r.pendency) !== tokens.congestion.GREEN)
    .sort((a, b) => b.pendency - a.pendency);
  const liveTriggerFor = (ruleId: string): { trigger: string; location: string } | null => {
    if (ruleId === 'WF-PENDENCY' && breaching[0]) {
      const w = breaching[0];
      return {
        trigger: `Pendency breach: ${w.facilityName} = ${w.pendency}${breaching.length > 1 ? ` (+${breaching.length - 1} more)` : ''}`,
        location: w.facilityId,
      };
    }
    // WF-RAKE-ETA (ETA-slip) and WF-REEFER-PLUG (plug telemetry) have no live
    // trigger in the read DTOs — do not fabricate one.
    return null;
  };

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
          <CalciteChip scale="s" value={mode} title="Workflow engine mode" style={{ marginLeft: 'auto' }}>{mode}</CalciteChip>
          <button onClick={onClose} aria-label="Close" style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex' }}>
            <CalciteIcon icon="x" scale="s" />
          </button>
        </div>
        <div style={{ padding: '12px 14px', overflowY: 'auto', flex: 1 }}>
          {YARD_INFO_SECTIONS.map((sec, si) => {
            const rule = RULE_BY_ID[sec.ruleId];
            const steps = rule ? rule.actions.split(/;\s*/).filter(Boolean) : [];
            // Latest run for this rule from the shared ledger (real status).
            const latest = runs.find((r) => r.ruleId === sec.ruleId);
            const st = displayStatus(latest);
            const live = liveTriggerFor(sec.ruleId);
            const pending = latest?.status === 'PENDING_APPROVAL';
            return (
              <div key={sec.ruleId} style={{ marginBottom: si < YARD_INFO_SECTIONS.length - 1 ? 22 : 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 13, fontWeight: 700, color: tokens.color.text }}>{sec.title}</span>
                  <CalciteChip scale="s" value={st.label} title="Workflow status" style={{ marginLeft: 'auto', ['--calcite-chip-text-color' as never]: st.color }}>
                    {st.label}
                  </CalciteChip>
                </div>
                {rule && (
                  <div style={{ fontSize: 11.5, color: tokens.color.textMuted, margin: '2px 0 8px' }}>
                    {rule.when} — {rule.then}
                  </div>
                )}
                {steps.map((step, i) => (
                  <div key={i}>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                      <span style={{ flexShrink: 0, fontSize: 11, fontWeight: 700, color: st.color }}>Step {i + 1}</span>
                      <span style={{ fontSize: 12.5, color: tokens.color.text }}>{step}</span>
                    </div>
                    {i < steps.length - 1 && <div style={{ color: tokens.color.textMuted, fontSize: 14, margin: '2px 0 2px 8px' }}>↓</div>}
                  </div>
                ))}

                {/* Live trigger + actions. */}
                <div style={{ marginTop: 8 }}>
                  {live && (
                    <div style={{ fontSize: 11.5, color: tokens.color.text, marginBottom: 6 }}>
                      <strong>Live trigger:</strong> {live.trigger}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {pending && latest ? (
                      <>
                        <CalciteButton scale="s" kind="brand" iconStart="check" onClick={() => workflowStore.approveRun(latest.id)}>Approve</CalciteButton>
                        <CalciteButton scale="s" appearance="outline" kind="neutral" iconStart="x" onClick={() => workflowStore.dismissRun(latest.id)}>Dismiss</CalciteButton>
                      </>
                    ) : live ? (
                      <CalciteButton
                        scale="s"
                        iconStart="play"
                        title={mode === 'AUTO' ? 'Run now (AUTO → fires immediately)' : 'Propose (ADVISORY → awaits approval)'}
                        onClick={() => workflowStore.fireRule(sec.ruleId, { trigger: live.trigger, location: live.location })}
                      >
                        Run workflow
                      </CalciteButton>
                    ) : (
                      <span style={{ fontSize: 11, color: tokens.color.textMuted }}>
                        No live auto-trigger in the current data model — actions appear here when a What-If scenario fires this rule.
                      </span>
                    )}
                  </div>
                </div>
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
  // Refetch after a cargo write (discharge/release may change yard assignment).
  const cargoRev = useCargoRefresh();
  const state = useAsync<PendencyDTO[]>(() => adapter.getPendency(true), [adapter, simDep, cargoRev]);
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
          {infoOpen && <YardInfoDrawer rows={rows} onClose={() => setInfoOpen(false)} />}
        </>
      )}
    </Panel>
    </>
  );
}
