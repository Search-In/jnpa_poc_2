/**
 * What the customs importer will make of a filename — mirrored client-side.
 *
 * The server identifies a customs document from its NAME, not its contents
 * (`services/customs/service.py :: detect_parser`), and rejects anything it does
 * not recognise with `UnknownCustomsFormat` rather than guessing. That is the
 * right call server-side — junk is reported, never silently mis-imported — but it
 * leaves the operator holding a file with no way to know whether it will be
 * accepted until after they upload it.
 *
 * So the rules are mirrored here and shown before the upload: the dialog names
 * the module the file will land in, or says plainly that it will be refused.
 *
 * ⚠ THIS MUST TRACK THE SERVER. It is a copy of someone else's decision, which is
 * the kind of thing that rots quietly. `test/customs-format.test.ts` pins every
 * branch against the corpus's real filenames; if the server's rules change, change
 * them here in the same commit.
 *
 * Server rules, in order (basename, case-insensitive):
 *   CHPOI03…  → IGM            CHPOI10… → OOC            CHPOI13… → SMTP
 *   *.TXT     → RMS scan list
 *   *.XLSX    → LEO if the header row has "Rotation Number" or "LEO Date",
 *               otherwise Shipping Bill
 *   anything else → rejected
 */

export interface CustomsFormatGuess {
  /** The importer module, e.g. 'IGM'. Null when the file will be refused. */
  module: string | null;
  /** Human sentence for the dialog. */
  detail: string;
  /**
   * True when the module cannot be settled from the name alone. The `.xlsx`
   * branch needs the header row, which the server reads and we deliberately do
   * not — parsing a workbook in the browser to preview a label is not worth it.
   */
  needsContent?: boolean;
}

/** The rules, for display. Kept beside the logic so they cannot disagree. */
export const CUSTOMS_FILENAME_RULES: Array<{ pattern: string; module: string }> = [
  { pattern: 'CHPOI03…', module: 'IGM — import general manifest' },
  { pattern: 'CHPOI10…', module: 'OOC — bill of entry / out-of-charge' },
  { pattern: 'CHPOI13…', module: 'SMTP — transhipment permit' },
  { pattern: '….txt', module: 'RMS — scan selection list' },
  { pattern: '….xlsx', module: 'LEO or Shipping Bill — decided by the header row' },
];

export function describeCustomsFile(filename: string): CustomsFormatGuess {
  // The server upper-cases the BASENAME; a path separator in a browser File name
  // is not expected, but stripping it costs nothing and mirrors os.path.basename.
  const name = (filename.split(/[\\/]/).pop() ?? '').toUpperCase();

  if (!name) {
    return { module: null, detail: 'No file chosen.' };
  }
  // Prefix rules run BEFORE the extension rules on the server, so a
  // CHPOI03….txt is an IGM, not an RMS list. Order matters here too.
  if (name.startsWith('CHPOI03')) {
    return { module: 'IGM', detail: 'Recognised as an import general manifest (CHPOI03).' };
  }
  if (name.startsWith('CHPOI10')) {
    return { module: 'OOC', detail: 'Recognised as a bill of entry with out-of-charge (CHPOI10).' };
  }
  if (name.startsWith('CHPOI13')) {
    return { module: 'SMTP', detail: 'Recognised as a transhipment permit (CHPOI13).' };
  }
  if (name.endsWith('.TXT')) {
    return { module: 'RMS', detail: 'Recognised as an RMS scan selection list (.txt).' };
  }
  if (name.endsWith('.XLSX')) {
    return {
      module: 'LEO or SHIPPING_BILL',
      detail: 'A customs spreadsheet — the server reads the header row to decide: '
        + 'a "Rotation Number" or "LEO Date" column makes it a LEO, otherwise a Shipping Bill.',
      needsContent: true,
    };
  }
  return {
    module: null,
    detail: 'This filename matches no customs pattern, so the server will refuse it '
      + '(unrecognised_customs_format). Customs documents are identified by name — '
      + 'renaming a file to fit is not a workaround, it would mis-file the document.',
  };
}
