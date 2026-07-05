/**
 * React binding for the faultStore. Subscribes a component to the whole fault
 * state via useSyncExternalStore, so the Integration Console, the header chip,
 * and (through the SimAdapter refetch) the HealthCards tab all react the instant
 * a fault is injected — in this tab or another.
 */
import { useSyncExternalStore } from 'react';
import { faultStore, type FaultState } from './faultStore.js';

export function useFaultStore(): FaultState {
  return useSyncExternalStore(faultStore.subscribe, faultStore.getState, faultStore.getState);
}

/** A single dep string panels can drop into useAsync so health refetches on any fault change. */
export function useFaultDep(): string {
  const s = useFaultStore();
  return JSON.stringify(s.sources);
}
