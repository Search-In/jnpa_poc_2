/**
 * predictionStore — which container's AI/ML panel is open, the last scored
 * page, and the status of the call that produced it.
 *
 * Store-driven rather than component state for two reasons:
 *
 *  • **One call serves every row.** Scoring runs the learned dwell and queue
 *    models over the whole page; doing that again each time the operator opens
 *    a different container would be seconds of needless compute for numbers
 *    already in hand. So a successful response is cached and reused for any
 *    container it already covers, until it goes stale.
 *
 *  • **The panel outlives the row.** The drawer is mounted beside the table,
 *    outside the `<Panel>` that unmounts its children while `useAsync`
 *    refetches — the same reason the other Movements dialogs are mounted there
 *    (see the comment at the bottom of ContainerMovements.tsx).
 *
 * Staleness is deliberate and short: containers move, customs states change,
 * and a dwell forecast built on a page from ten minutes ago is a different
 * forecast. After CACHE_TTL_MS the next open re-scores.
 *
 * Mirrors the existing store pattern in this app (customsFlagStore,
 * cargoRefreshStore): a plain module-level object with subscribe + getSnapshot,
 * read through useSyncExternalStore. No new state library.
 */

import { useSyncExternalStore } from 'react';
import type { ContainerMovementDTO } from '@jnpa/data';
import { fetchPredictions, indexByContainer, selectPage } from '../data/ml/predictions.js';
import type { ContainerPrediction, PredictionResponse } from '../data/ml/types.js';

/** How long a scored page may be reused before the next open re-scores. */
export const CACHE_TTL_MS = 5 * 60_000;

export interface PredictionState {
  /** Container whose panel is open; null when closed. */
  openContainerNo: string | null;
  loading: boolean;
  error: string | null;
  /** The last successful response, or null before the first / after a failure. */
  response: PredictionResponse | null;
  /** `Date.now()` of that response. */
  fetchedAt: number | null;
  /** How many containers were sent, and how many the page held at the time. */
  scored: number;
  pageSize: number;
}

const INITIAL: PredictionState = {
  openContainerNo: null,
  loading: false,
  error: null,
  response: null,
  fetchedAt: null,
  scored: 0,
  pageSize: 0,
};

let state: PredictionState = INITIAL;
const listeners = new Set<() => void>();

function set(patch: Partial<PredictionState>): void {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}

/**
 * The prediction for one container, or null. Pure selector.
 *
 * Takes the container explicitly rather than reading `openContainerNo`. The
 * drawer titles itself from the container it was given, so it must read the
 * numbers for THAT container: if the prop and the store ever diverged — a
 * stale close, a double click, a re-render mid-open — a store-driven lookup
 * would render one container's dwell forecast under another one's number,
 * which is worse than rendering nothing.
 */
export function selectPredictionFor(
  s: PredictionState,
  containerNo: string,
): ContainerPrediction | null {
  if (!s.response || !containerNo) return null;
  return indexByContainer(s.response).get(containerNo) ?? null;
}

async function score(containerNo: string, moves: ContainerMovementDTO[]): Promise<void> {
  const sent = selectPage(moves, containerNo);
  set({ loading: true, error: null, scored: sent.length, pageSize: moves.length });
  try {
    const response = await fetchPredictions(moves, containerNo);
    set({ response, fetchedAt: Date.now(), loading: false, error: null });
  } catch (err) {
    // The previous response is DROPPED on failure. Showing stale predictions
    // beside a fresh error is how an operator ends up acting on numbers that no
    // longer describe the containers in front of them.
    set({
      loading: false,
      error: err instanceof Error ? err.message : String(err),
      response: null,
      fetchedAt: null,
    });
  }
}

export const predictionStore = {
  getSnapshot: (): PredictionState => state,

  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  /**
   * Open the panel for one container, scoring the page if the cache cannot
   * serve it. Scoring is real computation, so it runs when someone ASKS —
   * never eagerly for every row in the table.
   */
  async open(containerNo: string, moves: ContainerMovementDTO[]): Promise<void> {
    set({ openContainerNo: containerNo });
    const { response, fetchedAt } = state;
    const fresh = fetchedAt !== null && Date.now() - fetchedAt < CACHE_TTL_MS;
    if (response && fresh && indexByContainer(response).has(containerNo)) {
      set({ loading: false, error: null });
      return;
    }
    await score(containerNo, moves);
  },

  close(): void {
    set({ openContainerNo: null });
  },

  /** Force a re-score of the open container's page. */
  async refresh(moves: ContainerMovementDTO[]): Promise<void> {
    const { openContainerNo } = state;
    if (!openContainerNo) return;
    await score(openContainerNo, moves);
  },

  /** Test seam: drop every cached result and close the panel. */
  reset(): void {
    state = INITIAL;
    listeners.forEach((fn) => fn());
  },
};

/** React binding. */
export function usePredictions(): PredictionState {
  return useSyncExternalStore(
    predictionStore.subscribe,
    predictionStore.getSnapshot,
    predictionStore.getSnapshot,
  );
}
