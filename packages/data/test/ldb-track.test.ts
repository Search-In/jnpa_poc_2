import { describe, expect, it } from 'vitest';
import { formatLeadTime, normalizeLdbSearch } from '../src/ldb-track.js';

describe('normalizeLdbSearch', () => {
  it('maps cntrInTransit into alternating timeline stops', () => {
    const track = normalizeLdbSearch(
      {
        objectType: 'ContainerSearchData',
        object: {
          result: 'success',
          cntrDetail: { cntrNumber: 'CCLU7468361', size: '40 Feet', containerType: '40 Feet HIGH CUBE', isoCode: '4510' },
          cntrInTransit: [
            {
              superOrg: 'JNPT, Mumbai',
              currentLocation: 'Raigad/BMCT - Export',
              containerGroupingList: [
                {
                  eventName: 'PORT IN',
                  timestampTimezone: '2026-07-31T06:50:57.000+00:00',
                  timeZoneAbvr: 'IST',
                  transportMode: 'TRUCK',
                  truckNumber: 'MH46AR2654',
                  datatyp: 'ldb',
                  type: 'E',
                },
              ],
            },
            {
              currentLocation: 'DPD',
              containerGroupingList: [
                {
                  eventName: 'DPD',
                  type: 'Laden',
                  datatyp: 'info',
                  timestampTimezone: '2026-06-07T18:30:00.000+00:00',
                  timeZoneAbvr: 'IST',
                  transportMode: 'BALMER LAWRIE CFS',
                },
              ],
            },
          ],
        },
      },
      'CCLU7468361',
    );
    expect(track.found).toBe(true);
    expect(track.stops).toHaveLength(2);
    expect(track.stops[0]!.superOrg).toBe('JNPT, Mumbai');
    expect(track.stops[0]!.events[0]!.truckNumber).toBe('MH46AR2654');
    expect(track.stops[1]!.events[0]!.dataType).toBe('info');
  });

  it('falls back to trackLog when cntrInTransit is empty', () => {
    const track = normalizeLdbSearch(
      {
        object: {
          trackLog: [
            {
              eventName: 'PORT OUT',
              currentLocation: 'BMCT',
              timestampTimezone: '2022-11-30T12:16:32.000+00:00',
              superorg: 'JNPT, Mumbai',
              transportmode: 'VESSEL',
              datatyp: 'ldb',
            },
          ],
        },
      },
      'CMAU5703058',
    );
    expect(track.found).toBe(true);
    expect(track.stops[0]!.location).toBe('BMCT');
    expect(track.stops[0]!.events[0]!.eventName).toBe('PORT OUT');
  });

  it('returns not-found for empty / No Record Found payloads', () => {
    expect(normalizeLdbSearch({ object: { result: 'No Record Found' } }, 'XXXX0000000').found).toBe(false);
    expect(normalizeLdbSearch({}, 'XXXX0000000').found).toBe(false);
  });
});

describe('formatLeadTime', () => {
  it('formats millisecond dwell like NLDS', () => {
    // 4 days + 13h + 45m
    expect(formatLeadTime((((4 * 24) + 13) * 60 + 45) * 60_000)).toBe('4Days 13Hr. 45Min.');
  });
});
