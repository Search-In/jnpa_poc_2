/**
 * GuidedTour — the coach-mark overlay that narrates a What-If scenario as it
 * drives the live board. While a scenario tour is active it:
 *   - switches the dashboard to the step's tab and spotlights that panel,
 *   - draws a connector to the map (whose halos already mark the same assets),
 *   - shows plain-language copy + the metric chips that are changing + the
 *     automated action the twin took,
 *   - auto-advances on a timer (with a progress bar) and offers prev/next/stop.
 *
 * It is intentionally written for a non-port-ops viewer: every step says what is
 * changing and why, and the numbers are shown as before → after.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CalciteButton, CalciteChip, CalciteIcon } from '@esri/calcite-components-react';
import { simStore, TOUR_STEP_MS } from './simStore.js';
import { useSimStore } from './useSimStore.js';
import { getScript, type MetricChange, type TabId } from './scenarioPlayer.js';
import { tokens } from '../theme/tokens.js';

const toneColor: Record<MetricChange['tone'], string> = {
  worse: tokens.kpi.worse,
  better: tokens.kpi.better,
  neutral: tokens.color.textMuted,
};

interface Rect { top: number; left: number; width: number; height: number; }

/**
 * Read the on-screen rect of the element we want to spotlight for this step.
 *
 * Calcite hides inactive tab panels with `display:none`, so right after a tab
 * switch the target can measure 0×0 for a frame or two. We therefore retry over
 * a few frames and only accept a real, on-screen rect — never a zero/offscreen
 * one (which would paint a stray "white dot" + dim box at the top-left corner).
 */
function useSpotlightRect(tab: TabId | null, dep: unknown): Rect | null {
  const [rect, setRect] = useState<Rect | null>(null);
  useLayoutEffect(() => {
    setRect(null);
    if (!tab) return;
    let cancelled = false;
    let attempts = 0;

    const findEl = () =>
      document.querySelector<HTMLElement>(`[data-tour-tab="${tab}"]`) ??
      document.querySelector<HTMLElement>('[data-tour-panels]');

    const valid = (r: DOMRect) =>
      r.width > 24 && r.height > 24 && r.bottom > 0 && r.right > 0;

    const measure = () => {
      if (cancelled) return;
      const el = findEl();
      const r = el?.getBoundingClientRect();
      if (r && valid(r)) {
        setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
      } else if (attempts++ < 30) {
        // Keep trying until the panel is laid out (≈ up to ~0.5s of frames).
        requestAnimationFrame(measure);
      } else {
        setRect(null); // give up gracefully — no stray box
      }
    };
    requestAnimationFrame(measure);

    // Re-measure on resize/scroll so the ring tracks layout changes.
    const remeasure = () => {
      const el = findEl();
      const r = el?.getBoundingClientRect();
      if (r && valid(r)) setRect({ top: r.top, left: r.left, width: r.width, height: r.height });
    };
    window.addEventListener('resize', remeasure);
    window.addEventListener('scroll', remeasure, true);
    return () => {
      cancelled = true;
      window.removeEventListener('resize', remeasure);
      window.removeEventListener('scroll', remeasure, true);
    };
  }, [tab, dep]);
  return rect;
}

export function GuidedTour({ onTab }: { onTab: (tab: TabId) => void }) {
  const sim = useSimStore();
  const { scenarioId, stepIndex, autoAdvance, stepStartedAt } = sim.tour;
  const script = scenarioId ? getScript(scenarioId) : undefined;
  const step = script?.steps[stepIndex];

  // Drive the dashboard's active tab to the current step's tab.
  const lastTab = useRef<string | null>(null);
  useEffect(() => {
    if (step && lastTab.current !== `${stepIndex}:${step.tab}`) {
      lastTab.current = `${stepIndex}:${step.tab}`;
      onTab(step.tab);
    }
  }, [step, stepIndex, onTab]);

  const rect = useSpotlightRect(step?.tab ?? null, stepIndex);

  // Collapse the card to a compact pill so it never blocks the dashboard.
  const [collapsed, setCollapsed] = useState(false);

  // Progress bar for auto-advance — purely visual, resets each step.
  const [progress, setProgress] = useState(0);
  useEffect(() => {
    setProgress(0);
    if (!autoAdvance || !script) return;
    const isLast = stepIndex >= script.steps.length - 1;
    if (isLast) return;
    const start = performance.now();
    let raf = 0;
    const loop = (now: number) => {
      const p = Math.min(1, (now - start) / TOUR_STEP_MS);
      setProgress(p);
      if (p < 1) raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [autoAdvance, stepIndex, stepStartedAt, script]);

  if (!script || !step) return null;

  const isLast = stepIndex >= script.steps.length - 1;

  return (
    <>
      {/* Spotlight ring around the active dashboard panel. A localized glow —
          NOT a full-screen dim — so the rest of the dashboard stays fully
          visible while the tour runs. Pointer-events off so the panel stays
          interactive. */}
      {rect && (
        <div
          aria-hidden
          style={{
            position: 'fixed',
            top: rect.top - 5,
            left: rect.left - 5,
            width: rect.width + 10,
            height: rect.height + 10,
            border: `2px solid ${tokens.color.brand}`,
            borderRadius: 10,
            boxShadow: `0 0 0 3px rgba(26,115,194,0.18)`,
            pointerEvents: 'none',
            zIndex: 900,
            transition: 'all 240ms ease',
          }}
        />
      )}

      {/* Collapsed pill: a tiny bottom-right chip so the dashboard is fully
          visible. Click to expand the full coach-mark again. */}
      {collapsed && (
        <button
          onClick={() => setCollapsed(false)}
          aria-label="Expand guided scenario"
          style={{
            position: 'fixed', bottom: 16, right: 16, zIndex: 1000,
            display: 'flex', alignItems: 'center', gap: 8,
            background: tokens.color.brand, color: '#fff', border: 'none',
            borderRadius: 999, padding: '8px 14px', cursor: 'pointer',
            boxShadow: '0 8px 24px rgba(12,20,33,0.28)', fontSize: 13, fontWeight: 600,
          }}
        >
          <CalciteIcon icon={script.icon} scale="s" />
          What-If · {script.title} · {stepIndex + 1}/{script.steps.length}
          <CalciteIcon icon="chevron-up" scale="s" />
        </button>
      )}

      {/* Coach-mark card — docked bottom-right and compact so the map + panels
          stay visible. Collapsible to the pill above. */}
      {!collapsed && (
      <div
        role="dialog"
        aria-label={`Guided scenario: ${script.title}`}
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          width: 'min(380px, calc(100vw - 32px))',
          maxHeight: 'calc(100vh - 32px)',
          overflowY: 'auto',
          background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: 12,
          boxShadow: '0 12px 40px rgba(12,20,33,0.28)',
          zIndex: 1000,
        }}
      >
        {/* Header: scenario + step counter + minimize */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', background: tokens.color.brand, color: '#fff',
            borderRadius: '12px 12px 0 0',
          }}
        >
          <CalciteIcon icon={script.icon} scale="s" />
          <strong style={{ fontSize: 13 }}>What-If · {script.title}</strong>
          <span style={{ marginLeft: 'auto', fontSize: 12, opacity: 0.9 }}>
            {stepIndex + 1}/{script.steps.length}
          </span>
          <button
            onClick={() => setCollapsed(true)}
            aria-label="Minimise"
            title="Minimise"
            style={{ background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', display: 'flex', padding: 2 }}
          >
            <CalciteIcon icon="chevron-down" scale="s" />
          </button>
        </div>

        {/* Progress dots */}
        <div style={{ display: 'flex', gap: 5, padding: '8px 12px 0' }}>
          {script.steps.map((_, i) => (
            <button
              key={i}
              onClick={() => simStore.gotoStep(i)}
              aria-label={`Go to step ${i + 1}`}
              style={{
                flex: 1, height: 5, borderRadius: 3, border: 'none', cursor: 'pointer', padding: 0,
                background:
                  i < stepIndex ? tokens.color.brand
                  : i === stepIndex ? tokens.color.border
                  : tokens.color.bgElevated,
                position: 'relative', overflow: 'hidden',
              }}
            >
              {i === stepIndex && (
                <span
                  style={{
                    position: 'absolute', inset: 0, transformOrigin: 'left',
                    transform: `scaleX(${progress})`, background: tokens.color.brand,
                    transition: 'transform 80ms linear',
                  }}
                />
              )}
            </button>
          ))}
        </div>

        {/* Body */}
        <div style={{ padding: '10px 12px 2px' }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: tokens.color.text }}>{step.title}</div>
          <p style={{ fontSize: 12.5, lineHeight: 1.45, color: tokens.color.textMuted, margin: '5px 0 9px' }}>
            {step.explain}
          </p>

          {/* Metric chips: what's changing, before → after */}
          {step.metrics.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 10 }}>
              {step.metrics.map((m, i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 6,
                    border: `1px solid ${tokens.color.border}`, borderRadius: 8,
                    padding: '4px 8px', fontSize: 12, background: tokens.color.bgElevated,
                  }}
                >
                  <span style={{ color: tokens.color.textMuted }}>{m.label}</span>
                  <span style={{ color: tokens.color.textMuted }}>{m.from}</span>
                  <CalciteIcon icon="arrow-right" scale="s" />
                  <strong style={{ color: toneColor[m.tone] }}>
                    {m.to}{m.unit ? ` ${m.unit}` : ''}
                  </strong>
                </div>
              ))}
            </div>
          )}

          {/* Map pointer: tells the viewer to look at the highlighted asset(s)
              on the map, and names them so the link is explicit. */}
          {step.spotlight.length > 0 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8, fontSize: 12, color: tokens.color.brand }}>
              <CalciteIcon icon="pin-tear" scale="s" />
              <span>On the map: <strong>{step.spotlight.join(', ')}</strong> (ringed &amp; centred)</span>
            </div>
          )}

          {/* Automated action the twin took */}
          {step.action && (
            <div
              style={{
                display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6,
                background: 'rgba(26,115,194,0.08)', border: `1px solid ${tokens.color.brand}33`,
                borderRadius: 8, padding: '6px 10px',
              }}
            >
              <CalciteChip scale="s" kind={step.action.kind === 'CROSS_TWIN_PUSH' ? 'brand' : 'neutral'} value={step.action.kind}>
                {step.action.kind.replace(/_/g, ' ')}
              </CalciteChip>
              <span style={{ fontSize: 12, color: tokens.color.text }}>{step.action.detail}</span>
            </div>
          )}
        </div>

        {/* Footer controls */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
            padding: '8px 12px 10px', borderTop: `1px solid ${tokens.color.border}`,
          }}
        >
          <CalciteButton
            scale="s" appearance="outline" iconStart="chevron-left"
            disabled={stepIndex === 0}
            onClick={() => simStore.prevStep()}
          >
            Back
          </CalciteButton>
          <CalciteButton
            scale="s" appearance="transparent"
            iconStart={autoAdvance ? 'pause' : 'play'}
            onClick={() => simStore.setTourAutoAdvance(!autoAdvance)}
          >
            {autoAdvance ? 'Pause' : 'Auto-play'}
          </CalciteButton>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <CalciteButton scale="s" appearance="outline" kind="neutral" iconStart="x" onClick={() => simStore.stopScenario()}>
              End & reset
            </CalciteButton>
            {isLast ? (
              <CalciteButton scale="s" kind="brand" iconStart="check" onClick={() => simStore.stopScenario()}>
                Finish
              </CalciteButton>
            ) : (
              <CalciteButton scale="s" kind="brand" iconEnd="chevron-right" onClick={() => simStore.nextStep()}>
                Next
              </CalciteButton>
            )}
          </div>
        </div>
      </div>
      )}
    </>
  );
}
