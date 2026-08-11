/**
 * Chaos-rehearsal helpers (UC2-041) — the logic half of the Integration Console.
 *
 * Kept out of the .tsx so it can be tested without pulling in Calcite, matching
 * `panels/customsEvidence.ts` and `panels/dqExport.ts`.
 */
import type { SourceMode } from './faultStore.js';

/** What a console control means to a real connector's `POST /inject-fault`. */
export type FaultLevel = 'AMBER' | 'RED' | null;

/**
 * Console mode → the level the connector is actually told.
 *
 * The two vocabularies are not the same and the mapping carries meaning:
 *
 *   LIVE     → null   clear the fault; the live upstream is tried again
 *   DEGRADED → AMBER  no fresh read — the connector replays last-known-good
 *   OFFLINE  → RED    down and untrusted — the cache is refused too
 *
 * AMBER and RED differing is the whole reason the drill has three steps rather
 * than two. A degraded source may honestly replay what it last got, with the
 * age shown; a source that is DOWN must not, because presenting an outage-era
 * payload as current is the failure the fallback story exists to prevent.
 */
export function levelForMode(mode: SourceMode, killed = false): FaultLevel {
  if (killed) return 'RED';
  if (mode === 'OFFLINE') return 'RED';
  if (mode === 'DEGRADED') return 'AMBER';
  return null;
}

export interface DrillStep {
  step: string;
  injected: 'AMBER' | 'RED' | null;
  expectedTier: string;
  tier: string;
  matched: boolean;
  emitted: number;
  mode: string;
  degradation: string;
  upstream: string | null;
  note: string | null;
  why: string;
}

export interface DrillReport {
  sourceSystem: string;
  liveUpstreamConfigured: boolean;
  steps: DrillStep[];
  allMatched: boolean;
}

export type VerdictTone = 'pass' | 'partial' | 'unconfigured' | 'none';

export interface DrillVerdict {
  tone: VerdictTone;
  headline: string;
  detail: string;
}

/**
 * Read a transcript and say plainly what it proved.
 *
 * The tone that matters most is `unconfigured`. With no live upstream the chain
 * starts on SYNTHETIC and stays there, so it never *falls* anywhere — and a
 * summary that reported "3 of 4 steps reached their tier" would be describing a
 * rehearsal in which nothing moved. That case gets its own verdict, not a score.
 */
export function drillVerdict(report: DrillReport | null): DrillVerdict {
  if (!report || report.steps.length === 0) {
    return {
      tone: 'none',
      headline: 'No drill ran',
      detail: 'The connector did not answer POST /drill, so nothing was exercised. '
        + 'This is not a pass — start the connector and run it again.',
    };
  }
  if (!report.liveUpstreamConfigured) {
    return {
      tone: 'unconfigured',
      headline: 'No live upstream — the chain could not move',
      detail: 'Every tier resolved to SYNTHETIC because there is nothing above it to fall from. '
        + 'Set POC3_BASE_URL and credentials on the connector to rehearse the real LIVE→CACHED→'
        + 'SYNTHETIC sequence.',
    };
  }
  const reached = report.steps.filter((s) => s.matched).length;
  if (report.allMatched) {
    return {
      tone: 'pass',
      headline: `All ${report.steps.length} steps reached their tier`,
      detail: tiersLine(report),
    };
  }
  return {
    tone: 'partial',
    headline: `${reached} of ${report.steps.length} steps reached their tier`,
    detail: `${tiersLine(report)} — ${report.steps.filter((s) => !s.matched)
      .map((s) => `${s.step} wanted ${s.expectedTier}, got ${s.tier}`)
      .join('; ')}`,
  };
}

/** "LIVE → CACHED → SYNTHETIC → LIVE" — the sequence as it actually happened. */
export function tiersLine(report: DrillReport): string {
  return report.steps.map((s) => s.tier).join(' → ');
}

/**
 * The transcript as text, for pasting into a rehearsal log or a bid annexe.
 *
 * Every step is included, matched or not. A copy button that quietly dropped the
 * failures would turn evidence into marketing.
 */
export function drillTranscript(report: DrillReport): string {
  const head = [
    `UC2-041 chaos rehearsal — ${report.sourceSystem}`,
    `live upstream configured: ${report.liveUpstreamConfigured ? 'yes' : 'no'}`,
    `sequence: ${tiersLine(report)}`,
    '',
  ];
  const body = report.steps.map((s) => [
    `${s.step}  [${s.matched ? 'reached' : 'MISSED'}]`,
    `  injected     ${s.injected ?? '(cleared)'}`,
    `  expected     ${s.expectedTier}`,
    `  served       ${s.tier}   (mode ${s.mode}, ${s.degradation}, ${s.emitted} events)`,
    `  upstream     ${s.upstream ?? '—'}`,
    `  note         ${s.note ?? '—'}`,
    `  why          ${s.why}`,
  ].join('\n'));
  return [...head, ...body].join('\n');
}
