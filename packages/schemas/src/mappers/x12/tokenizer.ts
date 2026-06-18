/**
 * ANSI X12 tokenizer (prompt §4 / bid §8.4.1). The ISA segment is fixed-width:
 * its element separator is ISA[3], the sub-element separator is ISA[104], and
 * the segment terminator is ISA[105]. We read those from the ISA header so any
 * compliant interchange parses; default to '*' / '>' / '~' if no ISA present.
 */

export interface X12Delims {
  element: string;
  subElement: string;
  segment: string;
}

export const DEFAULT_X12_DELIMS: X12Delims = {
  element: '*',
  subElement: '>',
  segment: '~',
};

export interface X12Segment {
  tag: string;
  elements: string[];
}

function readDelims(input: string): X12Delims {
  if (input.startsWith('ISA') && input.length >= 106) {
    return {
      element: input[3]!,
      subElement: input[104]!,
      segment: input[105]!,
    };
  }
  return DEFAULT_X12_DELIMS;
}

export function tokenizeX12(input: string): { delims: X12Delims; segments: X12Segment[] } {
  const trimmed = input.trim();
  const delims = readDelims(trimmed);

  const segments = trimmed
    .split(delims.segment)
    .map((s) => s.replace(/[\r\n]+/g, '').trim())
    .filter((s) => s.length > 0)
    .map((seg) => {
      const parts = seg.split(delims.element);
      return { tag: parts[0] ?? '', elements: parts.slice(1) };
    });

  return { delims, segments };
}

/** element value (1-based, matching X12 docs) or undefined. */
export function el(seg: X12Segment, oneBasedIdx: number): string | undefined {
  const v = seg.elements[oneBasedIdx - 1];
  return v === '' ? undefined : v;
}

export function findX12(segments: X12Segment[], tag: string): X12Segment | undefined {
  return segments.find((s) => s.tag === tag);
}

export function findAllX12(segments: X12Segment[], tag: string): X12Segment[] {
  return segments.filter((s) => s.tag === tag);
}

/**
 * Parse an X12 date (CCYYMMDD or YYMMDD) + time (HHMM) into UTC ISO, preserving
 * the source offset (default IST +330). X12 carries local time.
 */
export function parseX12DateTime(
  date: string | undefined,
  time: string | undefined,
  offsetMin = 330,
): { iso: string; offsetMin: number } | undefined {
  if (!date) return undefined;
  let y: number;
  let m: number;
  let d: number;
  if (date.length === 8) {
    y = Number(date.slice(0, 4));
    m = Number(date.slice(4, 6));
    d = Number(date.slice(6, 8));
  } else if (date.length === 6) {
    y = 2000 + Number(date.slice(0, 2));
    m = Number(date.slice(2, 4));
    d = Number(date.slice(4, 6));
  } else {
    return undefined;
  }
  const hh = time && time.length >= 2 ? Number(time.slice(0, 2)) : 0;
  const mm = time && time.length >= 4 ? Number(time.slice(2, 4)) : 0;
  const utcMillis = Date.UTC(y, m - 1, d, hh, mm) - offsetMin * 60_000;
  return { iso: new Date(utcMillis).toISOString(), offsetMin };
}
