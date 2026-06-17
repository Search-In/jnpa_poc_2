/**
 * Gate-automation feed (prompt §13, Appendix C req 7). Exposes validated gate
 * decisions a terminal TOS can consume for 100% gate automation: the twin checks
 * container/vehicle match, e-seal intact, customs status, and appointment
 * validity, returning an ALLOW/HOLD/DENY decision with reasons. Published as a
 * versioned CloudEvents stream on `jnpa.uc2.gate-decisions` (documented in
 * docs/API_CONTRACTS.md as a publishable integration contract).
 */
import type { CargoEvent } from '@jnpa/schemas';

export interface GateDecisionRequest {
  gateId: string;
  vehicleNo: string;
  containerNo: string;
  sealNo?: string;
  appointmentRef?: string;
  /** Caller-asserted current customs status if known. */
  customsStatus?: 'CLEAR' | 'HOLD' | 'EXAM' | 'PENDING';
  /** Whether Vahan reported the vehicle compliant (from ULIP Vahan lookup). */
  vehicleCompliant?: boolean;
}

export interface GateDecision {
  version: '1.0';
  gateId: string;
  containerNo: string;
  vehicleNo: string;
  decision: 'ALLOW' | 'HOLD' | 'DENY';
  reasons: string[];
  checks: {
    containerVehicleMatch: boolean;
    esealIntact: boolean;
    customsClear: boolean;
    appointmentValid: boolean;
    vehicleCompliant: boolean;
  };
  decidedTs: string;
}

export interface GateAutomationContext {
  /** Latest known events per container (from the silver fold) for validation. */
  eventsByContainer: Map<string, CargoEvent[]>;
  /** Valid appointment refs (from the UC3 trucking app / shipping docs). */
  validAppointments: Set<string>;
  now: () => string;
}

export function decideGate(req: GateDecisionRequest, ctx: GateAutomationContext): GateDecision {
  const reasons: string[] = [];
  const trail = ctx.eventsByContainer.get(req.containerNo) ?? [];

  // 1) container/vehicle match — a GATE_IN for this container should reference
  //    the same vehicle, or no prior gate-in exists (fresh arrival).
  const lastGateIn = [...trail].reverse().find((e) => e.eventType === 'GATE_IN');
  const containerVehicleMatch = !lastGateIn || !lastGateIn.vehicleNo || lastGateIn.vehicleNo === req.vehicleNo;
  if (!containerVehicleMatch) reasons.push(`Vehicle mismatch: gate-in was ${lastGateIn?.vehicleNo}`);

  // 2) e-seal intact — no ESEAL_BREAK after the last ESEAL_AFFIX.
  const lastAffix = [...trail].reverse().find((e) => e.eventType === 'ESEAL_AFFIX');
  const breakAfter = trail.some(
    (e) => e.eventType === 'ESEAL_BREAK' && (!lastAffix || e.ts >= lastAffix.ts),
  );
  const esealIntact = !breakAfter;
  if (!esealIntact) reasons.push('E-seal break detected since last affix');

  // 3) customs status
  const heldByEvent = trail.some((e) => e.eventType === 'CUSTOMS_FLAG');
  const customsClear = (req.customsStatus ?? (heldByEvent ? 'HOLD' : 'CLEAR')) === 'CLEAR';
  if (!customsClear) reasons.push(`Customs status not clear (${req.customsStatus ?? 'HOLD'})`);

  // 4) appointment valid (if provided)
  const appointmentValid = req.appointmentRef ? ctx.validAppointments.has(req.appointmentRef) : true;
  if (!appointmentValid) reasons.push(`Unknown appointment ${req.appointmentRef}`);

  // 5) vehicle compliant (Vahan)
  const vehicleCompliant = req.vehicleCompliant ?? true;
  if (!vehicleCompliant) reasons.push('Vehicle non-compliant per Vahan (fitness/permit/RC)');

  const checks = { containerVehicleMatch, esealIntact, customsClear, appointmentValid, vehicleCompliant };

  // Decision policy: any hard-fail (mismatch, broken seal, non-compliant) → DENY;
  // a customs hold or unknown appointment → HOLD; else ALLOW.
  let decision: GateDecision['decision'];
  if (!containerVehicleMatch || !esealIntact || !vehicleCompliant) {
    decision = 'DENY';
  } else if (!customsClear || !appointmentValid) {
    decision = 'HOLD';
  } else {
    decision = 'ALLOW';
  }

  return {
    version: '1.0',
    gateId: req.gateId,
    containerNo: req.containerNo,
    vehicleNo: req.vehicleNo,
    decision,
    reasons,
    checks,
    decidedTs: ctx.now(),
  };
}
