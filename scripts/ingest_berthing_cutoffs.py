"""
Parse the terminals' daily berthing PDFs for the GATE OPEN / GATE CUTOFF times
and the SAILED sailing times, and populate `core.berthing_report_vessel`.

WHY THIS EXISTS
---------------
`core.berthing_report_vessel` has `gate_open_ts`, `cutoff_dry_ts` and
`cutoff_reefer_ts` columns and **775 rows with none of them populated**. Nothing
in either repository writes that table — the rows were loaded outside it — so
there is no importer to extend.

The cut-off is what edge case EC-1 (shutout risk) is defined on: "predicted scan
completion vs vessel cut-off". Without it EC-1 cannot be implemented at all. The
values ARE in the PDFs, in the VESSELS EXPECTED panel:

    VESSEL NAME   VIA        ETA            GATE OPEN  GATE CUTOFF
    LIBRA         LBAS0982   Tue/21/07 05:00  18/0200   19/0200 21/0200
                                              ^gate open ^dry    ^reefer

Times are `dd/HHMM` — day-of-month plus HHMM, with the month and year implied by
the report date. A row carries either ONE such token (gate open only) or THREE
(gate open, cut-off dry, cut-off reefer).

USAGE
-----
Dry run (default — reads PDFs and the DB, writes NOTHING):

    export BERTHING_DSN='postgresql://user:pass@host:5432/db'
    python scripts/ingest_berthing_cutoffs.py --pdf-dir /path/to/Complete_Week_...

Apply:

    python scripts/ingest_berthing_cutoffs.py --pdf-dir ... --yes

Idempotent: matches an existing vessel row on (report_date, terminal, via_no) and
only ever fills a NULL. It never overwrites a populated value and never inserts.
"""
import argparse
import asyncio
import datetime as dt
import os
import re
import sys
from collections import defaultdict
from pathlib import Path

import asyncpg
import pdfplumber

# A VIA/rotation code: 3–4 letters then S/R + 4 digits, or a bare S+4 digits.
_VIA = re.compile(r"\b([A-Z0-9]{0,4}[SR]\d{4})\b")
# `dd/HHMM` — the gate-open / cut-off format.
_GATE = re.compile(r"\b(\d{1,2})/(\d{4})\b")
# Section headings we care about.
_EXPECTED = re.compile(r"VESSELS?\s+EXPECTED", re.I)
_SAILED = re.compile(r"SAILED\s+VESSELS?|SAILED\s+VESSEL", re.I)
_OTHER_SECTION = re.compile(r"VESSELS?\s+ON\s+BERTH|VESSELS?\s+ON\s+BERTHED|TIDE|YARD", re.I)

# Filename → terminal. The corpus uses a different convention per terminal and
# per drop, so both the July week's `NSICT_2026-07-20.pdf` and June's
# `BERTHING-CT 06062026.pdf` have to resolve. Order matters: the more specific
# keys are checked first.
TERMINAL_FROM_NAME = {
    "APMT": "APMT", "BMCT": "BMCT", "NSICT": "NSICT", "NSIGT": "NSIGT",
    "BERTHING-CT": "NSICT", "BERTHING_CT": "NSICT",
    "BERTHING-GT": "NSIGT", "BERTHING_GT": "NSIGT",
    "Berthing_Sheet": "BMCT",
    "Daily_Berthing_Report": "NSFT",
}


def terminal_of(path: Path) -> str | None:
    for key, code in TERMINAL_FROM_NAME.items():
        if key.lower() in path.name.lower():
            return code
    return None


def report_date_of(path: Path) -> dt.date | None:
    """Report date from the filename: `NSICT_2026-07-20.pdf` or `..._20_7_2026.pdf`."""
    m = re.search(r"(20\d{2})-(\d{2})-(\d{2})", path.name)
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    m = re.search(r"_(\d{1,2})_(\d{1,2})_(20\d{2})", path.name)
    if m:
        return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    # `06-Jun-2026` / `06_JUN_2026`
    m = re.search(r"(\d{1,2})[-_ ]([A-Za-z]{3})[-_ ](20\d{2})", path.name)
    if m:
        months = {"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
                  "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12}
        mo = months.get(m.group(2).lower())
        if mo:
            return dt.date(int(m.group(3)), mo, int(m.group(1)))
    # `06062026` — DDMMYYYY run together (June NSICT/NSIGT convention)
    m = re.search(r"(\d{2})(\d{2})(20\d{2})", path.name)
    if m:
        try:
            return dt.date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            return None
    return None


def resolve_day(day: int, hhmm: str, report: dt.date) -> dt.datetime | None:
    """`dd/HHMM` → a datetime, using the report's month/year.

    A day number greater than the report day by more than a week means the token
    belongs to the PREVIOUS month (gate open often precedes the report); a day
    far BELOW it near month-end means the next month. Both are clamped to ±1
    month so a misread never lands a year away.
    """
    try:
        hh, mm = int(hhmm[:2]), int(hhmm[2:])
        if hh > 23 or mm > 59:
            return None
        base = report.replace(day=1)
        for delta in (0, -1, 1):
            month = base.month + delta
            year = base.year + (month - 1) // 12
            month = (month - 1) % 12 + 1
            try:
                cand = dt.datetime(year, month, day, hh, mm, tzinfo=dt.timezone.utc)
            except ValueError:
                continue
            if abs((cand.date() - report).days) <= 10:
                return cand
        return None
    except Exception:
        return None


def parse_pdf(path: Path) -> list[dict]:
    """Return one record per vessel row carrying gate/cut-off or sailing times."""
    report = report_date_of(path)
    terminal = terminal_of(path)
    if not report or not terminal:
        return []
    try:
        with pdfplumber.open(path) as pdf:
            text = "\n".join((p.extract_text() or "") for p in pdf.pages)
    except Exception as exc:                                    # unreadable PDF
        print(f"  ! {path.name}: {exc}")
        return []

    out, section = [], None
    for line in text.splitlines():
        if _EXPECTED.search(line):
            section = "EXPECTED"
            continue
        if _SAILED.search(line):
            section = "SAILED"
            continue
        if _OTHER_SECTION.search(line):
            section = None
            continue
        if section is None:
            continue
        via_m = _VIA.search(line)
        if not via_m:
            continue
        via = via_m.group(1)
        gates = _GATE.findall(line)
        if not gates:
            continue
        # Column order in the EXPECTED panel is GATE OPEN, then CUT-OFF dry, then
        # CUT-OFF reefer. One token means gate open only; three means all three.
        # Anything else is an unexpected layout and is skipped rather than guessed.
        rec = {"report_date": report, "terminal": terminal, "via_no": via,
               "section": section, "source": path.name}
        if section == "EXPECTED":
            if len(gates) == 1:
                rec["gate_open_ts"] = resolve_day(int(gates[0][0]), gates[0][1], report)
            elif len(gates) >= 3:
                rec["gate_open_ts"] = resolve_day(int(gates[0][0]), gates[0][1], report)
                rec["cutoff_dry_ts"] = resolve_day(int(gates[1][0]), gates[1][1], report)
                rec["cutoff_reefer_ts"] = resolve_day(int(gates[2][0]), gates[2][1], report)
            else:
                continue
        if not any(rec.get(k) for k in ("gate_open_ts", "cutoff_dry_ts", "cutoff_reefer_ts")):
            continue
        out.append(rec)
    return out


async def main(dsn: str, pdf_dir: Path, apply: bool) -> int:
    pdfs = sorted(pdf_dir.rglob("*.pdf"))
    print(f"PDFs found: {len(pdfs)}  under {pdf_dir}")
    records: list[dict] = []
    for p in pdfs:
        records.extend(parse_pdf(p))

    by_term = defaultdict(int)
    for r in records:
        by_term[r["terminal"]] += 1
    print(f"\nparsed rows carrying gate/cut-off times: {len(records)}")
    for t, n in sorted(by_term.items()):
        print(f"   {t:6} {n}")
    cut = [r for r in records if r.get("cutoff_dry_ts")]
    print(f"   of which carry a CUT-OFF: {len(cut)}")
    if records[:3]:
        print("\nsample:")
        for r in records[:3]:
            print(f"   {r['report_date']} {r['terminal']:6} {r['via_no']:10} "
                  f"open={r.get('gate_open_ts')} dry={r.get('cutoff_dry_ts')} "
                  f"reefer={r.get('cutoff_reefer_ts')}")

    conn = await asyncpg.connect(dsn, ssl="require")
    try:
        matched = filled = 0
        for r in records:
            row = await conn.fetchrow(
                """SELECT v.id, v.gate_open_ts, v.cutoff_dry_ts, v.cutoff_reefer_ts
                   FROM core.berthing_report_vessel v
                   JOIN core.berthing_report rp ON rp.report_id = v.report_id
                   LEFT JOIN core.ref_terminal t ON t.terminal_id = rp.terminal_id
                   WHERE rp.report_date = $1 AND coalesce(t.code, '') = $2 AND v.via_no = $3""",
                r["report_date"], r["terminal"], r["via_no"])
            if not row:
                continue
            matched += 1
            # Only ever FILL a NULL — never overwrite a value already present.
            sets, args = [], []
            for col in ("gate_open_ts", "cutoff_dry_ts", "cutoff_reefer_ts"):
                if r.get(col) is not None and row[col] is None:
                    args.append(r[col])
                    sets.append(f"{col} = ${len(args) + 1}")
            if not sets:
                continue
            filled += 1
            if apply:
                await conn.execute(
                    f"UPDATE core.berthing_report_vessel SET {', '.join(sets)} WHERE id = $1",
                    row["id"], *args)
        print(f"\nmatched an existing vessel row : {matched} / {len(records)}")
        print(f"rows with a NULL to fill        : {filled}")
        print("\nAPPLIED." if apply else "\nDRY RUN — nothing written. Re-run with --yes to apply.")
    finally:
        await conn.close()
    return 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pdf-dir", required=True, help="directory of berthing PDFs (searched recursively)")
    ap.add_argument("--yes", action="store_true", help="apply the UPDATEs (default is a dry run)")
    a = ap.parse_args()
    target = os.environ.get("BERTHING_DSN")
    if not target:
        sys.exit("BERTHING_DSN is not set. This script reads a database and will not guess one.\n"
                 "  export BERTHING_DSN='postgresql://user:pass@host:5432/dbname'")
    sys.exit(asyncio.run(main(target.replace("?sslmode=require", ""), Path(a.pdf_dir), a.yes)))
