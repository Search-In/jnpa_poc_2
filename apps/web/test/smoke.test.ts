import { describe, expect, it } from 'vitest';
import { createAdapter } from '@jnpa/data';
import type { BaselinesConfig } from '@jnpa/kpi';
import { t, STRINGS } from '../src/i18n/strings.js';
import { tokens } from '../src/theme/tokens.js';
import terminalsConfig from '../../../config/terminals.json';
import baselinesConfig from '../../../config/baselines.json';

describe('web i18n', () => {
  it('resolves all three languages for every string key', () => {
    for (const key of Object.keys(STRINGS)) {
      expect(t(key, 'en')).toBeTruthy();
      expect(t(key, 'hi')).toBeTruthy();
      expect(t(key, 'mr')).toBeTruthy();
    }
  });
  it('falls back to en for an unknown key', () => {
    expect(t('does-not-exist', 'hi')).toBe('does-not-exist');
  });
});

describe('web theme tokens', () => {
  it('defines a colour for every facility type, mode and severity', () => {
    expect(Object.keys(tokens.facility)).toContain('TERMINAL');
    expect(Object.keys(tokens.mode)).toEqual(['LIVE', 'CACHED', 'SYNTHETIC']);
    expect(Object.keys(tokens.severity)).toEqual(['INFO', 'WARN', 'CRIT']);
  });
});

describe('web → adapter wiring (mock)', () => {
  it('createAdapter(mock) drives the whole surface the dashboard binds to', async () => {
    const adapter = createAdapter({
      mode: 'mock',
      terminalsConfig: terminalsConfig as never,
      baselines: baselinesConfig as unknown as BaselinesConfig,
    });
    expect(adapter.mode).toBe('mock');
    const kpis = await adapter.getKPIs();
    expect(kpis.length).toBe(11);
    const terminals = await adapter.getTerminals();
    expect(terminals.length).toBe(5);
  });
});
