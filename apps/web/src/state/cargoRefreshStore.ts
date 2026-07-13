/**
 * cargoRefreshStore — a tiny refresh signal bumped after a successful POC-3 Cargo
 * WRITE (vessel discharge / gate release). Panels that read cargo-affected data
 * drop `useCargoRefresh()` into their existing `useAsync` deps, so they refetch
 * through the SAME adapter flow the moment a write lands. Mirrors the established
 * external-store pattern (customsFlagStore/simStore) — it stores NO cargo data,
 * only a monotonic version counter. No backend/API/DTO/schema change.
 */
import { useSyncExternalStore } from 'react';

let version = 0;
const listeners = new Set<() => void>();

export const cargoRefreshStore = {
  getSnapshot: (): number => version,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  /** Signal that a cargo write succeeded → dependent panels refetch. */
  bump(): void {
    version += 1;
    listeners.forEach((l) => l());
  },
};

/** Version number panels put in their useAsync deps to refetch after a cargo write. */
export function useCargoRefresh(): number {
  return useSyncExternalStore(cargoRefreshStore.subscribe, cargoRefreshStore.getSnapshot, cargoRefreshStore.getSnapshot);
}
