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

  it('maps Export / Import Voyage Information from vesselStatus* fields', () => {
    const track = normalizeLdbSearch(
      {
        object: {
          result: 'success',
          cntrDetail: { cntrNumber: 'SEGU5833837', size: '40 Feet', containerType: '40 Feet HIGH CUBE', isoCode: '4510' },
          vesselStatusExportDpt: {
            eventname: 'VESSEL DEPARTED',
            orgname: 'Bharat Mumbai Container Terminals (PSA)',
            timetimestamp: '2026-05-31T10:25:00.000+00:00',
            timezoneabvr: 'IST',
            vesselname: 'HMM LIME',
            vesselimo: '9998511',
            shippingline: 'HMM SHIPPING INDIA PRIVATE LIMITED',
          },
          vesselStatusExportArv: {},
          vesselStatusImportArv: {
            eventname: 'VESSEL ARRIVED',
            orgname: 'Bharat Mumbai Container Terminals (PSA)',
            timetimestamp: '2026-05-04T10:24:00.000+00:00',
            timezoneabvr: 'IST',
            vesselname: 'HMM PROMISE',
            vesselimo: '9742168',
            shippingline: 'HMM SHIPPING INDIA PRIVATE LIMITED',
          },
          vesselStatusImportDpt: {},
        },
      },
      'SEGU5833837',
    );
    expect(track.found).toBe(true);
    expect(track.exportVoyage).toHaveLength(1);
    expect(track.exportVoyage[0]!.eventName).toBe('VESSEL DEPARTED');
    expect(track.exportVoyage[0]!.vesselName).toBe('HMM LIME');
    expect(track.exportVoyage[0]!.vesselImo).toBe('9998511');
    expect(track.importVoyage).toHaveLength(1);
    expect(track.importVoyage[0]!.eventName).toBe('VESSEL ARRIVED');
    expect(track.importVoyage[0]!.vesselName).toBe('HMM PROMISE');
  });
});

describe('formatLeadTime', () => {
  it('formats millisecond dwell like NLDS', () => {
    // 4 days + 13h + 45m
    expect(formatLeadTime((((4 * 24) + 13) * 60 + 45) * 60_000)).toBe('4Days 13Hr. 45Min.');
  });
});
