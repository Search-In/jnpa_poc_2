/**
 * workflowStore — the Automated Workflow engine's state (spec §8.3, scored
 * criterion 5: "automated workflows with AUTO vs ADVISORY execution + audit
 * trail"). It holds the §8.3 minimum rule set (pendency, gate queue, scan flag,
 * e-seal mismatch, rake ETA slip, reefer plug scarcity) and a runs ledger: every
 * rule firing is appended as a WorkflowRun so evaluators can inspect exactly
 * what fired, why, what it did, and who was notified — the audit trail the spec
 * asks for. In AUTO mode a run executes immediately (status FIRED); in ADVISORY
 * mode it queues as PENDING_APPROVAL until an operator approves or dismisses it,
 * demonstrating human-in-the-loop control over the same rules.
 *
 * Mirrors faultStore's tiny pub/sub + BroadcastChannel + localStorage pattern so
 * it works cross-tab (fire rules from the Simulator/What-If screen, watch the
 * ledger on the main screen) and hydrates a freshly-opened tab. Deterministic:
 * ids/timestamps come from a monotonic stamp, never Date.now — replayable on
 * "seed 42". All actions here are simulated orchestrations within simulation;
 * no real notification is sent and no real JNPA baseline is claimed.
 */

/** Execution mode for the whole engine (§8.3): AUTO fires, ADVISORY proposes. */
export type WorkflowMode = 'AUTO' | 'ADVISORY';

/** One automation rule: WHEN <event>, IF <condition>, THEN <actions>, NOTIFY <roles>. */
export interface WorkflowRule {
  id: string;
  when: string;
  /** condition/threshold text */
  condition: string;
  then: string;
  /** actions text */
  actions: string;
  /** which role(s) get notified */
  notifyRoles: string[];
}

/**
 * The spec §8.3 minimum rule set. `actions` uses "; " separators so a firing
 * can split it into the run's discrete action lines.
 */
export const WORKFLOW_RULES: WorkflowRule[] = [
  {
    id: 'WF-PENDENCY',
    when: 'Container pendency breach',
    condition: 'Pendency at a CFS/yard exceeds the configured dwell threshold',
    then: 'Notify stakeholders + recommend DPD conversion',
    actions:
      'Send stakeholder notification (importer/CHA, CFS operator); Recommend DPD-conversion for eligible boxes; Flag long-dwell containers for evacuation planning',
    notifyRoles: ['CFS Operator', 'Importer/CHA', 'Terminal Ops'],
  },
  {
    id: 'WF-GATE-QUEUE',
    when: 'Gate queue build-up',
    condition: 'Gate queue length > N trailers (configured per gate)',
    then: 'Open additional lane + notify traffic',
    actions:
      'Open an additional gate lane; Notify traffic control to re-route approaching trailers; Post advisory to trailer operators via app',
    notifyRoles: ['Gate Marshal', 'Traffic Control'],
  },
  {
    id: 'WF-SCAN-FLAG',
    when: 'Scan flag raised',
    condition: 'Scanner/risk system raises an inspection flag on a container',
    then: 'Hold + notify customs + reroute to scan bay',
    actions:
      'Place container on hold; Notify customs (ICEGATE) of the flag; Reroute container to the scanning bay queue',
    notifyRoles: ['Customs (ICEGATE)', 'Scanner Bay Ops', 'Terminal Ops'],
  },
  {
    id: 'WF-ESEAL-MISMATCH',
    when: 'E-seal mismatch at gate',
    condition: 'E-seal read at the gate does not match the declared seal ID',
    then: 'Auto-hold + security + customs alert',
    actions:
      'Auto-hold the trailer at the gate; Alert port security for physical verification; Alert customs (ICEGATE) with the mismatch record',
    notifyRoles: ['Port Security', 'Customs (ICEGATE)', 'Gate Marshal'],
  },
  {
    id: 'WF-RAKE-ETA',
    when: 'Rake ETA slip',
    condition: 'Inbound rake ETA slips by more than 2 h against plan',
    then: 'Re-plan siding placement + notify CTO/terminal',
    actions:
      'Re-plan siding placement sequence for affected rakes; Notify CTO of the revised placement window; Notify terminal rail ops to re-sequence loading',
    notifyRoles: ['CTO', 'Terminal Rail Ops'],
  },
  {
    id: 'WF-REEFER-PLUG',
    when: 'Reefer plug scarcity',
    condition: 'Available reefer plug points fall below the safety threshold',
    then: 'Allocate plugs + prioritise evacuation',
    actions:
      'Allocate remaining plug points to highest-priority reefers; Raise evacuation priority for pluggable long-dwell reefers; Notify shipping line of at-risk units',
    notifyRoles: ['Yard Planner', 'Terminal Ops', 'Shipping Line'],
  },
];

/** Fast lookup of a rule by its id. */
export const RULE_BY_ID: Record<string, WorkflowRule> = Object.fromEntries(
  WORKFLOW_RULES.map((r) => [r.id, r] as const),
);

/** One entry in the runs ledger — the §8.3 audit trail. */
export interface WorkflowRun {
  /** Monotonic id (from the store's stamp — never Date.now). */
  id: number;
  ruleId: string;
  ruleLabel: string;
  /** The event/condition that fired it. */
  trigger: string;
  actions: string[];
  status: 'FIRED' | 'PENDING_APPROVAL' | 'APPROVED' | 'DISMISSED';
  mode: WorkflowMode;
  /** What-If scenario this firing belongs to, if tour-driven. */
  scenarioId?: string;
  /** Monotonic stamp for ordering (never wall-clock). */
  ts: number;
  /** Map asset id for the pulse/spotlight (e.g. 'BMCT-G1', 'CFS-DRONAGIRI-1'). */
  location?: string;
  notifyRoles: string[];
}

export interface WorkflowState {
  mode: WorkflowMode;
  /** Newest first. Capped at MAX_RUNS to avoid unbounded growth. */
  runs: WorkflowRun[];
}

const STORAGE_KEY = 'jnpa.workflow.state.v1';
const CHANNEL = 'jnpa-workflow';
/** Ledger cap — keep the last N runs only. */
const MAX_RUNS = 50;

function baseState(): WorkflowState {
  return { mode: 'AUTO', runs: [] };
}

/** Inputs for fireRule; `overrideActions` (or `actions`) replaces the rule's defaults. */
export interface FireRuleOptions {
  /** The event/condition text that fired the rule (audit-trail "why"). */
  trigger: string;
  /** Explicit action lines for this firing (else derived from the rule). */
  actions?: string[];
  scenarioId?: string;
  /** Map asset id for the pulse (terminal/gate/CFS id). */
  location?: string;
  /** Alias for `actions` — wins if both are given. */
  overrideActions?: string[];
}

type Listener = () => void;

class WorkflowStore {
  private state: WorkflowState = baseState();
  private listeners = new Set<Listener>();
  private channel: BroadcastChannel | null = null;
  /** Monotonic stamp source (avoids Date.now, keeps demo deterministic). */
  private stamp = 0;

  constructor() {
    try {
      const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<WorkflowState>;
        this.state = {
          ...baseState(),
          // Guard corrupt/legacy storage: only accept a known mode value.
          mode: parsed.mode === 'ADVISORY' ? 'ADVISORY' : 'AUTO',
          runs: Array.isArray(parsed.runs) ? parsed.runs.slice(0, MAX_RUNS) : [],
        };
        this.bumpStamp(this.state.runs);
      }
    } catch {
      /* ignore corrupt storage */
    }
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(CHANNEL);
      this.channel.onmessage = (e: MessageEvent) => {
        if (e.data?.type === 'state') {
          this.state = e.data.state as WorkflowState;
          // Keep this tab's stamp ahead of any run minted in another tab.
          this.bumpStamp(this.state.runs);
          this.emit(false);
        }
      };
    }
  }

  /** Advance the monotonic stamp past every known run id/ts (hydration + cross-tab). */
  private bumpStamp(runs: WorkflowRun[]) {
    for (const r of runs) {
      if (r.id >= this.stamp) this.stamp = r.id + 1;
      if (r.ts >= this.stamp) this.stamp = r.ts + 1;
    }
  }

  getState = (): WorkflowState => this.state;

  subscribe = (fn: Listener): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(broadcast: boolean) {
    if (broadcast) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
      } catch {
        /* ignore */
      }
      this.channel?.postMessage({ type: 'state', state: this.state });
    }
    this.listeners.forEach((l) => l());
  }

  private set(producer: (s: WorkflowState) => WorkflowState) {
    this.state = producer(this.state);
    this.emit(true);
  }

  /** Switch the whole engine between AUTO (fires) and ADVISORY (proposes). */
  setMode = (mode: WorkflowMode) => this.set((s) => ({ ...s, mode }));

  /**
   * Fire a rule: mint a WorkflowRun on the ledger (newest first). AUTO → the run
   * executes immediately (FIRED); ADVISORY → it waits for approval
   * (PENDING_APPROVAL). Returns the run so callers (scenario steps, console
   * buttons) can spotlight its location on the map.
   */
  fireRule = (ruleId: string, opts: FireRuleOptions): WorkflowRun => {
    const rule = RULE_BY_ID[ruleId];
    const stamp = this.stamp++;
    const actions =
      opts.overrideActions ??
      opts.actions ??
      (rule ? rule.actions.split(/;\s*/).filter(Boolean) : []);
    const run: WorkflowRun = {
      id: stamp,
      ruleId,
      ruleLabel: rule ? `${rule.when} → ${rule.then}` : ruleId,
      trigger: opts.trigger,
      actions,
      status: this.state.mode === 'AUTO' ? 'FIRED' : 'PENDING_APPROVAL',
      mode: this.state.mode,
      scenarioId: opts.scenarioId,
      ts: stamp,
      location: opts.location,
      notifyRoles: rule ? rule.notifyRoles : [],
    };
    this.set((s) => ({ ...s, runs: [run, ...s.runs].slice(0, MAX_RUNS) }));
    return run;
  };

  /** Operator approves a PENDING_APPROVAL run (ADVISORY human-in-the-loop). */
  approveRun = (id: number) =>
    this.set((s) => ({
      ...s,
      runs: s.runs.map((r) =>
        r.id === id && r.status === 'PENDING_APPROVAL' ? { ...r, status: 'APPROVED' as const } : r,
      ),
    }));

  /** Operator dismisses a PENDING_APPROVAL run (audit trail keeps the record). */
  dismissRun = (id: number) =>
    this.set((s) => ({
      ...s,
      runs: s.runs.map((r) =>
        r.id === id && r.status === 'PENDING_APPROVAL' ? { ...r, status: 'DISMISSED' as const } : r,
      ),
    }));

  /** Clear the ledger (demo reset). */
  clearRuns = () => this.set((s) => ({ ...s, runs: [] }));
}

export const workflowStore = new WorkflowStore();
