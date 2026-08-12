/**
 * Cross-twin lifecycle hand-off — where a scenario's story continues once THIS twin has
 * told its part. Mirror of the module of the same name in UC-1.
 *
 * A port disruption does not respect the boundary between the three twins. A monsoon that
 * suspends pilot transfer in UC-1 lands vessels late; the late discharge stacks up in this
 * twin's yard; working that backlog off puts a truck surge on UC-3's corridor. Each twin
 * modelled its own segment and stopped, so the operator saw three unrelated demos of one
 * event.
 *
 * A hand-off names the next segment and how to reach it. Deliberately a LINK and a
 * sentence rather than an automatic redirect: the operator finishes reading the conclusion
 * first, it opens on a real click (which is what stops a browser blocking the tab), and a
 * twin that is not running costs a dead tab rather than derailing the scenario on screen.
 */

export type TwinId = 'UC1' | 'UC2' | 'UC3';

const ORIGIN_ENV: Record<TwinId, string | undefined> = {
  UC1: import.meta.env.VITE_UC1_APP_URL,
  UC2: import.meta.env.VITE_UC2_APP_URL,
  UC3: import.meta.env.VITE_UC3_APP_URL,
};

/**
 * Production hosts, from each twin's own nginx `server_name`:
 *   UC-1  jnpa_poc_1/deploy/nginx.conf   -> vessel-one.searchintech.in
 *   UC-2  apps/web/nginx.conf            -> logistics-two.searchintech.in
 *   UC-3  the gateway origin everywhere  -> traffic-three.searchintech.in
 *
 * Overridable per build with VITE_UC{1,2,3}_APP_URL, so a staging stack or a laptop can
 * point the chain at itself without a code change. The DEFAULTS are production because
 * that is where this runs unattended: a deployed build with an unset variable should link
 * to the deployed twin, not to a localhost that only exists on a developer's machine.
 */
const ORIGIN_DEFAULT: Record<TwinId, string> = {
  UC1: 'https://vessel-one.searchintech.in',
  UC2: 'https://logistics-two.searchintech.in',
  UC3: 'https://traffic-three.searchintech.in',
};

/**
 * Local dev, for `VITE_UC{1,2,3}_APP_URL` on a laptop:
 *   UC-2 :5173 · UC-1 :5174 · UC-3 :5175
 */
export const ORIGIN_LOCAL: Record<TwinId, string> = {
  UC1: 'http://localhost:5174',
  UC2: 'http://localhost:5173',
  UC3: 'http://localhost:5175',
};

export const TWIN_LABEL: Record<TwinId, string> = {
  UC1: 'UC-1 · Vessel Traffic',
  UC2: 'UC-2 · Cargo & Logistics',
  UC3: 'UC-3 · Traffic & Corridor',
};

export interface LifecycleHandoff {
  twin: TwinId;
  /** Scenario id in the RECEIVING app's vocabulary, not ours. */
  scenarioId: string;
  /** Button text. Names the next segment, not the mechanism. */
  cta: string;
  /** The causal link between the two segments, in one sentence. */
  because: string;
}

export function twinOrigin(twin: TwinId): string {
  return (ORIGIN_ENV[twin] || ORIGIN_DEFAULT[twin]).replace(/\/+$/, '');
}

/** `?scenario=<id>` is the parameter all three apps accept, so this needs no new contract. */
export function handoffUrl(h: LifecycleHandoff): string {
  return `${twinOrigin(h.twin)}/?scenario=${encodeURIComponent(h.scenarioId)}`;
}
