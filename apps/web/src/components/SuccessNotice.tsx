/**
 * SuccessNotice — the single, standardized success confirmation used across every
 * UC-II cargo operation (create/delete/discharge, yard assignment/planning, reefer,
 * rake, workflow, release). It is a thin wrapper over the existing Calcite
 * `CalciteNotice` (success kind + check-circle icon) so the icon, colour and
 * spacing are identical everywhere — this file is the one place that styling lives.
 *
 * Presentation only: it renders a title line plus an optional list of
 * `label: value` detail rows. Rows whose value is null/undefined/blank are omitted
 * (never fabricated), so a section only shows when the value is actually available.
 */
import type React from 'react';
import { CalciteNotice } from '@esri/calcite-components-react';
import { tokens } from '../theme/tokens.js';

export interface SuccessDetail {
  label: string;
  value?: string | number | null;
}

export function SuccessNotice({
  title, details, closable, onClose, style,
}: {
  title: string;
  details?: SuccessDetail[];
  closable?: boolean;
  onClose?: () => void;
  style?: React.CSSProperties;
}) {
  // Only keep rows whose value is actually present — never fabricate a section.
  const rows = (details ?? []).filter((d) => d.value != null && String(d.value).trim() !== '');
  return (
    <CalciteNotice
      open
      kind="success"
      icon="check-circle"
      scale="s"
      {...(closable ? { closable: true } : {})}
      onCalciteNoticeClose={onClose}
      style={style}
    >
      <div slot="title">{title}</div>
      {rows.length > 0 && (
        <div slot="message">
          {rows.map((d) => (
            <div key={d.label} style={{ marginTop: 2 }}>
              <span style={{ color: tokens.color.textMuted }}>{d.label}:</span>{' '}
              <strong style={{ color: tokens.color.text }}>{String(d.value)}</strong>
            </div>
          ))}
        </div>
      )}
    </CalciteNotice>
  );
}
