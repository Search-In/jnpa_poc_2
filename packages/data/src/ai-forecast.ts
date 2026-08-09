/**
 * Client for the UC-2 Python model services (ticket UC2-015).
 *
 * ⚠ WHY THIS EXISTS. The four AI services were built, containerised and never
 * reachable: `docker-compose.yml` declared them with no `ports:`, so nothing
 * outside the compose network could call them. The dashboard filled the gap with
 * a TypeScript heuristic (`simpleGateQueueForecast`) that looks like a forecast
 * and is not one — which made "proven end-to-end" untrue, and one `curl` from a
 * technical evaluator would have shown it.
 *
 * The heuristic is NOT deleted. It stays as an explicit, labelled fallback,
 * because a gate panel that goes blank when a model container restarts is worse
 * than one that degrades and says so. What changes is that the DTO now carries
 * WHICH of the two produced it, so the screen can never again present a
 * heuristic as a model.
 *
 * Service contract (`services/ai/ai_common/serving.py`):
 *   GET  /health   → {model, ready, version}
 *   POST /predict  → {instances: number[][]} → {predictions: number[], detail: [...]}
 */
import type { GateQueueForecastDTO } from './interface.js';

/** Feature order for gate-queue-forecaster. MUST match FEATURES in its model.py. */
export const GATE_QUEUE_FEATURES = [
  'queue_lag1', 'queue_lag2', 'hour_sin', 'hour_cos', 'uc3_truck_inflow',
] as const;

export interface GateQueueModelInput {
  /** Queue length one step back, in vehicles. */
  queueLag1: number;
  /** Queue length two steps back. */
  queueLag2: number;
  /** Hour of day, 0–23, for the cyclical encoding. */
  hour: number;
  /**
   * Trucks inbound to this gate, supplied by the UC-3 twin.
   *
   * This is the cross-twin feature (UC2-054). It is CALLER-SUPPLIED: when UC-3 is
   * not running there is no live value, and the caller passes what it has. The
   * response records which it was, so the card never implies a live subscription
   * that is not there.
   */
  uc3TruckInflow: number;
}

/** One row in the order the model was trained on. Cyclical hour, as in training. */
export function toInstance(input: GateQueueModelInput): number[] {
  const theta = (2 * Math.PI * input.hour) / 24;
  return [
    input.queueLag1,
    input.queueLag2,
    Math.sin(theta),
    Math.cos(theta),
    input.uc3TruckInflow,
  ];
}

export interface AiServiceDeps {
  /** Base URL of the model service, e.g. '/ai/gate-queue' behind the dev proxy. */
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /**
   * Abort budget. A model container that is up but wedged must not hang the Gate
   * panel — past this the caller falls back to the heuristic, which is the whole
   * point of keeping one.
   */
  timeoutMs?: number;
}

export interface PredictResponse {
  predictions: number[];
  detail?: Array<{ predictedQueue: number; deferralRecommended: boolean }>;
}

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await run(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** `GET /health` — used to decide the badge, not just to log. */
export async function aiHealth(deps: AiServiceDeps): Promise<{ model: string; version?: string } | null> {
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.timeoutMs ?? 2500, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrl.replace(/\/$/, '')}/health`, { signal });
      if (!res.ok) return null;
      return (await res.json()) as { model: string; version?: string };
    });
  } catch {
    // Unreachable, wedged or non-JSON — all mean "cannot badge this as a model".
    return null;
  }
}

/**
 * Ask the real model for a queue curve.
 *
 * Returns null on ANY failure — unreachable, timeout, non-2xx, or a response
 * whose shape does not match the contract. Null is the caller's signal to fall
 * back, and it is deliberately indiscriminate: a half-understood response is not
 * a forecast, and guessing at it would reintroduce exactly the problem this
 * ticket is about.
 */
export async function predictGateQueue(
  deps: AiServiceDeps,
  steps: GateQueueModelInput[],
): Promise<PredictResponse | null> {
  if (steps.length === 0) return null;
  const fetchImpl = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  try {
    return await withTimeout(deps.timeoutMs ?? 4000, async (signal) => {
      const res = await fetchImpl(`${deps.baseUrl.replace(/\/$/, '')}/predict`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instances: steps.map(toInstance) }),
        signal,
      });
      if (!res.ok) return null;
      const body = (await res.json()) as PredictResponse;
      if (!Array.isArray(body?.predictions) || body.predictions.length !== steps.length) return null;
      return body;
    });
  } catch {
    return null;
  }
}

/**
 * Project a model response onto the canonical forecast DTO.
 *
 * The deferral windows come from the model's OWN `detail.deferralRecommended`
 * rather than from a threshold re-applied here — two places deciding the same
 * thing is how the rake forecaster ended up with two different sets of maths
 * (UC2-016).
 */
export function modelForecastToDto(
  gateId: string,
  generatedTs: string,
  stepTimestamps: string[],
  body: PredictResponse,
  modelVersion?: string,
): GateQueueForecastDTO {
  const curve = stepTimestamps.map((ts, i) => ({
    ts,
    predictedQueue: Math.max(0, Math.round(body.predictions[i] ?? 0)),
  }));
  const recommendedDeferralWindows: GateQueueForecastDTO['recommendedDeferralWindows'] = [];
  stepTimestamps.forEach((ts, i) => {
    if (!body.detail?.[i]?.deferralRecommended) return;
    const next = stepTimestamps[i + 1] ?? new Date(new Date(ts).getTime() + 15 * 60_000).toISOString();
    recommendedDeferralWindows.push({
      from: ts,
      to: next,
      reason: `Model predicts queue ${curve[i]!.predictedQueue} at ${gateId} — deferral recommended`,
    });
  });
  return {
    gateId,
    generatedTs,
    curve,
    recommendedDeferralWindows,
    source: 'MODEL',
    ...(modelVersion ? { modelVersion } : {}),
  };
}
