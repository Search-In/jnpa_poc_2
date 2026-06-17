/**
 * UN/EDIFACT tokenizer (prompt §4, D21A). Parses an interchange into segments
 * with component-resolved elements, honouring the optional UNA service-string
 * advice so non-default separators are handled. Pure + deterministic; no I/O.
 *
 * Default service characters (when no UNA segment present):
 *   component data element separator  ':'
 *   data element separator            '+'
 *   decimal notation                  '.'
 *   release (escape) character        '?'
 *   segment terminator                "'"
 */

export interface ServiceChars {
  component: string;
  element: string;
  decimal: string;
  release: string;
  segmentTerminator: string;
}

export const DEFAULT_SERVICE_CHARS: ServiceChars = {
  component: ':',
  element: '+',
  decimal: '.',
  release: '?',
  segmentTerminator: "'",
};

/** One EDIFACT segment: tag + elements; each element = array of components. */
export interface EdifactSegment {
  tag: string;
  /** elements[i][j] = component j of element i. */
  elements: string[][];
}

/** Parse the UNA service-string advice if present. Returns chars + body offset. */
function parseUNA(input: string): { chars: ServiceChars; offset: number } {
  if (input.startsWith('UNA') && input.length >= 9) {
    return {
      chars: {
        component: input[3]!,
        element: input[4]!,
        decimal: input[5]!,
        release: input[6]!,
        // input[7] is reserved (space); terminator is input[8]
        segmentTerminator: input[8]!,
      },
      offset: 9,
    };
  }
  return { chars: DEFAULT_SERVICE_CHARS, offset: 0 };
}

/** Split a string on `sep`, honouring the release (escape) character. */
function splitEscaped(value: string, sep: string, release: string): string[] {
  const out: string[] = [];
  let cur = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === release && i + 1 < value.length) {
      cur += value[i + 1];
      i++;
      continue;
    }
    if (ch === sep) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Tokenize a full EDIFACT interchange into segments. Whitespace/newlines
 * between segments are tolerated (real feeds often pretty-print).
 */
export function tokenizeEdifact(input: string): {
  chars: ServiceChars;
  segments: EdifactSegment[];
} {
  const trimmed = input.trim();
  const { chars, offset } = parseUNA(trimmed);
  const body = trimmed.slice(offset);

  const rawSegments = splitEscaped(body, chars.segmentTerminator, chars.release)
    .map((s) => s.replace(/[\r\n]+/g, '').trim())
    .filter((s) => s.length > 0);

  const segments: EdifactSegment[] = rawSegments.map((seg) => {
    const parts = splitEscaped(seg, chars.element, chars.release);
    const tag = parts[0] ?? '';
    const elements = parts
      .slice(1)
      .map((el) => splitEscaped(el, chars.component, chars.release));
    return { tag, elements };
  });

  return { chars, segments };
}

/** Convenience: get component (ei, ci) of a segment, or undefined. */
export function comp(seg: EdifactSegment, elementIdx: number, compIdx = 0): string | undefined {
  const v = seg.elements[elementIdx]?.[compIdx];
  return v === '' ? undefined : v;
}

/** First segment matching `tag`, or undefined. */
export function findSeg(segments: EdifactSegment[], tag: string): EdifactSegment | undefined {
  return segments.find((s) => s.tag === tag);
}

/** All segments matching `tag`. */
export function findAllSegs(segments: EdifactSegment[], tag: string): EdifactSegment[] {
  return segments.filter((s) => s.tag === tag);
}
