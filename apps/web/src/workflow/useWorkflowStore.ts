/**
 * React binding for the workflowStore (spec §8.3, criterion 5). Subscribes a
 * component to the whole workflow state via useSyncExternalStore, so the
 * Workflows panel, the AUTO/ADVISORY toggle, and the runs-ledger audit trail
 * all react the instant a rule fires — in this tab or another.
 */
import { useSyncExternalStore } from 'react';
import { workflowStore, type WorkflowState } from './workflowStore.js';

export function useWorkflowStore(): WorkflowState {
  return useSyncExternalStore(workflowStore.subscribe, workflowStore.getState, workflowStore.getState);
}

/** A single dep string panels can drop into useAsync so views refetch when the engine mode flips or a run is minted. */
export function useWorkflowDep(): string {
  const s = useWorkflowStore();
  return JSON.stringify({ mode: s.mode, runs: s.runs.length });
}
