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
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { CalciteButton, CalciteChip, CalciteIcon } from '@esri/calcite-components-react';
import { simStore, TOUR_STEP_MS } from './simStore.js';
import { useSimStore } from './useSimStore.js';
import { getScript, type MetricChange, type TabId, type ValueTarget } from './scenarioPlayer.js';
import { handoffUrl, TWIN_LABEL } from './lifecycleHandoff.js';
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
function useSpotlightRect(tab: TabId | null, spotlight: string[] | null, dep: unknown): { rect: Rect | null; isRow: boolean } {
  const [state, setState] = useState<{ rect: Rect | null; isRow: boolean }>({ rect: null, isRow: false });
  useLayoutEffect(() => {
    setState({ rect: null, isRow: false });
    if (!tab) return;
    let cancelled = false;

    const valid = (r: { width: number; height: number; bottom: number; right: number }) =>
      r.width > 24 && r.height > 24 && r.bottom > 0 && r.right > 0;

    // The exact row/process the scenario is driving: the first spotlighted asset
    // (step.spotlight — existing What-If data) that resolves to an on-screen
    // [data-asset] element. A <calcite-table-row> lays its cells out via the
    // parent grid, so the row host can measure ~0 — union the cells' boxes so the
    // ring lands on the ROW, not the whole card.
    const rowRect = (): Rect | null => {
      for (const id of spotlight ?? []) {
        for (const host of Array.from(document.querySelectorAll<HTMLElement>(`[data-asset="${id}"]`))) {
          // The light-DOM <calcite-table-row> host is display:contents (~0×0). The
          // VISIBLE row is a <tr> rendered inside its OPEN shadow root, and each
          // cell's <td> lives in the calcite-table-cell's own shadow root. Resolve
          // the rendered row, trying in order: the shadow <tr>, the union of the
          // shadow <td>s, then the host itself. First measurable box wins.
          const sr = host.shadowRoot;
          const candidates: Array<DOMRect | undefined> = [];
          const tr = sr?.querySelector('tr, [role="row"]') ?? sr?.firstElementChild;
          if (tr) candidates.push(tr.getBoundingClientRect());
          const tds = Array.from(host.children)
            .map((cell) => (cell as HTMLElement).shadowRoot?.querySelector('td, [role="cell"], [role="gridcell"]') ?? (cell as HTMLElement).shadowRoot?.firstElementChild)
            .filter((td): td is Element => !!td)
            .map((td) => td.getBoundingClientRect())
            .filter((b) => b.width > 0 && b.height > 0);
          if (tds.length) {
            const top = Math.min(...tds.map((b) => b.top));
            const left = Math.min(...tds.map((b) => b.left));
            const right = Math.max(...tds.map((b) => b.right));
            const bottom = Math.max(...tds.map((b) => b.bottom));
            candidates.push(new DOMRect(left, top, right - left, bottom - top));
          }
          candidates.push(host.getBoundingClientRect());
          for (const b of candidates) {
            if (b && valid(b)) return { top: b.top, left: b.left, width: b.width, height: b.height };
          }
        }
      }
      return null;
    };

    const panelEl = () =>
      document.querySelector<HTMLElement>(`[data-tour-tab="${tab}"]`) ??
      document.querySelector<HTMLElement>('[data-tour-panels]');

    // When the step spotlights an asset that has an on-screen home (a [data-asset]
    // row/marker), the asset-level highlight owns it — the whole panel must NEVER
    // be ringed. Only ring the panel for spotlights with no DOM asset (e.g. a
    // KPI-only step), preserving that context.
    const assetOnScreen = () => (spotlight ?? []).some((id) => document.querySelector(`[data-asset="${id}"]`));

    const compute = (): { rect: Rect | null; isRow: boolean } => {
      const row = rowRect();
      if (row) return { rect: row, isRow: true };
      // The asset owns its own highlight — never ring the whole card.
      if (assetOnScreen()) return { rect: null, isRow: false };
      const r = panelEl()?.getBoundingClientRect();
      if (r && valid(r)) return { rect: { top: r.top, left: r.left, width: r.width, height: r.height }, isRow: false };
      return { rect: null, isRow: false };
    };

    // Continuously track the target so the ring stays attached through ANY scroll
    // (page, gate table, or any scrollable parent), layout change or target move —
    // not just discrete window scroll/resize events. Re-render only when the box
    // actually changes.
    let raf = 0;
    let lastKey = '';
    const loop = () => {
      if (cancelled) return;
      const s = compute();
      const key = s.rect
        ? `${Math.round(s.rect.top)}|${Math.round(s.rect.left)}|${Math.round(s.rect.width)}|${Math.round(s.rect.height)}|${s.isRow}`
        : `x|${s.isRow}`;
      if (key !== lastKey) { lastKey = key; setState(s); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [tab, spotlight, dep]);
  return state;
}

/** A resolved value-level highlight: where it is + the live number to pin. */
interface ValueHit { rect: Rect; value: string; tone: 'worse' | 'better' | 'neutral'; label: string; }

const css = (sel: string) => document.querySelector<HTMLElement>(sel);

/**
 * Resolve each step's `valueTargets` (a KPI card or a gate/facility row) to its
 * on-screen rect + the live number it shows, so the overlay can ring the EXACT
 * value that's moving. Re-measures every frame for a short burst after a step
 * change (the panel may still be laying out / the value still animating), then
 * tracks resize/scroll. Targets that aren't on screen are dropped (no stray box).
 */
function useValueRects(targets: ValueTarget[] | undefined, step: number): ValueHit[] {
  const [hits, setHits] = useState<ValueHit[]>([]);
  useLayoutEffect(() => {
    if (!targets || targets.length === 0) { setHits([]); return; }
    let cancelled = false;

    const resolve = (t: ValueTarget): ValueHit | null => {
      if (t.kind === 'kpi') {
        const card = css(`[data-kpi="${t.key}"]`);
        if (!card) return null;
        const r = card.getBoundingClientRect();
        if (r.width < 8 || r.height < 8 || r.bottom <= 0) return null;
        // KPI card: the big number is the first non-heading text block. KPI
        // rollup chip: no heading slot, so use the chip's own text.
        const heading = card.querySelector('[slot="heading"]');
        const valEl = heading ? card.querySelector('div') : card;
        const value = (valEl?.textContent ?? card.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 36);
        const label = heading?.textContent?.trim() ?? t.key;
        return { rect: r, value, tone: 'neutral', label };
      }
      // asset row (gate / facility)
      const row = css(`[data-asset="${t.id}"]`);
      if (!row) return null;
      const r = row.getBoundingClientRect();
      if (r.width < 8 || r.height < 8 || r.bottom <= 0) return null;
      return { rect: r, value: (row.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40), tone: 'neutral', label: t.id };
    };

    // Continuously track each target through ANY scroll / layout change / value
    // animation (not just window scroll/resize). Re-render only when a rect or the
    // pinned value actually changes.
    let raf = 0;
    let lastKey = '';
    const loop = () => {
      if (cancelled) return;
      const next = targets.map(resolve).filter((h): h is ValueHit => h != null);
      const key = next
        .map((h) => `${Math.round(h.rect.top)}|${Math.round(h.rect.left)}|${Math.round(h.rect.width)}|${Math.round(h.rect.height)}|${h.value}|${h.label}`)
        .join('~');
      if (key !== lastKey) { lastKey = key; setHits(next); }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => { cancelled = true; cancelAnimationFrame(raf); };
  }, [targets, step]);
  return hits;
}

export function GuidedTour({
  onTab,
  onCollapsedChange,
}: {
  /** `view` is the optional sub-view within that tab (see ScenarioStep.view). */
  onTab: (tab: TabId, view?: string) => void;
  /** Reports this coach-mark's minimised state so siblings (Reactive Guide) can react. */
  onCollapsedChange?: (collapsed: boolean) => void;
}) {
  const sim = useSimStore();
  const { scenarioId, stepIndex, autoAdvance, stepStartedAt } = sim.tour;
  const script = scenarioId ? getScript(scenarioId) : undefined;
  const step = script?.steps[stepIndex];

  // Drive the dashboard's active tab to the current step's tab.
  const lastTab = useRef<string | null>(null);
  useEffect(() => {
    if (step && lastTab.current !== `${stepIndex}:${step.tab}:${step.view ?? ''}`) {
      lastTab.current = `${stepIndex}:${step.tab}:${step.view ?? ''}`;
      onTab(step.tab, step.view);
    }
  }, [step, stepIndex, onTab]);

  const { rect, isRow } = useSpotlightRect(step?.tab ?? null, step?.spotlight ?? null, stepIndex);
  // Pin-point value highlights — the EXACT KPI cards / rows whose numbers move.
  // Re-resolved each sim tick so the ring tracks the value as it animates.
  const valueHits = useValueRects(step?.valueTargets, stepIndex);

  // Collapse the card to a compact pill so it never blocks the dashboard.
  const [collapsed, setCollapsed] = useState(false);
  // Surface the collapsed state so the Reactive Guide can hide while this coach is
  // expanded and reappear once it is minimised.
  useEffect(() => { onCollapsedChange?.(collapsed); }, [collapsed, onCollapsedChange]);

  // Draggable dialog: the header is the drag handle. The dropped position persists
  // until the tour ends or resets (position clears whenever the scenario changes).
  // null = the default docked position (bottom-right).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  useEffect(() => { setPos(null); }, [scenarioId]);
  const onDragStart = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button')) return; // let the minimise button work
    const panel = e.currentTarget.parentElement;
    if (!panel) return;
    const r = panel.getBoundingClientRect();
    const dx = e.clientX - r.left;
    const dy = e.clientY - r.top;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId); // keep receiving moves even off the handle
    const onMove = (ev: PointerEvent) => {
      setPos({
        x: Math.max(0, Math.min(ev.clientX - dx, window.innerWidth - 80)),
        y: Math.max(0, Math.min(ev.clientY - dy, window.innerHeight - 40)),
      });
    };
    const onUp = () => {
      handle.releasePointerCapture(e.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
    e.preventDefault();
  };

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

  // Tone for the value rings comes from the step's first metric (better/worse).
  const valueTone = step.metrics[0]?.tone ?? 'neutral';
  const valueColor = toneColor[valueTone];

  return (
    <>
      {/* One-time keyframes for the pin-point pulse. */}
      <style>{`
        @keyframes jnpaTourPulse {
          0%   { box-shadow: 0 0 0 0 var(--jnpa-tour-glow); }
          70%  { box-shadow: 0 0 0 10px transparent; }
          100% { box-shadow: 0 0 0 0 transparent; }
        }
      `}</style>

      {/* Soft outline around the active panel — context only. The pin-point
          value rings below are the real focus. No full-screen dim. */}
      {rect && (isRow || valueHits.length === 0) && (
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

      {/* Pin-point value highlights: a tight pulsing ring around the EXACT KPI
          card / table row whose number is changing, with a floating value tag.
          pointer-events off so the underlying value stays interactive. */}
      {valueHits.map((h, i) => (
        <div key={i} aria-hidden style={{ pointerEvents: 'none' }}>
          <div
            style={{
              position: 'fixed',
              top: h.rect.top - 4,
              left: h.rect.left - 4,
              width: h.rect.width + 8,
              height: h.rect.height + 8,
              border: `2.5px solid ${valueColor}`,
              borderRadius: 8,
              zIndex: 950,
              ['--jnpa-tour-glow' as never]: `${valueColor}66`,
              animation: 'jnpaTourPulse 1.6s ease-out infinite',
              transition: 'top 200ms ease, left 200ms ease, width 200ms ease, height 200ms ease',
            }}
          />
          {/* Value tag pinned to the top-right of the highlighted element. */}
          <div
            style={{
              position: 'fixed',
              top: h.rect.top - 13,
              left: Math.min(h.rect.left + h.rect.width - 4, window.innerWidth - 8),
              transform: 'translateX(-100%)',
              background: valueColor,
              color: '#fff',
              fontSize: 11,
              fontWeight: 700,
              padding: '1px 7px',
              borderRadius: 999,
              whiteSpace: 'nowrap',
              boxShadow: '0 2px 8px rgba(12,20,33,0.25)',
              zIndex: 951,
              maxWidth: 220,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {h.value || h.label}
          </div>
        </div>
      ))}

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
          // Dragged position (top/left) once moved; otherwise the default dock.
          ...(pos ? { top: pos.y, left: pos.x } : { bottom: 16, right: 16 }),
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
        {/* Header: scenario + step counter + minimize. Doubles as the drag handle. */}
        <div
          onPointerDown={onDragStart}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '10px 12px', background: tokens.color.brand, color: '#fff',
            borderRadius: '12px 12px 0 0',
            cursor: 'move', userSelect: 'none', touchAction: 'none',
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

        {/* Framing discipline (Integrity Rule §1-2): every number in a What-If
            step is a simulation result under stated assumptions — never a
            claimed JNPA baseline improvement. This caption is always visible
            while a scenario runs so the room can never mistake it. */}
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 6,
            margin: '8px 12px 0', padding: '4px 8px',
            background: 'rgba(242,169,59,0.12)', border: '1px solid #f2a93b55',
            borderRadius: 8, fontSize: 11, color: tokens.color.textMuted,
          }}
        >
          <CalciteIcon icon="information" scale="s" />
          <span>SIMULATED — modelled targets under stated assumptions; not claimed JNPA baselines.</span>
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

        {/* THE CHAIN DOES NOT END HERE.
            One monsoon crosses all three twins: it suspends pilot transfer in UC-1, lands
            the discharge late here, and releases that backlog as a truck surge onto UC-3's
            corridor. Offered as a link on the LAST step rather than an automatic redirect
            — the operator finishes reading the conclusion, the tab opens on a real click
            (so the browser does not block it), and a twin that is not running costs a dead
            tab rather than derailing the scenario on screen. */}
        {isLast && script.handoff && (
          <div
            style={{
              margin: '0 12px 10px',
              padding: 10,
              borderRadius: 6,
              border: `1px solid ${tokens.color.border}`,
              background: tokens.color.bgElevated,
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
            }}
          >
            <div style={{ fontSize: 11.5, fontWeight: 700, letterSpacing: 0.3, color: tokens.color.text }}>
              This is not the end of the cycle
            </div>
            <div style={{ fontSize: 12, color: tokens.color.textMuted, lineHeight: 1.5 }}>
              {script.handoff.because}
            </div>
            <CalciteButton
              scale="s"
              kind="brand"
              iconEnd="launch"
              width="full"
              title={`Opens ${TWIN_LABEL[script.handoff.twin]} in a new tab, at the scenario that continues this one`}
              onClick={() => {
                const h = script.handoff!;
                // noopener: the opened twin gets no handle back on this window.
                window.open(handoffUrl(h), '_blank', 'noopener,noreferrer');
              }}
            >
              {script.handoff.cta}
            </CalciteButton>
          </div>
        )}

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
