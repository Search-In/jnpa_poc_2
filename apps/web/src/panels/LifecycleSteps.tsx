/**
 * The canonical lifecycle step strip — the primary navigation of the Import and
 * Export tabs.
 *
 * The step DATA lives in ./lifecycleSpec.ts (no React, so the architecture test
 * can assert against it directly). This file is the renderer, and re-exports the
 * spec so existing importers keep one import site.
 */
import { CalciteChip, CalciteIcon } from '@esri/calcite-components-react';
import { tokens } from '../theme/tokens.js';
import type { LifecycleStep, StepState } from './lifecycleSpec.js';

export * from './lifecycleSpec.js';

/**
 * - `real`        — filed customer documents back this step, and the UI shows them.
 * - `schema-only` — a valid message of this type exists, but not for a JNPA call,
 *                   so it demonstrates the schema and nothing about JNPA traffic.
 * - `absent`      — not in the corpus. The `note` says why.
 */
const STATE_STYLE: Record<StepState, { color: string; icon: string; label: string }> = {
  real: { color: tokens.congestion.GREEN, icon: 'check-circle', label: 'Real documents' },
  'schema-only': { color: tokens.severity.WARN, icon: 'exclamation-mark-triangle', label: 'Schema only' },
  absent: { color: tokens.color.textMuted, icon: 'circle-disallowed', label: 'Not in corpus' },
};

/**
 * The strip. `onSelectView` wires a step to an in-tab view; `onOpenTab` to another
 * tab. A step with neither is not clickable — it has nowhere to go, and pretending
 * otherwise would be worse than a static chip.
 */
export function LifecycleSteps({
  steps, title, onSelectView, onOpenTab, activeView, related,
}: {
  steps: LifecycleStep[];
  title: string;
  onSelectView?: (view: string) => void;
  onOpenTab?: (tab: string) => void;
  activeView?: string;
  /**
   * Shared surfaces this leg passes through that are NOT numbered steps in the
   * markdown's canonical order — Gate, Yard, CFS/ECY. Kept out of `steps` on
   * purpose: adding them would inflate the "N of 10" count and misstate the spec.
   */
  related?: Array<{ tab: string; label: string; note: string }>;
}) {
  const counts = {
    real: steps.filter((s) => s.state === 'real').length,
    schema: steps.filter((s) => s.state === 'schema-only').length,
    absent: steps.filter((s) => s.state === 'absent').length,
  };

  return (
    <div
      style={{
        border: `1px solid ${tokens.color.border}`, borderRadius: tokens.radius.md,
        background: tokens.color.bgElevated, padding: '10px 12px', marginBottom: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}>
        <strong style={{ fontSize: 13, color: tokens.color.text }}>{title}</strong>
        <span style={{ fontSize: 11.5, color: tokens.color.textMuted }}>
          {counts.real} of {steps.length} steps backed by filed documents
          {counts.schema > 0 && ` · ${counts.schema} schema-only`}
          {counts.absent > 0 && ` · ${counts.absent} not in corpus`}
        </span>
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'stretch' }}>
        {steps.map((s) => {
          const st = STATE_STYLE[s.state];
          const dest = s.view ? () => onSelectView?.(s.view!) : s.tab ? () => onOpenTab?.(s.tab!) : undefined;
          const clickable = Boolean(dest && (s.view ? onSelectView : onOpenTab));
          const isActive = Boolean(s.view && activeView && s.view === activeView);
          return (
            <button
              key={s.code}
              type="button"
              onClick={dest}
              disabled={!clickable}
              title={[
                `${s.no}. ${s.label} — ${st.label}`,
                s.note,
                s.tabLabel && clickable ? `Opens the ${s.tabLabel}` : undefined,
              ].filter(Boolean).join('\n\n')}
              style={{
                flex: '1 1 128px', minWidth: 128, textAlign: 'left',
                background: isActive ? tokens.color.bgPanel : 'transparent',
                border: `1px solid ${isActive ? tokens.color.brand : tokens.color.border}`,
                borderLeft: `3px solid ${st.color}`,
                borderRadius: tokens.radius.sm, padding: '6px 8px',
                cursor: clickable ? 'pointer' : 'default',
                font: 'inherit', color: 'inherit',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 10.5, fontWeight: 700, color: tokens.color.textMuted }}>{s.no}</span>
                <CalciteIcon icon={st.icon} scale="s" style={{ color: st.color }} />
              </div>
              <div style={{
                fontSize: 11.5, fontWeight: 600, color: tokens.color.text,
                lineHeight: 1.25, marginTop: 2,
              }}>
                {s.label}
              </div>
              {/* An absent or schema-only step carries its reason on the face of the
                  chip, not only in the tooltip — the gap is the message. */}
              {s.state !== 'real' && (
                <div style={{ fontSize: 10, color: tokens.color.textMuted, marginTop: 3, lineHeight: 1.3 }}>
                  {st.label}
                </div>
              )}
              {s.tabLabel && clickable && (
                <div style={{ fontSize: 10, color: tokens.color.brand, marginTop: 3 }}>
                  → {s.tabLabel}
                </div>
              )}
            </button>
          );
        })}
      </div>

      {/* Shared surfaces this leg passes through. Deliberately outside the numbered
          strip — they are not steps in the canonical order, and counting them would
          misstate coverage. */}
      {related && related.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span style={{ fontSize: 11, color: tokens.color.textMuted }}>Shared surfaces:</span>
          {related.map((r) => (
            <button
              key={r.tab}
              type="button"
              onClick={() => onOpenTab?.(r.tab)}
              disabled={!onOpenTab}
              title={r.note}
              style={{
                background: 'transparent', border: `1px solid ${tokens.color.border}`,
                borderRadius: tokens.radius.sm, padding: '3px 8px', font: 'inherit',
                fontSize: 11, color: onOpenTab ? tokens.color.brand : tokens.color.textMuted,
                cursor: onOpenTab ? 'pointer' : 'default',
              }}
            >
              → {r.label}
            </button>
          ))}
        </div>
      )}

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {(Object.keys(STATE_STYLE) as StepState[]).map((k) => (
          <CalciteChip
            key={k}
            scale="s"
            value={k}
            style={{ ['--calcite-chip-text-color' as never]: STATE_STYLE[k].color }}
          >
            {STATE_STYLE[k].label}
          </CalciteChip>
        ))}
        <span style={{ fontSize: 11, color: tokens.color.textMuted, alignSelf: 'center' }}>
          Hover any step for what the corpus does and does not contain for it.
        </span>
      </div>
    </div>
  );
}

