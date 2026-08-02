/**
 * NldsTrackDialog — NLDS Logistics Data Bank inland-transit timeline for one
 * container (Manage → Track). Mirrors the public LDB "Inland Transit Information"
 * journey view (https://ldb.co.in) using:
 *   GET /ldb/api/ldb/container/search?cntrNo={id}&searchType=39
 *
 * Layout is a single left-rail timeline (better readability in a slide-over than
 * a full-page zig-zag). Presentation-only — no cargo writes.
 */
import { useState, type ReactNode } from 'react';
import {
  CalciteButton, CalciteChip, CalciteIcon, CalciteLoader, CalciteNotice,
} from '@esri/calcite-components-react';
import {
  fetchLdbContainerTrack,
  formatLeadTime,
  type NldsContainerTrack,
  type NldsTrackEvent,
  type NldsTrackStop,
  type NldsVoyageEvent,
} from '@jnpa/data';
import { useAsync } from '../state/useAsync.js';
import { tokens } from '../theme/tokens.js';

const LDB_BASE = (import.meta.env?.VITE_LDB_API_BASE as string | undefined) || '/ldb';
const LDB_SEARCH_TYPE = (import.meta.env?.VITE_LDB_SEARCH_TYPE as string | undefined) || '39';

function formatTs(iso: string, tz?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dd}-${mm}-${yyyy} ${hh}:${mi}:${ss}${tz ? ` ${tz}` : ''}`;
}

function formatDateParts(iso: string): { day: string; mon: string; year: string } | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return {
    day: String(d.getDate()).padStart(2, '0'),
    mon: months[d.getMonth()]!,
    year: String(d.getFullYear()),
  };
}

function isInfoEvent(e: NldsTrackEvent): boolean {
  return (e.dataType ?? '').toLowerCase() === 'info';
}

function transportIcon(mode?: string): string {
  const m = (mode ?? '').toUpperCase();
  if (m.includes('VESSEL') || m.includes('SHIP')) return 'launch';
  if (m.includes('RAIL') || m.includes('TRAIN')) return 'train';
  if (m.includes('TRUCK') || m.includes('ROAD') || /^MH\d/i.test(mode ?? '')) return 'car';
  return 'pin';
}

function transportLabel(mode?: string): string | undefined {
  const m = (mode ?? '').trim();
  if (!m) return undefined;
  const u = m.toUpperCase();
  if (u === 'TRUCK' || u === 'VESSEL' || u === 'RAIL' || u === 'ROAD') return u;
  // LDB sometimes puts a CFS name in transportMode on info rows — skip those.
  if (u.includes('CFS') || u.includes('TERMINAL')) return undefined;
  return m;
}

function stopDuration(stop: NldsTrackStop): string | undefined {
  for (const e of stop.events) {
    const formatted = formatLeadTime(e.durationMs);
    if (formatted) return formatted;
  }
  if (stop.events.length >= 2) {
    const times = stop.events
      .map((e) => new Date(e.timestamp).getTime())
      .filter((t) => Number.isFinite(t));
    if (times.length >= 2) {
      return formatLeadTime(Math.max(...times) - Math.min(...times));
    }
  }
  return undefined;
}

function latestEvent(track: NldsContainerTrack): NldsTrackEvent | undefined {
  for (const stop of track.stops) {
    for (const e of stop.events) {
      if (!isInfoEvent(e) && e.eventName) return e;
    }
  }
  return track.stops[0]?.events[0];
}

function EventRow({ event, isLast }: { event: NldsTrackEvent; isLast: boolean }) {
  if (isInfoEvent(event)) {
    const label = (event.type || event.eventName || 'Status').trim();
    return (
      <div
        style={{
          margin: 12,
          padding: '12px 14px',
          background: tokens.track.infoBg,
          borderLeft: `4px solid ${tokens.track.infoBorder}`,
          borderRadius: `0 ${tokens.radius.md}px ${tokens.radius.md}px 0`,
          fontSize: 13,
          lineHeight: 1.45,
          color: tokens.color.text,
        }}
      >
        <div>
          Received as{' '}
          <strong style={{ color: tokens.track.timestamp }}>{label}</strong>
          {event.eventName && event.eventName !== label ? (
            <span style={{ color: tokens.color.textMuted }}> · {event.eventName}</span>
          ) : null}
        </div>
        {event.transportMode ? (
          <div style={{ marginTop: 6, fontSize: 12, color: tokens.color.textMuted, display: 'flex', alignItems: 'center', gap: 6 }}>
            <CalciteIcon icon="arrow-right" scale="s" />
            Next delivery to <strong style={{ color: tokens.color.text }}>{event.transportMode}</strong>
          </div>
        ) : null}
      </div>
    );
  }

  const mode = transportLabel(event.transportMode);

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '36px 1fr',
        gap: 10,
        padding: '12px 14px',
        borderBottom: isLast ? 'none' : `1px solid ${tokens.color.border}`,
        background: tokens.color.bgPanel,
      }}
    >
      <div
        style={{
          width: 36,
          height: 36,
          borderRadius: 8,
          background: tokens.track.modeBadge,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tokens.track.node,
        }}
        aria-hidden
      >
        <CalciteIcon icon={transportIcon(event.transportMode)} scale="m" />
      </div>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {event.truckNumber ? (
            <strong
              style={{
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: 13,
                letterSpacing: 0.2,
              }}
            >
              {event.truckNumber}
            </strong>
          ) : null}
          <span
            style={{
              fontWeight: 800,
              fontSize: 13,
              letterSpacing: 0.4,
              color: tokens.track.header,
              textTransform: 'uppercase',
            }}
          >
            {event.eventName}
          </span>
          {mode ? (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 700,
                letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: tokens.track.node,
                background: tokens.track.modeBadge,
                borderRadius: 999,
                padding: '2px 8px',
              }}
            >
              {mode}
            </span>
          ) : null}
        </div>
        <div
          style={{
            color: tokens.track.timestamp,
            fontWeight: 700,
            marginTop: 4,
            fontSize: 12.5,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {formatTs(event.timestamp, event.timeZone)}
        </div>
      </div>
    </div>
  );
}

function StopCard({ stop, index }: { stop: NldsTrackStop; index: number }) {
  const duration = stopDuration(stop);
  const header = stop.superOrg?.trim() || stop.location;
  const sub = stop.superOrg ? stop.location : undefined;
  const firstTs = stop.events[0]?.timestamp ?? '';
  const date = formatDateParts(firstTs);
  const onlyInfo = stop.events.length > 0 && stop.events.every(isInfoEvent);

  return (
    <div
      className="nlds-stop"
      style={{
        display: 'grid',
        gridTemplateColumns: '72px 28px 1fr',
        gap: 0,
        alignItems: 'stretch',
        animation: `nldsFadeIn 320ms ease ${Math.min(index, 8) * 45}ms both`,
      }}
    >
      {/* Date column */}
      <div
        style={{
          paddingTop: 14,
          paddingRight: 10,
          textAlign: 'right',
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {date ? (
          <>
            <div style={{ fontSize: 18, fontWeight: 800, color: tokens.track.header, lineHeight: 1.1 }}>
              {date.day}
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              {date.mon} {date.year}
            </div>
          </>
        ) : null}
      </div>

      {/* Spine */}
      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span
          aria-hidden
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            marginTop: 16,
            background: onlyInfo ? tokens.track.infoBorder : tokens.track.nodeRing,
            border: `3px solid ${onlyInfo ? tokens.track.timestamp : tokens.track.node}`,
            boxShadow: `0 0 0 3px ${tokens.track.line}`,
            zIndex: 1,
            flexShrink: 0,
          }}
        />
        <span
          aria-hidden
          style={{
            width: 3,
            flex: 1,
            minHeight: 24,
            background: tokens.track.line,
            borderRadius: 2,
            marginTop: 4,
          }}
        />
      </div>

      {/* Card */}
      <div
        style={{
          marginLeft: 12,
          marginBottom: 18,
          borderRadius: 10,
          overflow: 'hidden',
          background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`,
          boxShadow: tokens.track.cardShadow,
        }}
      >
        <div
          style={{
            background: tokens.track.header,
            color: '#fff',
            padding: '10px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <CalciteIcon icon={onlyInfo ? 'information' : 'pin'} scale="s" />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13.5, fontWeight: 700, lineHeight: 1.25 }}>{header}</div>
          </div>
          {duration ? (
            <span
              title="Dwell / lead time at this location"
              style={{
                fontSize: 11,
                fontWeight: 800,
                color: tokens.track.duration,
                background: tokens.track.durationBg,
                border: `1px solid ${tokens.track.duration}`,
                borderRadius: 6,
                padding: '3px 8px',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {duration}
            </span>
          ) : null}
        </div>
        {sub ? (
          <div
            style={{
              background: tokens.track.subheader,
              color: '#fff',
              padding: '7px 14px',
              fontSize: 12,
              fontWeight: 500,
              lineHeight: 1.35,
            }}
          >
            {sub}
          </div>
        ) : null}
        <div>
          {stop.events.map((e, i) => (
            <EventRow
              key={`${e.eventName}-${e.timestamp}-${i}`}
              event={e}
              isLast={i === stop.events.length - 1}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function VoyageCard({ event }: { event: NldsVoyageEvent }) {
  const date = formatDateParts(event.timestamp);
  const departed = event.eventName.toUpperCase().includes('DEPART');
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 28px 72px',
        gap: 0,
        alignItems: 'stretch',
        marginBottom: 14,
      }}
    >
      <div
        style={{
          borderRadius: 10,
          overflow: 'hidden',
          background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`,
          boxShadow: tokens.track.cardShadow,
        }}
      >
        <div
          style={{
            background: tokens.track.header,
            color: '#fff',
            padding: '10px 14px',
            fontSize: 13.5,
            fontWeight: 700,
          }}
        >
          {event.terminal || 'Terminal'}
        </div>
        <div style={{ padding: '12px 14px' }}>
          {event.vesselName ? (
            <div style={{ fontSize: 13, fontWeight: 700, color: tokens.color.text, marginBottom: 4 }}>
              Vessel Name:{' '}
              <span style={{ fontWeight: 800 }}>
                {event.vesselName}
                {event.vesselImo ? ` [IMO ${event.vesselImo}]` : ''}
              </span>
            </div>
          ) : null}
          {event.shippingLine ? (
            <div style={{ fontSize: 12.5, color: tokens.color.textMuted, marginBottom: 10 }}>
              Shipping Line: <strong style={{ color: tokens.color.text }}>{event.shippingLine}</strong>
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 8,
                background: tokens.track.modeBadge,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                color: tokens.track.node,
                flexShrink: 0,
              }}
              aria-hidden
            >
              <CalciteIcon icon="launch" scale="m" />
            </div>
            <div>
              <div
                style={{
                  fontWeight: 800,
                  fontSize: 13,
                  letterSpacing: 0.4,
                  color: tokens.track.header,
                  textTransform: 'uppercase',
                }}
              >
                {event.eventName}
              </div>
              <div
                style={{
                  color: tokens.track.timestamp,
                  fontWeight: 700,
                  marginTop: 4,
                  fontSize: 12.5,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {formatTs(event.timestamp, event.timeZone)}
              </div>
            </div>
          </div>
        </div>
      </div>

      <div style={{ position: 'relative', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        <span
          aria-hidden
          style={{
            width: 16,
            height: 16,
            borderRadius: '50%',
            marginTop: 18,
            background: departed ? tokens.track.timestamp : tokens.track.nodeRing,
            border: `3px solid ${departed ? tokens.track.timestamp : tokens.track.node}`,
            boxShadow: `0 0 0 3px ${tokens.track.line}`,
            zIndex: 1,
            flexShrink: 0,
          }}
        />
        <span
          aria-hidden
          style={{
            width: 3,
            flex: 1,
            minHeight: 24,
            background: tokens.track.line,
            borderRadius: 2,
            marginTop: 4,
          }}
        />
      </div>

      <div style={{ paddingTop: 14, paddingLeft: 8, fontVariantNumeric: 'tabular-nums' }}>
        {date ? (
          <>
            <div style={{ fontSize: 16, fontWeight: 800, color: tokens.track.header, lineHeight: 1.1 }}>
              {date.day}
            </div>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: tokens.color.textMuted, textTransform: 'uppercase' }}>
              {date.mon} {date.year}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}

function AccordionSection({
  title,
  count,
  defaultOpen,
  children,
  empty,
}: {
  title: string;
  count: number;
  defaultOpen: boolean;
  children: ReactNode;
  empty?: string;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section
      style={{
        marginBottom: 12,
        borderRadius: 10,
        overflow: 'hidden',
        border: `1px solid ${tokens.color.border}`,
        background: tokens.color.bgPanel,
        boxShadow: '0 1px 2px rgba(12,20,33,0.04)',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '12px 14px',
          border: 'none',
          cursor: 'pointer',
          background: open ? '#e8f1fa' : '#eef3f8',
          color: tokens.track.header,
          textAlign: 'left',
        }}
      >
        <CalciteIcon icon={open ? 'chevron-down' : 'chevron-right'} scale="s" />
        <strong style={{ flex: 1, fontSize: 13.5 }}>{title}</strong>
        <span
          style={{
            fontSize: 11,
            fontWeight: 800,
            color: tokens.track.node,
            background: tokens.track.modeBadge,
            borderRadius: 999,
            padding: '2px 8px',
          }}
        >
          {count}
        </span>
      </button>
      {open ? (
        <div style={{ padding: '14px 12px 6px', background: tokens.track.railBg }}>
          {count === 0 ? (
            <p style={{ margin: '4px 0 14px', fontSize: 12.5, color: tokens.color.textMuted }}>
              {empty ?? 'No records for this section.'}
            </p>
          ) : (
            children
          )}
        </div>
      ) : null}
    </section>
  );
}

function TimelineBody({ track }: { track: NldsContainerTrack }) {
  const latest = latestEvent(track);
  return (
    <div>
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 8,
          marginBottom: 16,
          padding: '12px 14px',
          background: tokens.color.bgPanel,
          border: `1px solid ${tokens.color.border}`,
          borderRadius: 10,
          boxShadow: '0 1px 2px rgba(12,20,33,0.04)',
        }}
      >
        <MetaChip label="Export" value={String(track.exportVoyage.length)} />
        <MetaChip label="Inland" value={String(track.stops.length)} />
        <MetaChip label="Import" value={String(track.importVoyage.length)} />
        {track.detail?.size ? <MetaChip label="Size" value={track.detail.size} /> : null}
        {latest?.eventName ? (
          <MetaChip label="Latest" value={latest.eventName} accent={tokens.track.node} />
        ) : null}
      </div>

      {/* NLDS accordion order: Export → Inland → Import */}
      <AccordionSection
        title="Export Voyage Information"
        count={track.exportVoyage.length}
        defaultOpen={track.exportVoyage.length > 0}
        empty="No export voyage events from NLDS/LDB."
      >
        {track.exportVoyage.map((e, i) => (
          <VoyageCard key={`export-${e.eventName}-${e.timestamp}-${i}`} event={e} />
        ))}
      </AccordionSection>

      <AccordionSection
        title="Inland Transit Information"
        count={track.stops.length}
        defaultOpen={
          track.stops.length > 0 &&
          track.exportVoyage.length === 0 &&
          track.importVoyage.length === 0
        }
        empty="No inland transit events from NLDS/LDB."
      >
        {track.stops.map((stop, i) => (
          <StopCard key={`${stop.location}-${i}`} stop={stop} index={i} />
        ))}
      </AccordionSection>

      <AccordionSection
        title="Import Voyage Information"
        count={track.importVoyage.length}
        defaultOpen={track.importVoyage.length > 0}
        empty="No import voyage events from NLDS/LDB."
      >
        {track.importVoyage.map((e, i) => (
          <VoyageCard key={`import-${e.eventName}-${e.timestamp}-${i}`} event={e} />
        ))}
      </AccordionSection>
    </div>
  );
}

function MetaChip({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '6px 12px',
        borderRadius: 8,
        background: tokens.track.railBg,
        border: `1px solid ${tokens.color.border}`,
        minWidth: 72,
      }}
    >
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: tokens.color.textMuted }}>
        {label}
      </span>
      <span style={{ fontSize: 13, fontWeight: 800, color: accent ?? tokens.color.text }}>{value}</span>
    </div>
  );
}

export function NldsTrackDialog({
  containerNo,
  onClose,
}: {
  containerNo: string;
  onClose: () => void;
}) {
  const state = useAsync<NldsContainerTrack>(
    () =>
      fetchLdbContainerTrack(containerNo, {
        baseUrl: LDB_BASE,
        searchType: LDB_SEARCH_TYPE,
      }),
    [containerNo],
  );

  return (
    <>
      <style>{`
        @keyframes nldsFadeIn {
          from { opacity: 0; transform: translateY(8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .nlds-stop:last-child > div:nth-child(2) > span:last-child {
          background: transparent !important;
        }
      `}</style>
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(12,20,33,0.45)', zIndex: 1100 }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={`NLDS track for ${containerNo}`}
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(560px, 100vw)',
          background: tokens.track.railBg,
          borderLeft: `1px solid ${tokens.color.border}`,
          boxShadow: '-16px 0 48px rgba(12,20,33,0.22)',
          zIndex: 1101,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 12,
            padding: '16px 18px',
            background: `linear-gradient(135deg, ${tokens.track.header} 0%, #0f2744 100%)`,
            color: '#fff',
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 10,
              background: 'rgba(255,255,255,0.12)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <CalciteIcon icon="pin-tear" scale="m" />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 11, opacity: 0.8, letterSpacing: 0.6, textTransform: 'uppercase', fontWeight: 600 }}>
              Container Track
            </div>
            <strong
              style={{
                display: 'block',
                fontSize: 20,
                letterSpacing: 0.6,
                marginTop: 2,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
            >
              {containerNo}
            </strong>
            {state.data?.detail?.containerType ? (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.9 }}>
                {state.data.detail.containerType}
                {state.data.detail.size ? ` · ${state.data.detail.size}` : ''}
              </div>
            ) : null}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'rgba(255,255,255,0.1)',
              border: 'none',
              color: '#fff',
              cursor: 'pointer',
              display: 'flex',
              borderRadius: 8,
              padding: 8,
            }}
          >
            <CalciteIcon icon="x" scale="m" />
          </button>
        </div>

        <div
          style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${tokens.color.border}`,
            background: tokens.color.bgPanel,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <CalciteChip scale="s" value="EXIM">EXIM</CalciteChip>
          <span style={{ fontSize: 12, color: tokens.color.textMuted }}>
            NLDS Logistics Data Bank
          </span>
          <CalciteButton
            scale="s"
            appearance="outline"
            kind="brand"
            iconStart="launch"
            style={{ marginLeft: 'auto' }}
            onClick={() => {
              const url = `https://ldb.co.in/ldb/containersearch/${LDB_SEARCH_TYPE}/${encodeURIComponent(containerNo)}/${Date.now()}`;
              window.open(url, '_blank', 'noopener,noreferrer');
            }}
          >
            Open on LDB
          </CalciteButton>
        </div>

        <div style={{ padding: '16px 14px 28px', overflowY: 'auto', flex: 1 }}>
          {state.loading ? (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12, padding: 56 }}>
              <CalciteLoader label="Loading NLDS track" scale="m" />
              <span style={{ fontSize: 12, color: tokens.color.textMuted }}>Fetching NLDS track…</span>
            </div>
          ) : state.error ? (
            <CalciteNotice open kind="danger" icon="exclamation-mark-triangle" scale="s">
              <div slot="title">Could not load track</div>
              <div slot="message">{state.error}</div>
            </CalciteNotice>
          ) : !state.data?.found ? (
            <CalciteNotice open kind="info" icon="information" scale="s">
              <div slot="title">No track record</div>
              <div slot="message">
                NLDS/LDB returned no voyage or inland transit events for {containerNo}.
              </div>
            </CalciteNotice>
          ) : (
            <TimelineBody track={state.data} />
          )}
        </div>
      </aside>
    </>
  );
}
