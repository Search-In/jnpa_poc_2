/**
 * Which containers a filed RMS scan list actually selected for scanning.
 *
 * Shared by the Scan tab (which boxes belong in the queue) and Movements (whether
 * the verify gate is a scan or a plain pre-release check), so the two cannot
 * disagree about whether a scan was ever ordered.
 *
 * Fetched ONCE per mount and held as a set: the corpus has 4 scan lists, one of
 * which selected nothing, so this is 4-5 requests rather than one per row. The
 * adapter's in-flight GET de-duplication collapses the two panels' concurrent
 * calls into one set of requests.
 */
import { useApp } from './AppContext.js';
import { useAsync } from './useAsync.js';

export interface RmsSelection {
  /** Container numbers, upper-cased. Empty until `ready`. */
  selected: ReadonlySet<string>;
  /**
   * False while the lists are loading OR if they could not be read.
   *
   * Callers must not treat "not selected" as settled before this is true —
   * an unresolved set would silently reclassify every scanned box as facilitated,
   * which is the more damaging of the two errors.
   */
  ready: boolean;
}

const EMPTY: ReadonlySet<string> = new Set();

export function useRmsSelection(): RmsSelection {
  const { adapter } = useApp();

  const state = useAsync<Set<string>>(async () => {
    if (typeof adapter.getRmsScanLists !== 'function'
      || typeof adapter.getRmsScanContainers !== 'function') return new Set<string>();

    const lists = await adapter.getRmsScanLists({ limit: 100 });
    // `any_selected === false` is a real outcome — "No container selected for
    // scanning" — not missing data, so skip the round-trip rather than treat it
    // as an error later.
    const withSelections = lists.filter((l) => l.any_selected !== false);
    const perList = await Promise.all(withSelections.map((l) =>
      // One unreadable list must not blank the whole set: a partial answer still
      // names real selections, whereas a thrown error would name none.
      adapter.getRmsScanContainers!(l.igm_no, { limit: 1000 }).catch(() => [])));

    return new Set(perList.flat().map((c) => String(c.container_no).trim().toUpperCase()));
  }, [adapter]);

  return {
    selected: state.data ?? EMPTY,
    ready: !state.loading && !state.error && state.data != null,
  };
}
