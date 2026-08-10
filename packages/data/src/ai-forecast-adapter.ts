/**
 * AiForecastAdapter — routes the gate-queue forecast through the real Python
 * model, and falls back to the heuristic **visibly** (ticket UC2-015).
 *
 * A decorator, like Poc3CargoAdapter: it overrides exactly one method and
 * delegates everything else, so nothing else in the dashboard changes shape.
 *
 * The acceptance for this ticket is behavioural — *"killing the Python service
 * visibly degrades the panel (badge flips), proving the wire is real"* — so the
 * fallback is not a silent safety net. It is the demonstration. Stop the
 * container and the Gate panel says HEURISTIC and why; start it and the badge
 * returns to MODEL with the version. That is the difference between claiming an
 * integration and showing one.
 */
import type {
  DataAdapter, GateQueueForecastDTO,
} from './interface.js';
import {
  aiHealth, modelForecastToDto, predictGateQueue,
  type AiServiceDeps, type GateQueueModelInput,
} from './ai-forecast.js';

/** How far ahead the curve runs, and at what resolution — matches the heuristic. */
const HORIZON_MIN = 120;
const STEP_MIN = 15;

export interface AiForecastAdapterDeps {
  /** Base URL of the gate-queue model service, e.g. '/ai/gate-queue'. */
  gateQueueBaseUrl: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Trucks inbound from the UC-3 twin, when it is running (UC2-054).
   *
   * Returning undefined is honest and expected: UC-3 is often not up, and the
   * response then records the value as a stand-in rather than implying a live
   * cross-twin subscription.
   */
  getUc3TruckInflow?: (gateId: string) => number | undefined;
  /** Clock seam, so tests do not depend on wall time. */
  now?: () => Date;
}

export class AiForecastAdapter implements DataAdapter {
  private base: DataAdapter;
  private ai: AiServiceDeps;
  private getUc3TruckInflow: (gateId: string) => number | undefined;
  private now: () => Date;
  /** Cached one health probe per adapter, so a curve does not cost two round trips. */
  private healthPromise: Promise<{ model: string; version?: string } | null> | null = null;

  constructor(base: DataAdapter, deps: AiForecastAdapterDeps) {
    this.base = base;
    this.ai = {
      baseUrl: deps.gateQueueBaseUrl,
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
      ...(deps.timeoutMs != null ? { timeoutMs: deps.timeoutMs } : {}),
    };
    this.getUc3TruckInflow = deps.getUc3TruckInflow ?? (() => undefined);
    this.now = deps.now ?? (() => new Date());
    this.adoptOptional(base);
  }

  /**
   * Forward every method the wrapped adapter has that this one does not.
   *
   * ⚠ WHY THIS IS NOT A HAND-WRITTEN LIST. `DataAdapter` declares ~49 OPTIONAL
   * methods — the whole customs/gate/export surface (`getIgmManifests`,
   * `getOocRecords`, `getShippingBills`, …) — which only `Poc3CargoAdapter`
   * implements. `SimAdapter`, the outermost decorator, tests each with
   * `this.base.getX ? … : unavailable()`. So any decorator between the two that
   * fails to re-expose a method does not raise a type error — the method is
   * optional, so dropping it is legal — it just makes `SimAdapter` report the
   * data as unavailable and the panel render empty.
   *
   * That is exactly what happened when this decorator was added with a
   * hand-written pass-through list of the 14 REQUIRED methods: the IGM, RMS,
   * OOC, E-DO, LEO, Shipping Bill, SMTP, EIR, PIN, advance-list, COPRAR/COARRI
   * and CFS/ECY panels all went blank in every data mode, with the backend
   * serving them correctly the whole time.
   *
   * Adopting dynamically means a method added to `Poc3CargoAdapter` tomorrow
   * survives this decorator without anyone remembering to come here. Keys
   * already defined on `this` are left alone, so the overridden
   * `getGateQueueForecast` and the typed pass-throughs below both win.
   */
  private adoptOptional(base: DataAdapter): void {
    const self = this as unknown as Record<string, unknown>;
    for (let o: object | null = base; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      for (const key of Object.getOwnPropertyNames(o)) {
        // `key in this` covers this class's own fields AND its prototype, so the
        // override and the explicit delegations are never clobbered.
        if (key in self) continue;
        const desc = Object.getOwnPropertyDescriptor(o, key);
        // Value-functions only: a getter would be invoked by reading it here.
        if (!desc || typeof desc.value !== 'function') continue;
        const fn = desc.value as (...a: unknown[]) => unknown;
        self[key] = (...a: unknown[]) => fn.apply(base, a);
      }
    }
  }

  get mode() {
    return this.base.mode;
  }

  /**
   * The one overridden read.
   *
   * Seeds the autoregression from the heuristic's own opening steps — the model
   * needs two lagged queue lengths and the dashboard holds no live queue series
   * for a gate. That is a real limitation, and it is why the model's answer is
   * labelled MODEL rather than LIVE: the inference is real, the seed is derived.
   */
  async getGateQueueForecast(gateId: string): Promise<GateQueueForecastDTO> {
    const fallback = await this.base.getGateQueueForecast(gateId);

    const health = await this.probe();
    if (!health) {
      return this.degraded(fallback, 'The gate-queue model service did not answer its health check.');
    }

    const start = this.now();
    const stepTimestamps: string[] = [];
    const steps: GateQueueModelInput[] = [];
    // Walk the horizon, feeding each prediction forward as the next lag.
    let lag1 = fallback.curve[0]?.predictedQueue ?? 0;
    let lag2 = fallback.curve[1]?.predictedQueue ?? lag1;
    for (let m = STEP_MIN; m <= HORIZON_MIN; m += STEP_MIN) {
      const ts = new Date(start.getTime() + m * 60_000);
      stepTimestamps.push(ts.toISOString());
      steps.push({
        queueLag1: lag1,
        queueLag2: lag2,
        hour: ts.getUTCHours(),
        uc3TruckInflow: this.getUc3TruckInflow(gateId) ?? 0,
      });
      lag2 = lag1;
      lag1 = fallback.curve[steps.length]?.predictedQueue ?? lag1;
    }

    const body = await predictGateQueue(this.ai, steps);
    if (!body) {
      return this.degraded(fallback, 'The gate-queue model service is reachable but did not return a usable prediction.');
    }
    return modelForecastToDto(gateId, start.toISOString(), stepTimestamps, body, health.version);
  }

  private probe() {
    // One probe per adapter instance. A page with several gate panels must not
    // health-check once per panel.
    if (!this.healthPromise) this.healthPromise = aiHealth(this.ai);
    return this.healthPromise;
  }

  /** Re-stamp a heuristic result with WHY the model did not answer. */
  private degraded(f: GateQueueForecastDTO, reason: string): GateQueueForecastDTO {
    return { ...f, source: 'HEURISTIC', fallbackReason: reason };
  }

  // -- everything else passes straight through --------------------------------
  getFacilities: DataAdapter['getFacilities'] = (...a) => this.base.getFacilities(...a);
  getTerminals: DataAdapter['getTerminals'] = (...a) => this.base.getTerminals(...a);
  getContainerMovements: DataAdapter['getContainerMovements'] = (...a) => this.base.getContainerMovements(...a);
  getGateOps: DataAdapter['getGateOps'] = (...a) => this.base.getGateOps(...a);
  getPendency: DataAdapter['getPendency'] = (...a) => this.base.getPendency(...a);
  getRailSide: DataAdapter['getRailSide'] = (...a) => this.base.getRailSide(...a);
  getRakeForecast: DataAdapter['getRakeForecast'] = (...a) => this.base.getRakeForecast(...a);
  getITRHO: DataAdapter['getITRHO'] = (...a) => this.base.getITRHO(...a);
  getScanQueue: DataAdapter['getScanQueue'] = (...a) => this.base.getScanQueue(...a);
  getEmptyPool: DataAdapter['getEmptyPool'] = (...a) => this.base.getEmptyPool(...a);
  getKPIs: DataAdapter['getKPIs'] = (...a) => this.base.getKPIs(...a);
  getNotifications: DataAdapter['getNotifications'] = (...a) => this.base.getNotifications(...a);
  getIntegrationHealth: DataAdapter['getIntegrationHealth'] = (...a) => this.base.getIntegrationHealth(...a);
  runScenario: DataAdapter['runScenario'] = (...a) => this.base.runScenario(...a);
}
