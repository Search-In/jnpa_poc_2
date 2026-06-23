/**
 * React bindings for the simStore. `useSimStore()` subscribes a component to
 * the whole sim state via useSyncExternalStore, so panels and the map re-render
 * the instant the Simulator page (this tab or another) pushes an update.
 */
import { useSyncExternalStore } from 'react';
import { simStore, type SimState } from './simStore.js';

export function useSimStore(): SimState {
  return useSyncExternalStore(simStore.subscribe, simStore.getState, simStore.getState);
}

/**
 * A single dependency value a panel can drop into its useAsync deps so it
 * refetches whenever the simulator advances (tick) or any lever changes. Keeps
 * panels reactive to the live data without each one knowing the store shape.
 */
export function useSimDep(): string {
  const s = useSimStore();
  return `${s.tick}|${s.movementRate}|${s.scanQueue}|${s.emptyDelta}|${JSON.stringify(s.gates)}|${JSON.stringify(s.pendency)}|${JSON.stringify(s.rail)}|${s.tour.scenarioId}:${s.tour.stepIndex}`;
}

/** True if the sim currently overrides anything (used to badge the dashboard). */
export function hasSimOverrides(s: SimState): boolean {
  return (
    s.running ||
    s.tour.scenarioId !== null ||
    Object.keys(s.gates).length > 0 ||
    Object.keys(s.pendency).length > 0 ||
    Object.keys(s.rail).length > 0 ||
    s.movementRate !== 1 ||
    s.scanQueue !== null ||
    s.emptyDelta !== 0
  );
}
