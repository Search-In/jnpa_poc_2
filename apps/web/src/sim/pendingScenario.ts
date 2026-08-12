/**
 * The `?scenario=` deep link, captured before anything can lose it.
 *
 * A cross-twin hand-off opens this app at `/?scenario=S7`, and several things between the
 * browser and the What-If player can eat that parameter:
 *
 *   • the SIGN-IN GATE. With VITE_AUTH_ENABLED on, AuthGate renders LoginGate instead of
 *     the Dashboard, so the component that reads the URL does not mount until after
 *     sign-in. Today the gate swaps state rather than reloading, so the query happens to
 *     survive — but that is an implementation detail of AuthGate, not a guarantee, and a
 *     deep link should not depend on how the login screen is built.
 *   • any reload during sign-in (an expired token, a redirect through an IdP).
 *   • any later navigation that rewrites the URL without carrying the query.
 *
 * So the id is read ONCE at module load — before React renders, before the gate decides
 * anything — and parked in sessionStorage. Whoever mounts first and can act on it takes
 * it, and it is cleared on take so a later reload does not silently restart a scenario
 * the operator has since finished.
 *
 * sessionStorage, not localStorage: a deep link belongs to the tab it was opened in. A
 * second tab should not inherit it.
 */

const KEY = 'jnpa.uc2.pendingScenario';

/** Captured at import time. Module side effect ON PURPOSE — see above. */
(function capture() {
  try {
    const id = new URLSearchParams(window.location.search).get('scenario');
    if (id) sessionStorage.setItem(KEY, id);
  } catch {
    /* no URL / no storage — the deep link is simply unavailable, not an error */
  }
})();

/**
 * Take the pending scenario id, if any. Returns null once consumed.
 *
 * Consuming rather than peeking is what stops a reload after the tour has ended from
 * starting it over — the link fires once, for the visit it was opened in.
 */
export function takePendingScenario(): string | null {
  try {
    const id = sessionStorage.getItem(KEY);
    if (id) sessionStorage.removeItem(KEY);
    return id;
  } catch {
    return null;
  }
}
