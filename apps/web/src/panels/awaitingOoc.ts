/**
 * The rules behind the "Awaiting out-of-charge" queue.
 *
 * React-free so they can be unit-tested without rendering, same as
 * `cargoGates.ts` and `scanSelection.ts`.
 */
import type { CargoCustomsStatus } from '@jnpa/data';

/**
 * The customs dispositions that BLOCK a release, and therefore define the queue.
 *
 * Not a UI preference — it mirrors `CUSTOMS_BLOCKS_RELEASE` in the POC-3 service
 * (`services/cargo/service.py`), which `release_cargo` evaluates under the same
 * row lock as the lifecycle gate. If the two ever disagree, the queue either
 * hides a container that cannot be released or lists one that can.
 */
export const BLOCKING_CUSTOMS: readonly CargoCustomsStatus[] = ['UNDER_INSPECTION', 'HELD'];

/** One page of results, as returned per disposition. */
export interface BlockedPage<T> {
  items: T[];
  /** Filtered population from `X-Total-Count`; null when the header was absent. */
  total: number | null;
}

/**
 * Combine one page per blocking disposition into the queue.
 *
 * ⚠ The total is null unless EVERY page reported one. A known half plus an
 * unknown half is not a total, and summing what you have would render a number
 * that looks authoritative and is simply wrong — the panel shows "x of y" from
 * this, so an undercount reads as "that's the whole queue" when it is not.
 */
export function mergeBlockedPages<T>(pages: BlockedPage<T>[]): BlockedPage<T> {
  return {
    items: pages.flatMap((p) => p.items),
    total: pages.every((p) => p.total != null)
      ? pages.reduce((n, p) => n + (p.total ?? 0), 0)
      : null,
  };
}

/**
 * How long a container has been sitting, as a short label.
 *
 * `now` is injected rather than read from the clock so the result is testable
 * and so a re-render mid-session cannot make two rows disagree about "today".
 */
export function waitingLabel(ts: string | null | undefined, now: number): string {
  if (!ts) return '—';
  const t = new Date(ts).getTime();
  if (Number.isNaN(t)) return '—';
  const days = Math.floor((now - t) / 86_400_000);
  // A future timestamp is clock skew between the browser and the backend, not a
  // negative wait. Report it as the floor rather than "-1d".
  return days <= 0 ? 'today' : `${days}d`;
}
