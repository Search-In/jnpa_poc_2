/**
 * Transport for the UC-II AI/ML model service (`ml/`, FastAPI :8200).
 *
 * Same posture as the app's other integrations (see `AppContext`'s CARGO_API_BASE
 * and NldsTrackDialog's LDB_BASE): a RELATIVE base so the browser stays
 * same-origin behind the Vite dev proxy or nginx — no CORS, no preflight, and
 * the model service is never published directly. Callers pass the SUFFIX only
 * ('/uc2/webapp/predictions').
 *
 * Two deliberate differences from the Cargo client:
 *
 *  • **No bearer.** The model service is stateless and holds no port data — it
 *    computes from the payload it is given, so it carries no auth of its own.
 *    That is precisely why the deployment must not expose it: nginx proxies
 *    `/ml-api` to it on the private network, exactly as it does `/poc3`.
 *
 *  • **A timeout.** Scoring a page runs three learned models and four
 *    deterministic ones — real computation, not a database read. A wedged
 *    request must fail the panel with a message rather than hang the operator's
 *    session, so every call carries an AbortController deadline.
 */

/** Relative by default so dev (Vite proxy) and prod (nginx) are the same code. */
export const ML_API_BASE =
  (import.meta.env?.VITE_ML_API_BASE as string | undefined) || '/ml-api';

/** Off by default in mock mode; set VITE_ML_ENABLED=true to score for real. */
export const ML_ENABLED =
  ((import.meta.env?.VITE_ML_ENABLED as string | undefined) ?? 'true') !== 'false';

export const ML_TIMEOUT_MS = Number(
  (import.meta.env?.VITE_ML_TIMEOUT_MS as string | undefined) ?? 30_000,
);

/**
 * Join the base with a path suffix. Pure.
 *
 * Defensive about the double-prefix mistake: a caller passing the already
 * prefixed path gets the right URL rather than a puzzling 404.
 */
export function mlUrl(path: string, base: string = ML_API_BASE): string {
  const root = base.replace(/\/+$/, '');
  let suffix = path.startsWith('/') ? path : `/${path}`;
  if (root && (suffix === root || suffix.startsWith(`${root}/`))) {
    suffix = suffix.slice(root.length) || '/';
  }
  return `${root}${suffix}`;
}

/**
 * Marker every failure from this module carries.
 *
 * The panel keys on it to pick model-service wording. Without it an ML failure
 * is classified by status alone and reads as *"the Cargo backend hit an
 * internal error"* — a different system, a different team, and the wrong thing
 * for an operator to chase.
 */
export const ML_PREFIX = '[ML]';

/** Substring that marks "the request never reached the service". */
export const ML_UNREACHABLE = 'is not reachable';

/** How to start it. One string, so the message and the docs cannot drift. */
export const ML_START_HINT =
  'Start it with `cd ml && JNPA_PORT=8200 .venv/bin/python run.py serve-uc2`, ' +
  'or point VITE_ML_API_BASE at a running instance.';

export function unreachableMessage(path: string): string {
  return `${ML_PREFIX} The UC-II model service ${ML_UNREACHABLE} at ${mlUrl(path)}. ${ML_START_HINT}`;
}

/** Build the message thrown on a non-2xx. Pure, so it is testable. */
export function httpErrorMessage(
  path: string,
  status: number,
  statusText: string,
  detail?: unknown,
): string {
  const tail = detail === undefined || detail === null ? '' : ` — ${safeStringify(detail)}`;
  return `${ML_PREFIX} ${path} → HTTP ${status} ${statusText}${tail}`;
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Turn a thrown transport error into something an operator can act on. Pure.
 *
 * Handles only the cases where `fetch` REJECTS. A dead service behind the dev
 * proxy does NOT reject — see `looksLikeProxyFailure`.
 */
export function friendlyMlError(err: unknown, path: string): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (err instanceof DOMException && err.name === 'AbortError') {
    return (
      `${ML_PREFIX} The model service did not answer within ` +
      `${Math.round(ML_TIMEOUT_MS / 1000)} s (${path}). Scoring a page runs the ` +
      `learned dwell and queue models — a large page can exceed the deadline. Try ` +
      `again, or raise VITE_ML_TIMEOUT_MS.`
    );
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(raw)) {
    return unreachableMessage(path);
  }
  return raw.startsWith(ML_PREFIX) ? raw : `${ML_PREFIX} ${raw}`;
}

/**
 * True when a non-2xx looks like the PROXY failing, not the service answering.
 *
 * THIS IS THE CASE THAT SHIPS BROKEN IF YOU DO NOT HANDLE IT. With the model
 * service stopped, Vite's dev proxy answers `500 Internal Server Error` with an
 * **empty text/plain body** (nginx does the same with a 502), so `fetch`
 * RESOLVES and the network-error branch above never runs. The message then
 * reads as a generic 5xx and the panel blames a backend that was not involved.
 *
 * The discriminator is the BODY, not the status: FastAPI always answers JSON,
 * so a 5xx with no JSON body did not come from the model service. Pure.
 */
export function looksLikeProxyFailure(status: number, body: unknown): boolean {
  return status >= 500 && (body === undefined || body === null);
}

/** Health path. Declared here so the liveness probe has no import cycle. */
export const ML_HEALTH_PATH = '/health';

/**
 * Ask the service whether it is alive at all.
 *
 * Needed because a 5xx with a non-JSON body has two causes that call for
 * OPPOSITE actions: the service is DOWN (start it), or the service is UP and
 * crashed on this request (read the traceback). Only used on the error path, so
 * a healthy request never pays for it. Never throws.
 */
async function isServiceAlive(): Promise<boolean> {
  try {
    const res = await fetch(mlUrl(ML_HEALTH_PATH), {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    // A 503 from /health is still an ANSWER: the app is up and reporting itself
    // degraded, which is very different from nothing listening on the port.
    return res.status < 500 || res.headers.get('content-type')?.includes('json') === true;
  } catch {
    return false;
  }
}

async function readErrorDetail(res: Response): Promise<unknown> {
  try {
    const body = (await res.json()) as { detail?: unknown };
    return body?.detail ?? body;
  } catch {
    return undefined;
  }
}

/**
 * JSON request against the model service.
 *
 * @param path suffix relative to {@link ML_API_BASE}, e.g. '/uc2/webapp/predictions'
 * @throws when the service is disabled, unreachable, slow, or answers non-2xx
 */
export async function mlHttp<T>(path: string, init?: RequestInit): Promise<T> {
  // Hard gate: with the integration switched off the app must make NO call at
  // all, so a mock-mode demo stays provably offline.
  if (!ML_ENABLED) {
    throw new Error(
      `${ML_PREFIX} ${path} — the AI/ML model service is disabled (VITE_ML_ENABLED=false)`,
    );
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), ML_TIMEOUT_MS);
  try {
    const res = await fetch(mlUrl(path), {
      ...init,
      signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    });
    if (!res.ok) {
      const detail = await readErrorDetail(res);
      // A 5xx with no JSON body did not come from FastAPI. Confirm against
      // /health before blaming the models: "down" and "crashed" need opposite
      // actions from whoever reads this message.
      if (looksLikeProxyFailure(res.status, detail) && !(await isServiceAlive())) {
        throw new Error(unreachableMessage(path));
      }
      throw new Error(httpErrorMessage(path, res.status, res.statusText, detail));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  } catch (err) {
    // A non-2xx already carries a descriptive message; only transport failures
    // need translating, and re-wrapping the former would double the prefix.
    if (err instanceof Error && err.message.startsWith(ML_PREFIX)) throw err;
    throw new Error(friendlyMlError(err, path));
  } finally {
    clearTimeout(deadline);
  }
}
