/**
 * InfoPopover — a small (i) button whose panel is rendered in a PORTAL on
 * document.body, positioned `fixed` at the button's viewport coordinates.
 *
 * Why a portal: these buttons live inside table cells, and the tables are wrapped
 * in `overflow-x: auto` for horizontal scrolling. An absolutely-positioned panel
 * inside a scroll container is CLIPPED by it — so the panel either vanished
 * behind the table edge or appeared entirely off-screen, which read as "the icon
 * does nothing". Portalling to the body escapes both the overflow clip and any
 * stacking context the table creates.
 *
 * Position is recomputed on scroll/resize so the panel tracks its button, and it
 * flips above the button when there is not enough room below. Closes on
 * click-away or Escape.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CalciteIcon } from '@esri/calcite-components-react';
import { tokens } from '../theme/tokens.js';

/** Above the app's slide-overs/dialogs (which use 1100/1101). */
const Z_BACKDROP = 2000;
const Z_PANEL = 2001;
const GAP = 6;
const MARGIN = 8;

export function InfoPopover({
  label, width = 330, children,
}: {
  /** Accessible name for the trigger, e.g. "Gate transaction detail for E-GTI-2". */
  label: string;
  width?: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const place = useCallback(() => {
    const btn = btnRef.current;
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    // Clamp horizontally so a right-hand column never pushes the panel off-screen.
    const left = Math.min(Math.max(MARGIN, r.left), Math.max(MARGIN, window.innerWidth - width - MARGIN));
    // Flip above when the panel would overflow the viewport bottom.
    const height = panelRef.current?.offsetHeight ?? 220;
    const below = r.bottom + GAP;
    const top = below + height > window.innerHeight - MARGIN
      ? Math.max(MARGIN, r.top - GAP - height)
      : below;
    setPos({ top, left });
  }, [width]);

  useLayoutEffect(() => {
    if (!open) return;
    place();
    // `true` → capture phase, so scrolling an inner container also repositions.
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={(e) => { e.stopPropagation(); setOpen((v) => !v); }}
        style={{
          display: 'inline-flex', alignItems: 'center', background: 'transparent',
          border: 'none', padding: 0, cursor: 'pointer', color: tokens.color.brand,
        }}
      >
        <CalciteIcon icon="information" scale="s" />
      </button>

      {open && typeof document !== 'undefined' && createPortal(
        <>
          <div
            onClick={() => setOpen(false)}
            style={{ position: 'fixed', inset: 0, zIndex: Z_BACKDROP }}
            aria-hidden
          />
          <div
            ref={panelRef}
            role="tooltip"
            style={{
              position: 'fixed',
              // Render off-screen for the first paint so the height can be measured
              // before it is placed — avoids a visible jump when flipping above.
              top: pos?.top ?? -9999,
              left: pos?.left ?? -9999,
              width,
              // border-box so `width` IS the outer width — the viewport clamp in
              // place() measures against this number, and with content-box the
              // padding + border would push the panel past the right edge.
              boxSizing: 'border-box',
              zIndex: Z_PANEL,
              textAlign: 'left',
              background: tokens.color.bgPanel,
              border: `1px solid ${tokens.color.border}`,
              borderRadius: 6,
              boxShadow: '0 8px 28px rgba(12,20,33,0.28)',
              padding: '10px 12px',
              fontSize: 12,
              lineHeight: 1.6,
              color: tokens.color.text,
              fontWeight: 400,
            }}
          >
            {children}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
