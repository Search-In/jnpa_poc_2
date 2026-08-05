"""
uc2_corpus -- the one place that reads the shared UC-II cargo-handling corpus.
==============================================================================

Jawaharlal Nehru Port Authority (JNPA) -- Workstream 2, UC-II Improved Cargo
Handling & Logistics Optimization. Tender ref GeM/2026/B/7297343.

WHY THIS FILE EXISTS
--------------------
Seven model modules need the same eight or nine raw sources, and every one of
those sources is a different shape: CODECO gate events in .xlsx, a FOIS train
intimation in .csv, CTO rake manifests as positional .txt, terminal EIR / Form
13 / pick-up tickets as .json, customs LEO and shipping bills in .xlsx, ICEGATE
IGM in .xml, RMS scanning lists as fixed-width text, and shipping-line EAL/IAL
inventories split across .csv/.xls/.xlsx with four incompatible headers.

Parsing those seven times, seven slightly different ways, is how a demo ends up
quoting seven different container counts for the same folder. Everything lands
here instead, normalised into small frozen dataclasses.

WHAT IS REAL AND WHAT IS NOT
----------------------------
This matters more than the parsing, and every loader reports it.

Each loader returns ``(records, Provenance)``. ``Provenance`` names the files
actually read, the row count, and -- when a file is missing or unreadable --
flips ``degraded=True`` with ``source="MOCK"``. Models must render that badge
rather than hide it (Bidder Briefing: degraded states stay visibly badged).

Measured on the corpus as shipped:

    CFS-CODECO.xlsx          968 events / 483 containers, every one In->Out
                             -> 483 REAL labelled dwell durations
    ECY-CODECO.xlsx          961 events / 961 containers, every one single-sided
                             -> 432 gate-in with no gate-out, 287 gate-out with
                                no gate-in. These are the anomalies the briefing
                                says are planted on purpose. Do not "fix" them.
    Train Intimation .csv     59 inbound rakes with ETA, wagon units, L/E flag
    CTO manifests              8 rakes, 42-57 container lines each
    TOS File 01               10 container entry/exit records with full features
    TOS File 02                5 vessel calls with ETA/ETD vs ATA/ATD
    LEO details              100 export let-export orders
    Shipping bills           100 SB headers
    Gate documents            12 parsed EIR / Form 13 / pick-up tickets
    EAL / IAL                ~4,700 container inventory lines across 9 files

THE ANOMALY WARNING
-------------------
``load_container_events()`` deliberately does NOT drop unpaired events, and
``pair_dwell_records()`` deliberately does NOT invent a departure for a
container that never left. A loader that silently repairs the data would delete
the exact signal UC2-M4 is scored on.

USAGE
-----
    python uc2_corpus.py                 # inventory every source, exit 0
    python uc2_corpus.py --json          # same, machine readable
    python uc2_corpus.py --source dwell  # dump one source
"""

from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

import jnpa_paths

jnpa_paths.ensure_on_syspath()

MODULE_ID: str = "UC2-CORPUS"
MODULE_VERSION: str = "uc2-corpus-v1.0.0"
SCHEMA_VERSION: str = "uc2-corpus/1.0.0"

# ==========================================================================
# SECTION 1 -- PROVENANCE
# ==========================================================================


@dataclass(frozen=True)
class Provenance:
    """
    Where a record set came from, and whether it is trustworthy.

    ``source`` is one of:
        CORPUS    parsed from the shared JNPA corpus (real)
        PARTIAL   some named files parsed, others missing
        MOCK      nothing readable; the caller is looking at a generator
    """

    source: str
    files: Tuple[str, ...] = ()
    missing: Tuple[str, ...] = ()
    record_count: int = 0
    note: str = ""

    @property
    def degraded(self) -> bool:
        return self.source != "CORPUS"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "degraded": self.degraded,
            "synthetic": self.source == "MOCK",
            "files": [jnpa_paths.relative(f) for f in self.files],
            "missing": [jnpa_paths.relative(f) for f in self.missing],
            "record_count": self.record_count,
            "note": self.note,
        }


def _provenance(read: Sequence[str], missing: Sequence[str], count: int,
                note: str = "") -> Provenance:
    if read and not missing:
        src = "CORPUS"
    elif read:
        src = "PARTIAL"
    else:
        src = "MOCK"
    return Provenance(src, tuple(read), tuple(missing), count, note)


# ==========================================================================
# SECTION 2 -- SHARED PARSING PRIMITIVES
# ==========================================================================

# Every timestamp dialect seen in the UC-II corpus, most specific first.
_TS_FORMATS: Tuple[str, ...] = (
    "%d/%m/%Y %H:%M:%S",     # CODECO xlsx
    "%d/%m/%Y %H:%M",        # CODECO xlsx, EIR json
    "%Y-%m-%d %H:%M:%S",     # TOS File 01
    "%Y-%m-%d %H:%M",        # Cargo_Training_Input_Sample.xlsx -- the shape its
                             # README declares every timestamp is normalised to
    "%Y-%m-%dT%H:%M:%S",     # ISO from an API caller
    "%Y-%m-%dT%H:%M",
    "%d%m%Y %H:%M:%S",       # TOS File 02 vessel schedule
    "%d%m%Y:%H:%M",          # EDI CODECO / IGM  12062026:02:53
    "%d%m%Y:%H:%M:%S",
    "%d-%b-%Y %H:%M:%S",     # Form 13  10-Jun-2026 12:29:58
    "%d-%b-%Y %H:%M",
    "%d-%b-%y %H:%M",        # CTO manifest  18-Jun-26 04:00
    "%d-%m-%Y %H:%M",        # pick-up ticket 12-06-2026 07:13
    "%d-%m-%y %H:%M",
    "%d.%m.%Y %H:%M",        # CTO manifest  22.06.2026 12:00
    "%d/%m/%Y",
    "%Y-%m-%d",
    "%d-%m-%Y",
    "%d-%b-%Y",
    "%d-%b-%y",
    "%d.%m.%Y",
    "%d%m%Y",
)

# FOIS packs date and time into one field with a colon:  11052026:01:45
_FOIS_TS = re.compile(r"^(\d{8}):(\d{2}):(\d{2})$")

# ISO 6346 owner code + serial + check digit.
_CONTAINER_RE = re.compile(r"\b([A-Z]{3}[UJZ]\d{7})\b")


def parse_ts(value: Any) -> Optional[datetime]:
    """
    Parse any timestamp dialect in the corpus, or return ``None``.

    Returning ``None`` rather than raising is deliberate: a single malformed
    row in a 968-row gate log must not take down the model that reads it. The
    callers count the ``None``s and report them as a data-quality figure.
    """
    if value is None:
        return None
    if isinstance(value, datetime):
        return value
    text = str(value).strip()
    if not text or text.lower() in ("none", "nan", "null", "-", ""):
        return None

    m = _FOIS_TS.match(text)
    if m:
        try:
            return datetime.strptime(m.group(1), "%d%m%Y").replace(
                hour=int(m.group(2)), minute=int(m.group(3))
            )
        except ValueError:
            return None

    for fmt in _TS_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue

    # Last resort: full ISO-8601 with a UTC designator or a numeric offset --
    # "2026-07-01T08:00:00Z", "2026-07-01T08:00:00+05:30". strptime cannot
    # match those with a fixed format string, and a web app POSTing JSON emits
    # them by default.
    #
    # This mattered: without it UC2-M4 dropped every event whose timestamp
    # carried a Z, and normalise_trail() drops unparseable rows silently -- so
    # an anomaly detector handed a perfectly good trail returned "clean, 0
    # events". A false negative is the one direction this module must not fail
    # in, so the fallback is here rather than in any single caller.
    #
    # The result is normalised to naive UTC because every format above yields a
    # naive datetime, and mixing the two raises on comparison.
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def parse_num(value: Any) -> Optional[float]:
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().replace(",", "")
    if not text or text.lower() in ("none", "nan", "null", "-"):
        return None
    m = re.search(r"-?\d+(?:\.\d+)?", text)
    return float(m.group(0)) if m else None


def container_numbers(text: str) -> List[str]:
    """Every ISO 6346 container number in a blob of text, in order, de-duped."""
    seen: List[str] = []
    for c in _CONTAINER_RE.findall(text.upper()):
        if c not in seen:
            seen.append(c)
    return seen


def iso_is_reefer(iso_code: Any) -> bool:
    """
    Reefer flag from an ISO 6346 size-type code.

    Two dialects live side by side in the corpus. The alphanumeric form spells
    it (``45R1``, ``22R1``); the older all-numeric form encodes thermal
    containers as group 3 in the third character (``4532``, ``2231``). Missing
    the numeric form would under-count reefers by roughly half, and reefer plug
    demand is the whole point of UC2-M7.
    """
    code = str(iso_code or "").strip().upper()
    if len(code) < 3:
        return False
    if "R" in code[2:]:
        return True
    return code[2].isdigit() and code[2] == "3"


def iso_size_ft(iso_code: Any) -> int:
    """Nominal container length in feet from the ISO code; 0 when unknown."""
    code = str(iso_code or "").strip().upper()
    if not code:
        return 0
    head = code[0]
    if head in ("2",):
        return 20
    if head in ("4",):
        return 40
    if head in ("L", "M", "9"):
        return 45
    if head in ("1",):
        return 10
    if head in ("3",):
        return 30
    return 0


def iso_teu(iso_code: Any) -> float:
    ft = iso_size_ft(iso_code)
    if ft >= 40:
        return 2.0
    if ft == 0:
        return 1.0
    return 1.0


def read_grid(path: str, sheet: Optional[str] = None) -> List[List[Any]]:
    """
    Read a table file into a grid, tolerating the corpus's encoding zoo.

    ``jnpa_input.read_table`` handles .xlsx/.csv/.json cleanly but assumes
    UTF-8 for CSV. Two shipping-line exports (IAL BMCT, EAL NSICT) are
    cp1252, so a bare UTF-8 read raises UnicodeDecodeError and the model
    silently loses a terminal's inventory. Retry with latin-1 rather than skip.
    """
    import jnpa_input as jio

    ext = os.path.splitext(path)[1].lower()
    if ext == ".csv":
        for enc in ("utf-8-sig", "cp1252", "latin-1"):
            try:
                with open(path, "r", encoding=enc, newline="") as fh:
                    return [list(r) for r in csv.reader(fh)]
            except UnicodeDecodeError:
                continue
        return []
    try:
        _fmt, _sheet, grid = jio.read_table(path, sheet)
        return grid
    except Exception:
        return []


def rows_as_dicts(grid: Sequence[Sequence[Any]]) -> List[Dict[str, Any]]:
    """Grid -> list of dicts keyed by the header row, blank keys dropped."""
    if not grid:
        return []
    header = [str(h).strip() if h is not None else "" for h in grid[0]]
    out: List[Dict[str, Any]] = []
    for raw in grid[1:]:
        if not any(c not in (None, "") for c in raw):
            continue
        rec: Dict[str, Any] = {}
        for key, cell in zip(header, raw):
            if key:
                rec[key] = cell
        out.append(rec)
    return out


def _existing(*paths: str) -> Tuple[List[str], List[str]]:
    read, missing = [], []
    for p in paths:
        (read if os.path.exists(p) else missing).append(p)
    return read, missing


# ==========================================================================
# SECTION 3 -- CONTAINER GATE EVENTS  (CODECO)
# ==========================================================================

CFS_CODECO: str = os.path.join(
    jnpa_paths.UC2_M1_DIR, "CFS_ECY_Container_Events_and_LDB_Benchmark", "CFS-CODECO.xlsx")
ECY_CODECO: str = os.path.join(
    jnpa_paths.UC2_M1_DIR, "CFS_ECY_Container_Events_and_LDB_Benchmark", "ECY-CODECO.xlsx")
EDI_CODECO: str = os.path.join(jnpa_paths.UC2_M1_DIR, "EDI_CODECO", "CODECO.xlsx")
EDI_FORMATS: str = os.path.join(
    jnpa_paths.UC2_M4_DIR, "EDI_CODECO_COARRI_COPRAR", "EDI Message Format.xlsx")


@dataclass(frozen=True)
class ContainerEvent:
    """One gate movement of one container, as recorded in a CODECO stream."""

    container: str
    ts: datetime
    mode: str          # "IN" | "OUT"
    facility: str      # "CFS" | "ECY"
    source_file: str

    @property
    def event_type(self) -> str:
        return "GATE_IN" if self.mode == "IN" else "GATE_OUT"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "container": self.container,
            "ts": self.ts.isoformat(),
            "eventType": self.event_type,
            "facility": self.facility,
        }


def load_container_events() -> Tuple[List[ContainerEvent], Provenance]:
    """
    The CFS and ECY CODECO gate streams, merged and sorted by timestamp.

    Unpaired events are kept. See the module docstring: the single-sided ECY
    rows are the planted anomalies, not parse failures.
    """
    read, missing = _existing(CFS_CODECO, ECY_CODECO)
    events: List[ContainerEvent] = []
    unparsed = 0

    for path in read:
        facility = "CFS" if "CFS" in os.path.basename(path).upper() else "ECY"
        for rec in rows_as_dicts(read_grid(path)):
            container = str(rec.get("Container Number") or "").strip().upper()
            ts = parse_ts(rec.get("Timestamp"))
            mode_raw = str(rec.get("Mode") or "").strip().upper()
            if not container or ts is None or mode_raw not in ("IN", "OUT"):
                unparsed += 1
                continue
            events.append(ContainerEvent(container, ts, mode_raw, facility,
                                         os.path.basename(path)))

    events.sort(key=lambda e: (e.ts, e.container))
    note = f"{unparsed} row(s) unparseable" if unparsed else "all rows parsed"
    return events, _provenance(read, missing, len(events), note)


@dataclass(frozen=True)
class DwellRecord:
    """
    A container's stay: first gate-in to last gate-out, with observed hours.

    ``dwell_hours`` is ``None`` when the container never left, which is a valid
    and important state -- it is the open pendency the yard is carrying now.
    """

    container: str
    facility: str
    gate_in: Optional[datetime]
    gate_out: Optional[datetime]
    dwell_hours: Optional[float]
    event_count: int
    complete: bool

    def as_dict(self) -> Dict[str, Any]:
        return {
            "container": self.container,
            "facility": self.facility,
            "gateIn": self.gate_in.isoformat() if self.gate_in else None,
            "gateOut": self.gate_out.isoformat() if self.gate_out else None,
            "dwellHours": round(self.dwell_hours, 3) if self.dwell_hours is not None else None,
            "eventCount": self.event_count,
            "complete": self.complete,
        }


def pair_dwell_records(
    events: Optional[Sequence[ContainerEvent]] = None,
) -> Tuple[List[DwellRecord], Provenance]:
    """
    Turn the gate stream into per-container stays.

    Pairing rule: first IN to the first OUT that follows it. A trailing OUT with
    no preceding IN yields ``gate_in=None`` (an orphan) rather than being
    discarded, because UC2-M4 scores on exactly those.
    """
    prov: Optional[Provenance] = None
    if events is None:
        events, prov = load_container_events()

    by_container: Dict[str, List[ContainerEvent]] = {}
    for ev in events:
        by_container.setdefault(ev.container, []).append(ev)

    records: List[DwellRecord] = []
    for container, evs in by_container.items():
        evs = sorted(evs, key=lambda e: e.ts)
        gate_in = next((e for e in evs if e.mode == "IN"), None)
        gate_out = None
        if gate_in is not None:
            gate_out = next((e for e in evs if e.mode == "OUT" and e.ts > gate_in.ts), None)
        else:
            gate_out = next((e for e in evs if e.mode == "OUT"), None)

        hours = None
        if gate_in is not None and gate_out is not None:
            hours = (gate_out.ts - gate_in.ts).total_seconds() / 3600.0

        facility = (gate_in or gate_out or evs[0]).facility
        records.append(DwellRecord(
            container=container,
            facility=facility,
            gate_in=gate_in.ts if gate_in else None,
            gate_out=gate_out.ts if gate_out else None,
            dwell_hours=hours,
            event_count=len(evs),
            complete=hours is not None,
        ))

    records.sort(key=lambda r: (r.gate_in or r.gate_out or datetime.min, r.container))
    if prov is None:
        prov = _provenance([CFS_CODECO, ECY_CODECO], [], len(records))
    else:
        complete = sum(1 for r in records if r.complete)
        prov = Provenance(
            prov.source, prov.files, prov.missing, len(records),
            f"{complete} complete IN->OUT pairs, {len(records) - complete} open/orphan",
        )
    return records, prov


def load_edi_codeco_messages() -> Tuple[List[Dict[str, Any]], Provenance]:
    """
    The EDI CODECO XML payloads (gate pass, vehicle, gate number, delivery mode).

    Only a handful of messages ship in the corpus -- these are format samples,
    not a volume feed. The gate-queue model therefore uses them to prove the
    field mapping and takes its volume from the CFS/ECY streams.
    """
    read, missing = _existing(EDI_CODECO, EDI_FORMATS)
    tags = ("ContainerNO", "GatePassNo", "GatePassDateTime", "GateNumber", "VehicleNo",
            "DeliveryMode", "EquipmentStatusCode", "ContISOCode", "CACode",
            "StuffDestuffFlag", "ArrivalDateTime", "LoadingPort", "FinalPortOfDischarge")
    out: List[Dict[str, Any]] = []

    for path in read:
        for rec in rows_as_dicts(read_grid(path, "CODECO")):
            payload = str(rec.get("PAYLOAD") or "")
            if "<CODECODetails>" not in payload:
                continue
            parsed = {t: m.group(1) for t in tags
                      for m in [re.search(rf"<{t}>(.*?)</{t}>", payload)] if m}
            if not parsed:
                continue
            parsed["_gate_ts"] = parse_ts(parsed.get("GatePassDateTime"))
            parsed["_source_file"] = os.path.basename(path)
            out.append(parsed)

    # The two workbooks overlap; de-duplicate on gate pass number.
    seen, deduped = set(), []
    for rec in out:
        key = (rec.get("GatePassNo"), rec.get("ContainerNO"))
        if key in seen:
            continue
        seen.add(key)
        deduped.append(rec)

    return deduped, _provenance(read, missing, len(deduped),
                                "EDI format samples, not a volume feed")


# ==========================================================================
# SECTION 4 -- RAIL  (FOIS train intimation, CTO rake manifests)
# ==========================================================================

TRAIN_INTIMATION: str = os.path.join(
    jnpa_paths.UC2_M2_DIR, "NLDS_FOIS_TrainIntimation_TOS",
    "JNPA Train Intimation 09052026_083002.csv")
CTO_DIR: str = os.path.join(jnpa_paths.UC2_M2_DIR, "ICD_Rail_Form11_CTO", "CTO")
FORM11_DIR: str = os.path.join(jnpa_paths.UC2_M2_DIR, "ICD_Rail_Form11_CTO", "Form 11")


@dataclass(frozen=True)
class RakeIntimation:
    """One inbound rake as advised by FOIS / NLDS."""

    rake_id: str
    rake_name: str
    eta: Optional[datetime]
    etd_origin: Optional[datetime]
    wagon_units: int
    loaded: bool
    station_from: str
    station_to: str
    zone_from: str
    last_status_ts: Optional[datetime]
    last_reporting_station: str

    @property
    def transit_hours(self) -> Optional[float]:
        if self.eta and self.etd_origin:
            return (self.eta - self.etd_origin).total_seconds() / 3600.0
        return None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "rakeId": self.rake_id,
            "rakeName": self.rake_name,
            "eta": self.eta.isoformat() if self.eta else None,
            "wagonUnits": self.wagon_units,
            "loaded": self.loaded,
            "stationFrom": self.station_from,
            "stationTo": self.station_to,
            "transitHours": round(self.transit_hours, 2) if self.transit_hours else None,
        }


def load_train_intimations() -> Tuple[List[RakeIntimation], Provenance]:
    """The 59-row FOIS train intimation: what is inbound to JNPT and when."""
    read, missing = _existing(TRAIN_INTIMATION)
    out: List[RakeIntimation] = []
    for rec in rows_as_dicts(read_grid(TRAIN_INTIMATION)) if read else []:
        units = parse_num(rec.get("Units")) or 0
        out.append(RakeIntimation(
            rake_id=str(rec.get("RakeId") or "").strip(),
            rake_name=str(rec.get("RakeName") or "").strip(),
            eta=parse_ts(rec.get("Eda")),
            etd_origin=parse_ts(rec.get("Edd")),
            wagon_units=int(units),
            loaded=str(rec.get("Loaded Empty Flag (L/E)") or "L").strip().upper() == "L",
            station_from=str(rec.get("Station From") or "").strip(),
            station_to=str(rec.get("Station To") or "").strip(),
            zone_from=str(rec.get("ZoneFrom") or "").strip(),
            last_status_ts=parse_ts(rec.get("Last Status Time")),
            last_reporting_station=str(rec.get("Last Reporting Station") or "").strip(),
        ))
    out.sort(key=lambda r: (r.eta or datetime.max, r.rake_id))
    return out, _provenance(read, missing, len(out))


@dataclass(frozen=True)
class RakeManifest:
    """
    A CTO rake manifest: which containers came in on which wagons, for whom.

    The eight files use three different positional layouts (the CTO writes what
    its own TOS exports), so the parser is field-shape driven rather than
    index driven -- see ``_parse_cto_line``.
    """

    rake_ref: str
    cto_code: str
    handling_ts: Optional[datetime]
    wagon_count: int
    container_count: int
    loaded_count: int
    empty_count: int
    teu: float
    terminals: Tuple[str, ...]
    source_file: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "rakeRef": self.rake_ref,
            "ctoCode": self.cto_code,
            "handlingTs": self.handling_ts.isoformat() if self.handling_ts else None,
            "wagonCount": self.wagon_count,
            "containerCount": self.container_count,
            "loadedCount": self.loaded_count,
            "emptyCount": self.empty_count,
            "teu": round(self.teu, 1),
            "terminals": list(self.terminals),
        }


_KNOWN_TERMINALS = ("BMCT", "NSICT", "NSIGT", "NSFT", "GTIL", "GTI", "APMT", "JNPT",
                    "DPW", "PSA", "NSAF")
_TIME_RE = re.compile(r"^\d{1,2}[:.]\d{2}$")
_DATE_TOKEN_RE = re.compile(r"^\d{1,2}[-./]\w{2,3}[-./]\d{2,4}$|^\d{1,2}[-./]\d{1,2}[-./]\d{2,4}$")


def _parse_cto_line(fields: Sequence[str]) -> Dict[str, Any]:
    """
    Pull the fields we need out of one CTO line whatever its column order.

    Rather than hard-code three layouts that will change on the next export,
    each token is classified by shape: an ISO 6346 pattern is the container, a
    date-looking token is the date, ``HH:MM`` is the time, a bare 20/40 is the
    size, a lone L/E is the load flag, and an 11-digit number is the wagon.
    """
    out: Dict[str, Any] = {"container": "", "wagon": "", "date": "", "time": "",
                           "size": 0, "loaded": None, "terminal": "", "iso": ""}
    for tok in fields:
        t = tok.strip()
        if not t:
            continue
        up = t.upper()
        if not out["container"] and _CONTAINER_RE.fullmatch(up):
            out["container"] = up
        elif not out["date"] and _DATE_TOKEN_RE.match(t):
            out["date"] = t
        elif not out["time"] and _TIME_RE.match(t):
            out["time"] = t.replace(".", ":")
        elif not out["wagon"] and t.isdigit() and len(t) >= 10:
            out["wagon"] = t
        elif not out["size"] and t in ("20", "40", "45"):
            out["size"] = int(t)
        elif out["loaded"] is None and up in ("L", "E"):
            out["loaded"] = up == "L"
        elif not out["terminal"] and up in _KNOWN_TERMINALS:
            out["terminal"] = up
    return out


def load_rake_manifests() -> Tuple[List[RakeManifest], Provenance]:
    """The eight CTO rake manifests, one aggregated record per rake."""
    # Two globs because the corpus mixes .txt and .TXT, then de-duplicated
    # because Windows matches both patterns case-insensitively and would
    # otherwise report sixteen rakes where eight exist.
    found = glob.glob(os.path.join(CTO_DIR, "*.txt")) + glob.glob(os.path.join(CTO_DIR, "*.TXT"))
    files = sorted({os.path.normcase(os.path.abspath(f)): f for f in found}.values())
    read = files
    missing: List[str] = [] if files else [CTO_DIR]

    out: List[RakeManifest] = []
    for path in files:
        base = os.path.basename(path)
        stem = os.path.splitext(base)[0].strip()
        parts = stem.split()
        rake_ref = parts[0] if parts else stem
        cto_code = parts[-1] if len(parts) > 1 else ""

        wagons, containers, loaded, empty, teu = set(), set(), 0, 0, 0.0
        terminals: Dict[str, int] = {}
        stamp_date, stamp_time = "", ""
        try:
            text = open(path, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        for line in text.splitlines():
            if not line.strip():
                continue
            parsed = _parse_cto_line(line.split(","))
            if parsed["wagon"]:
                wagons.add(parsed["wagon"])
            if parsed["container"]:
                containers.add(parsed["container"])
                teu += 2.0 if parsed["size"] == 40 else 1.0
                if parsed["loaded"] is False:
                    empty += 1
                else:
                    loaded += 1
            if parsed["terminal"]:
                terminals[parsed["terminal"]] = terminals.get(parsed["terminal"], 0) + 1
            if not stamp_date and parsed["date"]:
                stamp_date = parsed["date"]
            if not stamp_time and parsed["time"]:
                stamp_time = parsed["time"]

        handling_ts = parse_ts(f"{stamp_date} {stamp_time}".strip()) if stamp_date else None
        out.append(RakeManifest(
            rake_ref=rake_ref,
            cto_code=cto_code,
            handling_ts=handling_ts,
            wagon_count=len(wagons),
            container_count=len(containers),
            loaded_count=loaded,
            empty_count=empty,
            teu=teu,
            terminals=tuple(sorted(terminals, key=lambda k: -terminals[k])),
            source_file=base,
        ))

    out.sort(key=lambda r: r.rake_ref)
    return out, _provenance(read, missing, len(out))


# ==========================================================================
# SECTION 5 -- TERMINAL OPERATING SYSTEM EXTRACTS
# ==========================================================================

TOS_CONTAINER_FILES: Tuple[str, ...] = (
    os.path.join(jnpa_paths.UC2_M2_DIR, "NLDS_FOIS_TrainIntimation_TOS", "TOS File 01.xlsx"),
    os.path.join(jnpa_paths.UC2_M5_DIR, "TOS_Performance", "TOS File 01.xlsx"),
)
TOS_VESSEL_FILES: Tuple[str, ...] = (
    os.path.join(jnpa_paths.UC2_M2_DIR, "NLDS_FOIS_TrainIntimation_TOS", "TOS File 02.xlsx"),
    os.path.join(jnpa_paths.UC2_M5_DIR, "TOS_Performance", "TOS File 02.xlsx"),
)

_MODE_LABEL = {"T": "TRUCK", "V": "VESSEL", "R": "RAIL", "G": "GATE"}


@dataclass(frozen=True)
class TOSContainer:
    """A container's terminal stay with the features the TOS actually records."""

    container: str
    terminal: str
    category: str          # "I" import | "E" export | "T" transshipment
    entry_ts: Optional[datetime]
    exit_ts: Optional[datetime]
    entry_mode: str
    exit_mode: str
    size_ft: int
    reefer: bool
    empty: bool
    dpd: bool
    shipping_line: str
    iso_code: str
    next_dest: str

    @property
    def dwell_hours(self) -> Optional[float]:
        if self.entry_ts and self.exit_ts:
            return (self.exit_ts - self.entry_ts).total_seconds() / 3600.0
        return None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "container": self.container,
            "terminal": self.terminal,
            "category": self.category,
            "entryTs": self.entry_ts.isoformat() if self.entry_ts else None,
            "exitTs": self.exit_ts.isoformat() if self.exit_ts else None,
            "entryMode": _MODE_LABEL.get(self.entry_mode, self.entry_mode),
            "exitMode": _MODE_LABEL.get(self.exit_mode, self.exit_mode),
            "sizeFt": self.size_ft,
            "reefer": self.reefer,
            "empty": self.empty,
            "dpd": self.dpd,
            "shippingLine": self.shipping_line,
            "dwellHours": round(self.dwell_hours, 3) if self.dwell_hours else None,
        }


def load_tos_containers() -> Tuple[List[TOSContainer], Provenance]:
    """
    TOS File 01 -- the only corpus source that carries dwell AND its features.

    Ten rows. That is far too few to train on and is used as a feature-schema
    reference and an honest external check on the dwell model, never as a
    training set. Both copies of the file are read and de-duplicated because
    the corpus ships it under two model folders.
    """
    read, missing = _existing(*TOS_CONTAINER_FILES)
    out: List[TOSContainer] = []
    for path in read:
        for rec in rows_as_dicts(read_grid(path)):
            container = str(rec.get("cntr_no") or "").strip().upper()
            if not container:
                continue
            iso = str(rec.get("iso_code") or "").strip()
            size = parse_num(rec.get("cntr_size")) or iso_size_ft(iso)
            out.append(TOSContainer(
                container=container,
                terminal=str(rec.get("org_name") or "").strip(),
                category=str(rec.get("category") or "").strip().upper(),
                entry_ts=parse_ts(rec.get("entry_time")),
                exit_ts=parse_ts(rec.get("exit_time")),
                entry_mode=str(rec.get("entry_mode") or "").strip().upper(),
                exit_mode=str(rec.get("exit_mode") or "").strip().upper(),
                size_ft=int(size),
                reefer=str(rec.get("is_refrigerated") or "N").strip().upper() == "Y"
                or iso_is_reefer(iso),
                empty=str(rec.get("is_empty") or "N").strip().upper() == "Y",
                dpd=str(rec.get("dpd_dpe") or "N").strip().upper() == "Y",
                shipping_line=str(rec.get("shipping_line") or "").strip(),
                iso_code=iso,
                next_dest=str(rec.get("next_dest") or "").strip(),
            ))
    seen, deduped = set(), []
    for rec in out:
        if rec.container in seen:
            continue
        seen.add(rec.container)
        deduped.append(rec)
    deduped.sort(key=lambda r: (r.entry_ts or datetime.max, r.container))
    return deduped, _provenance(read, missing, len(deduped),
                                "schema reference + external check only; too few rows to train")


@dataclass(frozen=True)
class TOSVesselCall:
    """A vessel call with both the plan (ETA/ETD) and the outcome (ATA/ATD)."""

    terminal: str
    via_no: str
    vessel_name: str
    eta: Optional[datetime]
    etd: Optional[datetime]
    ata: Optional[datetime]
    atd: Optional[datetime]
    vessel_type: str

    @property
    def planned_stay_hours(self) -> Optional[float]:
        if self.eta and self.etd:
            return (self.etd - self.eta).total_seconds() / 3600.0
        return None

    @property
    def actual_stay_hours(self) -> Optional[float]:
        if self.ata and self.atd:
            return (self.atd - self.ata).total_seconds() / 3600.0
        return None

    @property
    def arrival_delay_hours(self) -> Optional[float]:
        if self.eta and self.ata:
            return (self.ata - self.eta).total_seconds() / 3600.0
        return None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "terminal": self.terminal,
            "viaNo": self.via_no,
            "vesselName": self.vessel_name,
            "eta": self.eta.isoformat() if self.eta else None,
            "ata": self.ata.isoformat() if self.ata else None,
            "etd": self.etd.isoformat() if self.etd else None,
            "atd": self.atd.isoformat() if self.atd else None,
            "plannedStayHours": round(self.planned_stay_hours, 2) if self.planned_stay_hours else None,
            "actualStayHours": round(self.actual_stay_hours, 2) if self.actual_stay_hours else None,
            "arrivalDelayHours": round(self.arrival_delay_hours, 2)
            if self.arrival_delay_hours is not None else None,
        }


def load_tos_vessel_calls() -> Tuple[List[TOSVesselCall], Provenance]:
    """TOS File 02 -- planned vs actual berth windows, the M5 ground truth."""
    read, missing = _existing(*TOS_VESSEL_FILES)
    out: List[TOSVesselCall] = []
    for path in read:
        for rec in rows_as_dicts(read_grid(path)):
            via = str(rec.get("via_no") or "").strip()
            if not via:
                continue
            out.append(TOSVesselCall(
                terminal=str(rec.get("terminal_name") or "").strip(),
                via_no=via,
                vessel_name=str(rec.get("vessel_name") or "").strip(),
                eta=parse_ts(rec.get("eta")),
                etd=parse_ts(rec.get("etd")),
                ata=parse_ts(rec.get("ata")),
                atd=parse_ts(rec.get("atd")),
                vessel_type=str(rec.get("vessel_type") or "").strip(),
            ))
    seen, deduped = set(), []
    for rec in out:
        key = (rec.terminal, rec.via_no)
        if key in seen:
            continue
        seen.add(key)
        deduped.append(rec)
    deduped.sort(key=lambda r: (r.ata or datetime.max, r.via_no))
    return deduped, _provenance(read, missing, len(deduped))


# ==========================================================================
# SECTION 6 -- CUSTOMS CHAIN  (LEO, shipping bills, IGM, RMS scanning lists)
# ==========================================================================

LEO_XLSX: str = os.path.join(
    jnpa_paths.UC2_M4_DIR, "Customs_Chain_IGM_OOC_SMTP_RMS_SB_LEO", "LEO", "leodetails.xlsx")
SB_XLSX: str = os.path.join(
    jnpa_paths.UC2_M4_DIR, "Customs_Chain_IGM_OOC_SMTP_RMS_SB_LEO", "Shipping Bill",
    "shippingbill.xlsx")
RMS_DIR: str = os.path.join(
    jnpa_paths.UC2_M4_DIR, "Customs_Chain_IGM_OOC_SMTP_RMS_SB_LEO", "RMS")
IGM_DIR: str = os.path.join(jnpa_paths.UC2_M4_DIR, "ICEGATE_IGM_XML")


@dataclass(frozen=True)
class LEORecord:
    """A Let Export Order: customs has cleared this shipping bill to leave."""

    sb_number: str
    sb_date: Optional[datetime]
    leo_date: Optional[datetime]
    site_id: str
    rotation_number: str

    @property
    def clearance_lag_days(self) -> Optional[float]:
        if self.sb_date and self.leo_date:
            return (self.leo_date - self.sb_date).total_seconds() / 86400.0
        return None

    def as_dict(self) -> Dict[str, Any]:
        return {
            "sbNumber": self.sb_number,
            "sbDate": self.sb_date.isoformat() if self.sb_date else None,
            "leoDate": self.leo_date.isoformat() if self.leo_date else None,
            "siteId": self.site_id,
            "clearanceLagDays": round(self.clearance_lag_days, 2)
            if self.clearance_lag_days is not None else None,
        }


def load_leo_records() -> Tuple[List[LEORecord], Provenance]:
    """The 100 export let-export orders -- the LEO clock UC2-M4 rules run on."""
    read, missing = _existing(LEO_XLSX)
    out: List[LEORecord] = []
    for rec in rows_as_dicts(read_grid(LEO_XLSX)) if read else []:
        sb = str(rec.get("SB Number") or "").strip()
        if not sb:
            continue
        out.append(LEORecord(
            sb_number=sb,
            sb_date=parse_ts(rec.get("SB Date")),
            leo_date=parse_ts(rec.get("LEO Date")),
            site_id=str(rec.get("Site ID") or "").strip(),
            rotation_number=str(rec.get("Rotation Number") or "").strip(),
        ))
    out.sort(key=lambda r: (r.leo_date or datetime.max, r.sb_number))
    return out, _provenance(read, missing, len(out))


def load_shipping_bills() -> Tuple[List[Dict[str, Any]], Provenance]:
    """Shipping-bill headers; joined to LEO on SB number to find un-cleared SBs."""
    read, missing = _existing(SB_XLSX)
    out: List[Dict[str, Any]] = []
    for rec in rows_as_dicts(read_grid(SB_XLSX)) if read else []:
        sb = str(rec.get("SB Number") or "").strip()
        if not sb:
            continue
        out.append({
            "sbNumber": sb,
            "sbDate": parse_ts(rec.get("SB Date")),
            "siteId": str(rec.get("Site ID") or "").strip(),
        })
    return out, _provenance(read, missing, len(out))


@dataclass(frozen=True)
class ScanningListEntry:
    """A container customs has put on the RMS scanning list."""

    container: str
    igm_no: str
    igm_date: Optional[datetime]
    processing_end: Optional[datetime]
    vessel_name: str
    cfs_name: str
    source_file: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "container": self.container,
            "igmNo": self.igm_no,
            "processingEnd": self.processing_end.isoformat() if self.processing_end else None,
            "vesselName": self.vessel_name,
            "cfsName": self.cfs_name,
        }


def load_scanning_lists() -> Tuple[List[ScanningListEntry], Provenance]:
    """
    RMS scanning lists -> the customs-flagged container set.

    These are the containers that must show a SCAN_START event. A flagged box
    with no scan after 24 h is a UC2-M4 WARN, so this is the flag source rather
    than a synthetic ``customs_flag`` column.
    """
    files = sorted(glob.glob(os.path.join(RMS_DIR, "*.txt")))
    read = files
    missing: List[str] = [] if files else [RMS_DIR]
    out: List[ScanningListEntry] = []

    for path in files:
        try:
            text = open(path, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        igm_no = _first_group(text, r"IGM\s*No\.\s*:\s*(\S+)")
        igm_dt = parse_ts(_first_group(text, r"IGM\s*Date\s*:\s*([\d/: ]+)").strip())
        proc_end = parse_ts(_first_group(text, r"Processing End Date\s*:\s*(\S+)"))
        vessel = _first_group(text, r"Vessel Name\s*:\s*(.+)").strip()
        for line in text.splitlines():
            found = container_numbers(line)
            if not found:
                continue
            cfs = ""
            m = re.search(r"\)\s{2,}(.+?)\s{2,}", line)
            if m:
                cfs = m.group(1).strip()
            for container in found:
                out.append(ScanningListEntry(
                    container=container,
                    igm_no=igm_no.split("/")[0],
                    igm_date=igm_dt,
                    processing_end=proc_end,
                    vessel_name=vessel,
                    cfs_name=cfs,
                    source_file=os.path.basename(path),
                ))

    seen, deduped = set(), []
    for rec in out:
        if rec.container in seen:
            continue
        seen.add(rec.container)
        deduped.append(rec)
    return deduped, _provenance(read, missing, len(deduped))


def _first_group(text: str, pattern: str) -> str:
    m = re.search(pattern, text)
    return m.group(1) if m else ""


@dataclass(frozen=True)
class IGMRecord:
    """An ICEGATE import general manifest header."""

    igm_no: str
    igm_date: Optional[datetime]
    vessel_code: str
    voyage_no: str
    eta: Optional[datetime]
    entry_inward: Optional[datetime]
    terminal_operator: str
    line_count: int
    source_file: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "igmNo": self.igm_no,
            "igmDate": self.igm_date.isoformat() if self.igm_date else None,
            "voyageNo": self.voyage_no,
            "eta": self.eta.isoformat() if self.eta else None,
            "entryInward": self.entry_inward.isoformat() if self.entry_inward else None,
            "terminalOperator": self.terminal_operator,
            "lineCount": self.line_count,
        }


def load_igm_records() -> Tuple[List[IGMRecord], Provenance]:
    """ICEGATE CHPOI03 IGM headers -- the manifest arm of the customs chain."""
    files = sorted(glob.glob(os.path.join(IGM_DIR, "*.xml")))
    read = files
    missing: List[str] = [] if files else [IGM_DIR]
    out: List[IGMRecord] = []
    for path in files:
        try:
            text = open(path, "r", encoding="utf-8", errors="replace").read()
        except OSError:
            continue
        out.append(IGMRecord(
            igm_no=_first_group(text, r"<IGM_NO>(.*?)</IGM_NO>"),
            igm_date=parse_ts(_first_group(text, r"<IGM_DT>(.*?)</IGM_DT>")),
            vessel_code=_first_group(text, r"<VesselCode>(.*?)</VesselCode>"),
            voyage_no=_first_group(text, r"<VoyageNo>(.*?)</VoyageNo>"),
            eta=parse_ts(_first_group(
                text, r"<ExpectedDateandtimeofArrival>(.*?)</ExpectedDateandtimeofArrival>")),
            entry_inward=parse_ts(_first_group(
                text, r"<EntryinwardDateandTime>(.*?)</EntryinwardDateandTime>")),
            terminal_operator=_first_group(
                text, r"<TerminalOperatorCode>(.*?)</TerminalOperatorCode>"),
            line_count=int(parse_num(_first_group(
                text, r"<TotalNoofLines>(.*?)</TotalNoofLines>")) or 0),
            source_file=os.path.basename(path),
        ))
    out.sort(key=lambda r: (r.eta or datetime.max, r.igm_no))
    return out, _provenance(read, missing, len(out))


# ==========================================================================
# SECTION 7 -- GATE DOCUMENTS  (EIR, Form 13, pick-up tickets)
# ==========================================================================

GATE_DOC_GLOBS: Tuple[str, ...] = (
    os.path.join(jnpa_paths.UC2_M3_DIR, "Gate_Documents_Form13_EIR_PIN",
                 "EIR", "eir_parsed", "*.json"),
    os.path.join(jnpa_paths.UC2_M3_DIR, "Gate_Documents_Form13_EIR_PIN",
                 "Form 13", "form13_parsed", "*.json"),
    os.path.join(jnpa_paths.UC2_M3_DIR, "Gate_Documents_Form13_EIR_PIN",
                 "PIN_Pickup", "terminal_tickets_parsed", "*.json"),
)


@dataclass(frozen=True)
class GateDocument:
    """
    One gate transaction as evidenced by its paperwork.

    The three document families name the same facts differently -- a truck is
    ``LICNo`` on a PSA EIR, ``TruckNo`` on an IGT Form 13 and ``TrailerNo`` on a
    GTI pick-up ticket -- so the aliases are resolved here once.
    """

    doc_type: str
    terminal: str
    ts: Optional[datetime]
    container: str
    truck_no: str
    iso_code: str
    size_ft: int
    full: bool
    gross_weight_t: Optional[float]
    source_file: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "docType": self.doc_type,
            "terminal": self.terminal,
            "ts": self.ts.isoformat() if self.ts else None,
            "container": self.container,
            "truckNo": self.truck_no,
            "isoCode": self.iso_code,
            "sizeFt": self.size_ft,
            "full": self.full,
            "grossWeightT": self.gross_weight_t,
        }


_ALIASES: Dict[str, Tuple[str, ...]] = {
    "ts": ("DateTime", "Date", "GateInTime", "Time"),
    "container": ("ContainerNo", "ContainerNbr", "Container"),
    "truck": ("LICNo", "TruckNo", "TrailerNo", "VehicleNo"),
    "iso": ("ISOCode", "ISO"),
    "size": ("ContainerSize", "Size"),
    "status": ("ContainerStatus", "Status", "FreightKind"),
    "weight": ("GrossWeight", "Weight", "GrossWeightInMT"),
    "terminal": ("Terminal",),
    "doctype": ("DocumentType", "TicketType"),
}


def _alias(rec: Dict[str, Any], key: str) -> Any:
    for name in _ALIASES[key]:
        if rec.get(name) not in (None, ""):
            return rec[name]
    return None


def load_gate_documents() -> Tuple[List[GateDocument], Provenance]:
    """Parsed EIR / Form 13 / pick-up tickets: real gate transactions with times."""
    files: List[str] = []
    for pattern in GATE_DOC_GLOBS:
        files.extend(sorted(glob.glob(pattern)))
    read = files
    missing: List[str] = [] if files else list(GATE_DOC_GLOBS)

    out: List[GateDocument] = []
    for path in files:
        try:
            with open(path, "r", encoding="utf-8") as fh:
                rec = json.load(fh)
        except Exception:
            continue
        if not isinstance(rec, dict):
            continue
        iso = str(_alias(rec, "iso") or "").strip()
        size = parse_num(_alias(rec, "size")) or iso_size_ft(iso)
        weight = parse_num(_alias(rec, "weight"))
        if weight is not None and weight > 1000:      # kg on IGT Form 13, t elsewhere
            weight /= 1000.0
        status = str(_alias(rec, "status") or "").strip().upper()
        out.append(GateDocument(
            doc_type=str(_alias(rec, "doctype") or "GATE_DOC").strip(),
            terminal=str(_alias(rec, "terminal") or "").strip(),
            ts=parse_ts(_alias(rec, "ts")),
            container=str(_alias(rec, "container") or "").strip().upper(),
            truck_no=str(_alias(rec, "truck") or "").strip().upper(),
            iso_code=iso,
            size_ft=int(size or 0),
            full=status in ("FULL", "F"),
            gross_weight_t=round(weight, 2) if weight is not None else None,
            source_file=os.path.basename(path),
        ))
    out.sort(key=lambda d: (d.ts or datetime.max, d.container))
    return out, _provenance(read, missing, len(out))


# ==========================================================================
# SECTION 8 -- SHIPPING-LINE INVENTORIES  (EAL / IAL)
# ==========================================================================

EAL_IAL_GLOB: str = os.path.join(
    jnpa_paths.UC2_M7_DIR, "Shipping_Lines_EAL_IAL_EDO", "*", "*")

# The nine files ship four different headers. Column names are matched
# case-insensitively against these candidate sets rather than by position.
_INV_COLS: Dict[str, Tuple[str, ...]] = {
    "container": ("containernbr", "container no", "containerno", "cntr_no", "container"),
    "iso": ("iso", "isocode", "eqptype", "iso_code", "iso code"),
    "line": ("line", "opr", "line_code", "operator", "shipping_line"),
    "category": ("category", "cat", "loadstatus", "shippingstatuscode"),
    "freight": ("freightkind", "status", "loadstatus"),
    "weight": ("grossweightinmt", "grossweightin kgs", "grossweight", "vgm wt"),
    "pod": ("pod", "portofdischarge"),
    "temp": ("temp", "temperature", "settemp"),
}


@dataclass(frozen=True)
class InventoryContainer:
    """A container on a shipping line's export (EAL) or import (IAL) list."""

    container: str
    iso_code: str
    line: str
    direction: str        # "EXPORT" | "IMPORT"
    terminal: str
    empty: bool
    reefer: bool
    size_ft: int
    teu: float
    pod: str
    source_file: str

    def as_dict(self) -> Dict[str, Any]:
        return {
            "container": self.container,
            "isoCode": self.iso_code,
            "line": self.line,
            "direction": self.direction,
            "terminal": self.terminal,
            "empty": self.empty,
            "reefer": self.reefer,
            "sizeFt": self.size_ft,
            "teu": self.teu,
            "pod": self.pod,
        }


def _col_index(header: Sequence[Any], key: str) -> int:
    wanted = _INV_COLS[key]
    for idx, name in enumerate(header):
        if str(name or "").strip().lower() in wanted:
            return idx
    return -1


def _find_header_row(grid: Sequence[Sequence[Any]], scan: int = 12) -> int:
    """
    Index of the row that actually names the container column.

    Three of the nine exports (EAL GTI, EAL NSFT, IAL NSFT) are two-part
    files: an ``HDRADVANCE`` voyage block first, then the real column header,
    then the ``CTR`` detail rows. Assuming row 0 is the header loses those
    three terminals entirely, so the header is searched for instead.
    """
    for i, row in enumerate(grid[:scan]):
        if _col_index(row, "container") >= 0:
            return i
    return -1


def load_line_inventories() -> Tuple[List[InventoryContainer], Provenance]:
    """
    Every EAL / IAL container line the corpus carries, across nine files.

    Files whose header matches none of the known schemas (the EDI-payload style
    exports) are skipped and named in ``missing`` rather than silently dropped:
    an inventory that quietly loses a terminal makes the empty-pool balance
    wrong in a direction nobody can see.
    """
    files = [f for f in sorted(glob.glob(EAL_IAL_GLOB))
             if os.path.splitext(f)[1].lower() in (".csv", ".xlsx", ".xls")]
    read: List[str] = []
    missing: List[str] = []
    out: List[InventoryContainer] = []

    for path in files:
        base = os.path.basename(path)
        upper = base.upper()
        if "EDO" in upper:
            continue                                # EDI payload, not an inventory
        direction = "EXPORT" if upper.startswith("EAL") else "IMPORT"
        terminal = re.sub(r"^(EAL|IAL)[ _]*", "", os.path.splitext(base)[0].upper()).strip()

        grid = read_grid(path)
        if not grid:
            missing.append(path)                    # .xls needs xlrd; report it
            continue
        hrow = _find_header_row(grid)
        if hrow < 0:
            missing.append(path)                    # unknown schema, say so
            continue
        header = grid[hrow]
        ci = _col_index(header, "container")
        read.append(path)

        idx = {k: _col_index(header, k) for k in _INV_COLS}
        for row in grid[hrow + 1:]:
            if ci >= len(row):
                continue
            container = str(row[ci] or "").strip().upper()
            if not _CONTAINER_RE.fullmatch(container):
                continue

            def cell(key: str) -> str:
                j = idx[key]
                return str(row[j]).strip() if 0 <= j < len(row) and row[j] is not None else ""

            iso = cell("iso")
            freight = cell("freight").upper()
            empty = freight in ("E", "MTY", "EMPTY") or cell("category").upper() == "MT"
            out.append(InventoryContainer(
                container=container,
                iso_code=iso,
                line=cell("line").upper(),
                direction=direction,
                terminal=terminal,
                empty=empty,
                reefer=iso_is_reefer(iso) or bool(parse_num(cell("temp")) is not None
                                                  and cell("temp") != ""),
                size_ft=iso_size_ft(iso),
                teu=iso_teu(iso),
                pod=cell("pod").upper(),
                source_file=base,
            ))

    note = ""
    if missing:
        note = (f"{len(missing)} file(s) skipped: legacy .xls or unrecognised header "
                f"({', '.join(os.path.basename(m) for m in missing)})")
    return out, _provenance(read, missing, len(out), note)


# ==========================================================================
# SECTION 9 -- ONE-CALL INVENTORY
# ==========================================================================

_LOADERS: Tuple[Tuple[str, str, Any], ...] = (
    ("events", "CODECO container gate events", load_container_events),
    ("dwell", "Paired container stays", pair_dwell_records),
    ("edi", "EDI CODECO messages", load_edi_codeco_messages),
    ("rakes", "FOIS train intimations", load_train_intimations),
    ("manifests", "CTO rake manifests", load_rake_manifests),
    ("tos_containers", "TOS container entry/exit", load_tos_containers),
    ("tos_vessels", "TOS vessel calls (plan vs actual)", load_tos_vessel_calls),
    ("leo", "Customs let-export orders", load_leo_records),
    ("shipping_bills", "Shipping bill headers", load_shipping_bills),
    ("scanning", "RMS scanning lists", load_scanning_lists),
    ("igm", "ICEGATE IGM headers", load_igm_records),
    ("gate_docs", "EIR / Form 13 / pick-up tickets", load_gate_documents),
    ("inventory", "Shipping-line EAL / IAL inventories", load_line_inventories),
)


def inventory() -> Dict[str, Any]:
    """
    Load every source once and report what was found.

    This is what ``GET /uc2/corpus`` serves and what the dashboard's data-source
    badge reads, so a reviewer can see at a glance which models are running on
    real data and which are degraded.
    """
    sources: Dict[str, Any] = {}
    for key, label, loader in _LOADERS:
        try:
            records, prov = loader()
            sources[key] = {"label": label, **prov.as_dict()}
        except Exception as exc:  # noqa: BLE001 - one bad file must not hide the rest
            sources[key] = {
                "label": label, "source": "ERROR", "degraded": True,
                "error": repr(exc)[:300], "record_count": 0,
            }
    real = sum(1 for s in sources.values() if s.get("source") == "CORPUS")
    return {
        "schema_version": SCHEMA_VERSION,
        "module_version": MODULE_VERSION,
        "corpus_dir": jnpa_paths.relative(jnpa_paths.UC2_CORPUS_DIR),
        "corpus_present": os.path.isdir(jnpa_paths.UC2_CORPUS_DIR),
        "sources_total": len(sources),
        "sources_from_corpus": real,
        "sources": sources,
    }


def _self_test() -> List[Tuple[str, bool, str]]:
    checks: List[Tuple[str, bool, str]] = []

    ok = parse_ts("01/07/2026 14:00") == datetime(2026, 7, 1, 14, 0)
    checks.append(("parse_ts dd/mm/yyyy hh:mm", ok, "CODECO dialect"))

    ok = parse_ts("11052026:01:45") == datetime(2026, 5, 11, 1, 45)
    checks.append(("parse_ts FOIS packed", ok, "ddmmyyyy:HH:MM"))

    ok = parse_ts("10-Jun-2026 12:29:58") == datetime(2026, 6, 10, 12, 29, 58)
    checks.append(("parse_ts Form 13", ok, "dd-Mon-yyyy"))

    ok = parse_ts("garbage") is None and parse_ts(None) is None
    checks.append(("parse_ts rejects junk", ok, "returns None, never raises"))

    ok = iso_is_reefer("45R1") and iso_is_reefer("4532") and not iso_is_reefer("2210")
    checks.append(("iso_is_reefer both dialects", ok, "alphanumeric R + numeric group 3"))

    ok = iso_size_ft("2210") == 20 and iso_size_ft("4510") == 40
    checks.append(("iso_size_ft", ok, "20ft / 40ft"))

    ok = container_numbers("x MSCU2095845 y TCNU8512713") == ["MSCU2095845", "TCNU8512713"]
    checks.append(("container_numbers", ok, "ISO 6346 extraction"))

    inv = inventory()
    ok = inv["sources_total"] == len(_LOADERS)
    checks.append(("inventory covers every loader", ok,
                   f"{inv['sources_from_corpus']}/{inv['sources_total']} from corpus"))

    if inv["corpus_present"]:
        recs, _ = pair_dwell_records()
        complete = [r for r in recs if r.complete]
        ok = len(complete) >= 400
        checks.append(("real dwell labels present", ok,
                       f"{len(complete)} complete stays out of {len(recs)}"))

        open_stays = [r for r in recs if r.gate_in and not r.gate_out]
        ok = len(open_stays) > 0
        checks.append(("planted anomalies preserved", ok,
                       f"{len(open_stays)} gate-in with no gate-out kept, not repaired"))
    else:
        checks.append(("corpus present", False, "data/corpus/UC-II_Cargo_Handling missing"))

    return checks


def main(argv: Optional[Sequence[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Inventory the UC-II cargo corpus.")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--source", help="dump one source's records instead")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--selftest", action="store_true")
    args = ap.parse_args(argv)

    if args.selftest:
        checks = _self_test()
        for name, ok, detail in checks:
            print(f"  [{'PASS' if ok else 'FAIL'}] {name:<44} {detail}")
        failed = [c for c in checks if not c[1]]
        print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
        return 1 if failed else 0

    if args.source:
        match = [t for t in _LOADERS if t[0] == args.source]
        if not match:
            print(f"unknown source {args.source!r}; try: "
                  f"{', '.join(t[0] for t in _LOADERS)}")
            return 2
        records, prov = match[0][2]()
        payload = {
            "source": args.source,
            "provenance": prov.as_dict(),
            "records": [r.as_dict() if hasattr(r, "as_dict") else _jsonable(r)
                        for r in records[: args.limit]],
        }
        print(json.dumps(payload, indent=2, default=str))
        return 0

    inv = inventory()
    if args.json:
        print(json.dumps(inv, indent=2))
        return 0

    print("=" * 78)
    print("UC-II cargo-handling corpus inventory")
    print("=" * 78)
    print(f"corpus dir : {inv['corpus_dir']}")
    print(f"present    : {inv['corpus_present']}")
    print(f"real       : {inv['sources_from_corpus']}/{inv['sources_total']} sources\n")
    print(f"  {'source':<16}{'state':<10}{'rows':>8}  files / note")
    print("  " + "-" * 74)
    for key, info in inv["sources"].items():
        files = info.get("files") or []
        detail = info.get("note") or ""
        if files and not detail:
            detail = f"{len(files)} file(s)"
        print(f"  {key:<16}{info.get('source', '?'):<10}{info.get('record_count', 0):>8}  "
              f"{detail[:44]}")
    print("=" * 78)
    return 0


def _jsonable(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: _jsonable(v) for k, v in obj.items()}
    if isinstance(obj, datetime):
        return obj.isoformat()
    return obj


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
