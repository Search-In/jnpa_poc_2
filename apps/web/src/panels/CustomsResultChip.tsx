/**
 * The customs result badge, with its provenance attached (ticket UC2-004).
 *
 * Renders the CLEAR / HOLD / EXAM chip exactly as before, then answers the
 * question an evaluator will ask of it: *what record says so?* Either the
 * document reference sits beside the badge, or the badge is marked SIMULATED.
 *
 * The lookup is per container and goes through the adapter's dedupeGet, so the
 * scan queue's handful of rows collapse to one request each and re-render
 * without re-fetching. PENDING rows never call — they assert nothing.
 */
import { CalciteChip } from '@esri/calcite-components-react';
import type { ContainerCustomsView } from '@jnpa/data';
import { useApp } from '../state/AppContext.js';
import { useAsync } from '../state/useAsync.js';
import { tokens } from '../theme/tokens.js';
import { customsEvidenceFor, type CustomsResult } from './customsEvidence.js';

const resultColor = (r?: string) =>
  r === 'EXAM' ? tokens.severity.CRIT : r === 'HOLD' ? tokens.severity.WARN : tokens.kpi.better;

export function CustomsResultChip({ containerNo, result }: { containerNo: string; result: CustomsResult }) {
  const { adapter } = useApp();

  // Only a badge that CLAIMS something needs substantiating. Skipping PENDING
  // also keeps the queue to one request per genuinely-flagged container.
  const shouldCheck = !!result && typeof adapter.getContainerCustoms === 'function';

  const state = useAsync<ContainerCustomsView | null>(
    () => (shouldCheck ? adapter.getContainerCustoms!(containerNo) : Promise.resolve(null)),
    [adapter, containerNo, shouldCheck],
  );

  const label = result ?? 'PENDING';
  const chip = (
    <CalciteChip value={label} style={{ ['--calcite-chip-text-color' as never]: resultColor(result) }}>
      {label}
    </CalciteChip>
  );

  if (!shouldCheck) return chip;

  // While the lookup is in flight, show the badge with NO provenance claim in
  // either direction — marking it simulated before the answer arrives would be
  // as wrong as marking it traced.
  if (state.loading) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {chip}
        <span style={{ fontSize: 10.5, color: tokens.color.textMuted }}>checking…</span>
      </span>
    );
  }

  // A failed lookup is not evidence of absence. Say the check did not complete
  // rather than convict the badge.
  if (state.error) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {chip}
        <span
          style={{ fontSize: 10.5, color: tokens.color.textMuted }}
          title={`Could not verify against the customs layer: ${state.error}`}
        >
          unverified
        </span>
      </span>
    );
  }

  const ev = customsEvidenceFor(result, state.data);

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
      {chip}
      {ev.traced ? (
        <span
          style={{ fontSize: 10.5, color: tokens.color.textMuted, whiteSpace: 'nowrap' }}
          title={`Traced to a filed customs record: ${ev.reference}`}
        >
          ✓ {ev.reference}
        </span>
      ) : (
        <CalciteChip
          scale="s"
          value="SIMULATED"
          title={ev.reason}
          style={{ ['--calcite-chip-text-color' as never]: tokens.severity.WARN }}
        >
          SIMULATED
        </CalciteChip>
      )}
    </span>
  );
}
