/**
 * Domain types for the UC-II AI/ML model service (`ml/`, FastAPI :8200).
 *
 * The service answers with the `uc2-dashboard/1.0.0` document its own pipeline
 * publishes, wrapped in an `adapter` envelope — the same shape as
 * `ml/out/uc2/uc2_dashboard.json`, so panel numbers and evidence-pack numbers
 * are the same numbers. Three properties of that document drive the typing:
 *
 *  • **The model blocks are open.** Each of the seven models publishes six to
 *    fourteen fields and the set differs per model (M1 carries `dwellHours`, M7
 *    carries `priorityEvacuation`). A closed interface per model would need
 *    editing every time a model gains a field, and would silently DROP the new
 *    one in the meantime. So a block is `Record<string, ModelFieldValue>` and
 *    the UI renders whatever it is handed.
 *
 *  • **The glossary travels inside the document.** Every non-obvious key has a
 *    one-line definition in `glossary`, and the service's own self-test FAILS
 *    if a rendered key has neither a gloss nor a place in its self-evident
 *    list. That is what makes generic rendering honest rather than lazy: no
 *    field can reach an operator without a definition they can read.
 *
 *  • **Facility-level models are structurally separate.** M6 (lane assignment)
 *    and M7 (empty pool / reefer plugs) describe the gate and the yard, not the
 *    box on screen. They live in `facility_summary`, never inside a container,
 *    so the UI *cannot* render them as properties of one container even by
 *    mistake. Each carries `facility_scope` saying so in words.
 *
 * Nothing here is optional-by-convenience: a field is optional only where the
 * service genuinely may omit it (a contextual model a row did not earn, a
 * ledger on a row whose model did not run).
 */

/** A leaf value in a model block. `null` means "the model returned no value". */
export type ModelFieldValue =
  | string
  | number
  | boolean
  | null
  | ModelFieldValue[]
  | { [key: string]: ModelFieldValue };

/** One model's answer. Keys vary by model — see the note above. */
export type ModelBlock = Record<string, ModelFieldValue>;

/**
 * How one model input was arrived at. `observed: false` means the Python
 * adapter SUBSTITUTED a named constant because the row could not supply it.
 */
export interface MappingEntry {
  model_input: string;
  value: ModelFieldValue;
  /** 'Shipping_Line_Code', 'Container_No', 'DEFAULT', … */
  source: string;
  raw: string | null;
  /** The rule that produced the value, in words. */
  rule: string;
  observed: boolean;
}

/**
 * The per-container translation ledger.
 *
 * This is the honesty contract of the feature. A Movements row carries no yard
 * utilisation and no arrival cadence, so a dwell forecast built from it rests
 * on named substitutions. `assumptions` states each one. The frontend never
 * makes them — a second estimator here is exactly how two screens end up
 * showing different dwell times for the same box.
 */
export interface ContainerMapping {
  adapter_version: string;
  sheet: string;
  target_module: string;
  derived: MappingEntry[];
  assumptions: string[];
  warnings: string[];
  /** Counts of model INPUTS, not of models. See `estimatedLabel`. */
  inputs_observed: number;
  inputs_assumed: number;
}

/** One container's full prediction set. */
export interface ContainerPrediction {
  /** ISO-6346 number; the join key back to the Movements table. */
  container: string;
  terminal: string;
  vessel: string;
  /** True for the container the operator opened. */
  focus: boolean;
  /** True when any model in this block degraded or any input was assumed. */
  degraded: boolean;
  /** One entry per model that ran, keyed 'UC2-M1' … 'UC2-M5'. */
  models: Record<string, ModelBlock>;
  mapping: ContainerMapping | null;
}

/** Run metadata — what was asked for, what ran, what failed. */
export interface PredictionRun {
  containers_requested: number;
  containers_scored: number;
  containers_dropped: number;
  models_run: string[];
  models_failed: Array<{ model: string; error: string }>;
  /**
   * How many rows had their arrival cadence MEASURED from the batch rather
   * than assumed. This is why the whole visible page is sent, not one row.
   */
  cadence_measured_rows: number;
  cadence_assumed_rows: number;
  dropped_reason?: string;
}

/** The `uc2-dashboard/1.0.0` document. */
export interface PredictionDashboard {
  schema_version: string;
  generated_at_utc: string;
  run: PredictionRun;
  /** Model id → the plain-English question that model answers. */
  model_questions: Record<string, string>;
  /** Field key → one-line definition. Shipped inside the document. */
  glossary: Record<string, string>;
  containers: ContainerPrediction[];
  /**
   * Gate- and yard-level answers (M6, M7). Deliberately OUTSIDE `containers`:
   * these describe the whole request, and each block carries `facility_scope`
   * saying so.
   */
  facility_summary: Record<string, ModelBlock>;
}

/** The adapter envelope around the dashboard document. */
export interface PredictionAdapterInfo {
  moduleId: string;
  version: string;
  adapter_version: string;
  /** CONTAINER_BATCH — the page was scored together. */
  scope: string;
  max_batch: number;
  per_container_models: string[];
  contextual_models: string[];
  facility_models: string[];
  note: string;
}

/** The complete `POST /uc2/webapp/predictions` response. */
export interface PredictionResponse {
  schema: string;
  adapter: PredictionAdapterInfo;
  dashboard: PredictionDashboard;
}

/**
 * One Movements row as the service reads it.
 *
 * Column names are the Python adapter's own (PCS-native), because that is what
 * it validates against. Every value is something the app already OBSERVED —
 * this is a projection, not a translation. The one mapping that does exist
 * (`Origin_Stream` → the adapter's delivery-mode columns) happens in Python,
 * in `uc2_predictions.normalise_row`, and is recorded in the ledger.
 */
export interface PredictionRequestRow {
  Container_No: string;
  Terminal_Code?: string;
  Arrival_DateTime?: string;
  Gate_In_DateTime?: string;
  Gate_Out_DateTime?: string;
  Shipping_Line_Code?: string;
  Customs_Status?: string;
  ISO_Size_Type?: string;
  Nature_Of_Cargo?: string;
  Origin_Stream?: string;
  Laden?: string;
  Container_Status?: string;
  Vessel_Name?: string;
  Vessel_ETA?: string;
  Move_Type?: string;
  Truck_In_Time?: string;
  Vehicle_No?: string;
  Gate?: string;
  Yard_Block?: string;
  Seal_No?: string;
}
