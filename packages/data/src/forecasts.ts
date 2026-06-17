/**
 * Deterministic gate-queue forecast for mock mode (prompt §5 getGateQueueForecast,
 * §7.2 Gate Queue Forecaster). This is a transparent heuristic so the dashboard
 * renders a 30–120 min curve offline; the LiveAdapter calls the real Temporal-
 * Fusion / LSTM model service instead. Recommended deferral windows are emitted
 * where the predicted queue exceeds a comfort threshold (feeds CGO-2 → UC3).
 */
import type { GateTransaction } from '@jnpa/schemas';
import type { GateQueueForecastDTO } from './interface.js';

const STEP_MIN = 15;
const HORIZON_MIN = 120;
const COMFORT_QUEUE = 8;

/** Hour-of-day arrival profile (relative weight) — peaks mid-morning/evening. */
const HOURLY_PROFILE = [
  0.3, 0.2, 0.2, 0.2, 0.3, 0.5, 0.8, 1.1, 1.4, 1.5, 1.4, 1.2, 1.0, 1.0, 1.1, 1.2, 1.3, 1.4, 1.2, 0.9, 0.7, 0.6, 0.5, 0.4,
];

export function simpleGateQueueForecast(
  gateId: string,
  txns: GateTransaction[],
  asOf: string,
): GateQueueForecastDTO {
  const gateTxns = txns.filter((t) => t.gateId === gateId);
  // baseline arrival rate (arrivals/hour) over observed history
  const ratePerHour = Math.max(2, Math.round(gateTxns.length / 24));
  const startMs = new Date(asOf).getTime();

  const curve: GateQueueForecastDTO['curve'] = [];
  const deferrals: GateQueueForecastDTO['recommendedDeferralWindows'] = [];
  let runningQueue = Math.round(ratePerHour / 4);

  for (let m = STEP_MIN; m <= HORIZON_MIN; m += STEP_MIN) {
    const ts = new Date(startMs + m * 60_000);
    const hour = ts.getUTCHours();
    const profile = HOURLY_PROFILE[hour] ?? 1;
    // arrivals this step minus a fixed service rate
    const arrivals = (ratePerHour * profile * STEP_MIN) / 60;
    const serviced = (6 * STEP_MIN) / 60; // ~6 vehicles/hour service
    runningQueue = Math.max(0, Math.round(runningQueue + arrivals - serviced));
    curve.push({ ts: ts.toISOString(), predictedQueue: runningQueue });
    if (runningQueue > COMFORT_QUEUE) {
      deferrals.push({
        from: ts.toISOString(),
        to: new Date(ts.getTime() + STEP_MIN * 60_000).toISOString(),
        reason: `Predicted queue ${runningQueue} > comfort ${COMFORT_QUEUE} at ${gateId}`,
      });
    }
  }

  return { gateId, generatedTs: asOf, curve, recommendedDeferralWindows: deferrals };
}
