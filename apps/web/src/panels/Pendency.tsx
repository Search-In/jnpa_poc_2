/**
 * Container pendency board (prompt §10) — CFS/ICD-wise pendency from the adapter,
 * the spatial view is the map's pendency choropleth (A.1). This is the tabular
 * read-out hung off the map.
 */
import { useState } from 'react';
import { CalciteBlock, CalciteTable, CalciteTableHeader, CalciteTableRow, CalciteTableCell, CalciteChip, CalciteSelect, CalciteOption, CalciteButton, CalciteIcon } from '@esri/calcite-components-react';
import type { PendencyDTO, TerminalYardStatus } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { Panel } from '../components/Panel.js';
import { ImportExportToolbar } from './ImportExportToolbar.js';
import { SourceBadge } from './SourceBadge.js';
import { workflowStore, RULE_BY_ID, type WorkflowRun } from '../workflow/workflowStore.js';
import { useWorkflowStore } from '../workflow/useWorkflowStore.js';
import { YardBackendPlanning } from './YardBackendPlanning.js';
import { t } from '../i18n/strings.js';
import { tokens } from '../theme/tokens.js';
import { useSimDep } from '../sim/useSimStore.js';
import { useCargoRefresh } from '../state/cargoRefreshStore.js';

const sev = (n: number) => (n > 150 ? tokens.congestion.RED : n > 50 ? tokens.congestion.AMBER : tokens.congestion.GREEN);

/** Postgres numerics arrive as decimal strings — coerce before comparing. */
const asNum = (v?: number | string | null): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
};

/**
 * Yard congestion (WS1 EC-3) — utilisation per terminal against a threshold,
 * with the pendency split that explains it.
 *
 * Detection signal per the edge case: "yard utilisation per block + pendency
 * ledger". The published daily status reports give utilisation per *terminal*
 * (not per block — JNPA do not publish block-level occupancy), plus the ICD vs
 * CFS pendency split. Both are real reported figures, so this section is badged
 * separately from the simulated pendency ledger below it.
 *
 * The cause split is deliberately limited to what the data supports — rail-side
 * (ICD) vs road-side (CFS) evacuation backlog. WS1 also names scanner hold and
 * empties build-up as causes; neither is derivable from this feed, so neither is
 * shown rather than guessed.
 */
const YARD_AMBER = 75;
const YARD_RED = 90;

function YardCongestion() {
  const { adapter } = useApp();
  const state = useAsync<TerminalYardStatus[]>(
    () => (adapter.getTerminalYardStatus
      ? adapter.getTerminalYardStatus()
      : Promise.reject(new Error('The performance API is unavailable in this data mode.'))),
    [adapter],
  );

  const all = state.data ?? [];
  // 'TOTAL' is a port-wide roll-up row, not a terminal — pull it out so the
  // per-terminal list neither double-counts nor sorts it among real terminals.
  const total = all.find((r) => r.terminal_code === 'TOTAL');
  const rows = all
    .filter((r) => r.terminal_code !== 'TOTAL')
    .sort((a, b) => (asNum(b.yard_occupancy_pct) ?? -1) - (asNum(a.yard_occupancy_pct) ?? -1));
  const breaching = rows.filter((r) => (asNum(r.yard_occupancy_pct) ?? 0) >= YARD_AMBER);
  const reportDate = all[0]?.report_date;

  // Render nothing at all when the performance API is unavailable (mock mode),
  // rather than an empty accordion the user can open onto an error.
  if (state.loading || state.error || rows.length === 0) return null;

  const colour = (pct: number | null) =>
    pct === null ? tokens.color.textMuted
      : pct >= YARD_RED ? tokens.congestion.RED
        : pct >= YARD_AMBER ? tokens.congestion.AMBER
          : tokens.congestion.GREEN;

  // The headline goes in the block description so the breach count stays legible
  // while the accordion is collapsed — the whole point of collapsing it.
  const summary = breaching.length > 0
    ? `${breaching.length} terminal${breaching.length === 1 ? '' : 's'} at or above ${YARD_AMBER}%`
    : `All terminals below the ${YARD_AMBER}% utilisation threshold`;
  const asReported = reportDate ? ` · as reported ${new Date(reportDate).toLocaleDateString()}` : '';

  return (
    // Collapsible block, matching the Container Pendency panel below it.
    <CalciteBlock heading="Yard congestion" description={`${summary}${asReported}`} open collapsible>
      {/* The breach summary lives in the block description (visible collapsed),
          so it is not repeated here — the table colours the breaching rows. */}
      <div style={{ marginBottom: 8 }}>
        <SourceBadge source="JNPA Daily Status Report · yard occupancy & pendency" live />
      </div>

      <div style={{ overflowX: 'auto' }}>
        <CalciteTable caption="yard occupancy and pendency by terminal">
          <CalciteTableRow slot="table-header">
            <CalciteTableHeader heading="Terminal" />
            <CalciteTableHeader heading="Yard occupancy" />
            <CalciteTableHeader heading="Yard TEUs" />
            <CalciteTableHeader heading="Capacity" />
            <CalciteTableHeader heading="ICD pendency" />
            <CalciteTableHeader heading="CFS pendency" />
            <CalciteTableHeader heading="Gate TEUs" />
          </CalciteTableRow>
          {rows.map((r) => {
            const pct = asNum(r.yard_occupancy_pct);
            return (
              <CalciteTableRow key={`${r.report_date}-${r.terminal_code}`}>
                <CalciteTableCell><strong>{r.terminal_code}</strong></CalciteTableCell>
                <CalciteTableCell>
                  <span style={{ color: colour(pct), fontWeight: 700 }}>
                    {pct === null ? '—' : `${pct.toFixed(1)}%`}
                  </span>
                </CalciteTableCell>
                <CalciteTableCell>{asNum(r.yard_total_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
                <CalciteTableCell>{asNum(r.yard_usable_capacity_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
                <CalciteTableCell>{asNum(r.icd_pendency_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
                <CalciteTableCell>{asNum(r.cfs_pendency_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
                <CalciteTableCell>{asNum(r.gate_total_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
              </CalciteTableRow>
            );
          })}
          {total && (
            <CalciteTableRow key="total">
              <CalciteTableCell><strong>Port total</strong></CalciteTableCell>
              <CalciteTableCell>
                <strong>{asNum(total.yard_occupancy_pct)?.toFixed(1) ?? '—'}%</strong>
              </CalciteTableCell>
              <CalciteTableCell>{asNum(total.yard_total_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
              <CalciteTableCell>{asNum(total.yard_usable_capacity_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
              <CalciteTableCell>{asNum(total.icd_pendency_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
              <CalciteTableCell>{asNum(total.cfs_pendency_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
              <CalciteTableCell>{asNum(total.gate_total_teus)?.toLocaleString() ?? '—'}</CalciteTableCell>
            </CalciteTableRow>
          )}
        </CalciteTable>
      </div>
    </CalciteBlock>
  );
}

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
    {/* EC-3 detection signal — reported yard utilisation, above the simulated
        pendency ledger and badged with its own (real) provenance. Renders
        nothing when the performance API is unavailable, so mock mode is
        unaffected. */}
    <YardCongestion />
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
          {/* Additive: POC-3 yard optimization + yard/reefer planning APIs
              (Jayesh handover). The pendency table + local workflow drawer above
              are unchanged. */}
          <YardBackendPlanning />
        </>
      )}
    </Panel>
    </>
  );
}
