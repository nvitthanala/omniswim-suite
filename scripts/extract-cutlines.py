#!/usr/bin/env python3
"""Extract NCAA / NAIA qualifying standards from the archived primary-source PDFs.

Reads the PDFs recorded in ``data/cutlines/sources/manifest.json`` and emits
normalized JSON to ``data/cutlines/<season>.json`` plus a refreshed
``data/cutlines/index.json``.

Design rules (see the "Data provenance" section of CLAUDE.md):

* **Fail loudly.** Any expected event that is missing, any token that does not
  parse as a time or a score, any unrecognised event label -> ``ParseError`` and
  a non-zero exit. Nothing is defaulted, interpolated, rounded or filled.
* **Absent, never zero.** A division whose PDF cannot be fully parsed is dropped
  from the output entirely; it is never emitted as zeros or partial rows. If any
  division fails, the whole run fails and no file is written.
* **Verbatim values.** Times are carried as the exact published strings. No
  seconds conversion, no re-rounding happens here - TypeScript derives seconds at
  read time so the JSON stays a faithful transcript of the PDF.
* **Provenance on every record.** ``source = {sourceId, url, sha256, page}``.

The four sources have four genuinely different table shapes, so there are four
parsers. See ``CUTLINE_TAGS_PLAN.md`` section A5.

Usage::

    python scripts/fetch-cutlines.py      # archive the PDFs first
    python scripts/extract-cutlines.py    # then parse them
    python scripts/extract-cutlines.py --print-only   # parse + report, write nothing
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterable

REPO_ROOT = Path(__file__).resolve().parent.parent
CUTLINES_DIR = REPO_ROOT / "data" / "cutlines"
SOURCES_DIR = CUTLINES_DIR / "sources"
MANIFEST_PATH = SOURCES_DIR / "manifest.json"


class ParseError(RuntimeError):
    """Raised the moment a source does not look the way we expect."""


# --------------------------------------------------------------------------- #
# Canonical vocabulary
# --------------------------------------------------------------------------- #

# A published label -> canonical event name. Every label a parser meets must be
# in here; an unknown label is a ParseError, never a passthrough.
INDIVIDUAL_EVENT_NAMES: dict[str, str] = {
    "50 FREESTYLE": "50 Freestyle",
    "50 FREE": "50 Freestyle",
    "100 FREESTYLE": "100 Freestyle",
    "100 FREE": "100 Freestyle",
    "200 FREESTYLE": "200 Freestyle",
    "200 FREE": "200 Freestyle",
    "400 FREESTYLE": "400 Freestyle",
    "400 FREE": "400 Freestyle",
    "500 FREESTYLE": "500 Freestyle",
    "500 FREE": "500 Freestyle",
    "800 FREESTYLE": "800 Freestyle",
    "1000 FREESTYLE": "1000 Freestyle",
    "1000 FREE": "1000 Freestyle",
    "1500 FREESTYLE": "1500 Freestyle",
    "1500 FREE": "1500 Freestyle",
    "1650 FREESTYLE": "1650 Freestyle",
    "1650 FREE": "1650 Freestyle",
    "100 BACKSTROKE": "100 Backstroke",
    "100 BACK": "100 Backstroke",
    "200 BACKSTROKE": "200 Backstroke",
    "200 BACK": "200 Backstroke",
    "100 BREASTSTROKE": "100 Breaststroke",
    "100 BREAST": "100 Breaststroke",
    "200 BREASTSTROKE": "200 Breaststroke",
    "200 BREAST": "200 Breaststroke",
    "100 BUTTERFLY": "100 Butterfly",
    "100 FLY": "100 Butterfly",
    "200 BUTTERFLY": "200 Butterfly",
    "200 FLY": "200 Butterfly",
    "200 INDIVIDUAL MEDLEY": "200 Individual Medley",
    "200 IM": "200 Individual Medley",
    "400 INDIVIDUAL MEDLEY": "400 Individual Medley",
    "400 IM": "400 Individual Medley",
}

RELAY_EVENT_NAMES: dict[str, str] = {
    "200 FREESTYLE RELAY": "200 Freestyle Relay",
    "200 FREE RELAY": "200 Freestyle Relay",
    "200 FR": "200 Freestyle Relay",
    "400 FREESTYLE RELAY": "400 Freestyle Relay",
    "400 FREE RELAY": "400 Freestyle Relay",
    "400 FR": "400 Freestyle Relay",
    "800 FREESTYLE RELAY": "800 Freestyle Relay",
    "800 FREE RELAY": "800 Freestyle Relay",
    "800 FR": "800 Freestyle Relay",
    "200 MEDLEY RELAY": "200 Medley Relay",
    "200 MR": "200 Medley Relay",
    "400 MEDLEY RELAY": "400 Medley Relay",
    "400 MR": "400 Medley Relay",
}

BOARD_NAMES: dict[str, tuple[str, str]] = {
    # published label -> (board code, canonical event name)
    "1-METER": ("1M", "1-Meter Diving"),
    "1 METER": ("1M", "1-Meter Diving"),
    "1-METER DIVING": ("1M", "1-Meter Diving"),
    "1-METER DIVING POINTS": ("1M", "1-Meter Diving"),
    "3-METER": ("3M", "3-Meter Diving"),
    "3 METER": ("3M", "3-Meter Diving"),
    "3-METER DIVING": ("3M", "3-Meter Diving"),
    "3-METER DIVING POINTS": ("3M", "3-Meter Diving"),
    "PLATFORM": ("PLATFORM", "Platform Diving"),
    "PLATFORM DIVING": ("PLATFORM", "Platform Diving"),
}

# A published time: 19.43, 1:33.93, 15:06.60. Anchored fully so "300" (a diving
# score) can never be mistaken for a time.
TIME_RE = re.compile(r"^(?:\d{1,3}:)?\d{1,2}\.\d{2}$")
TIME_TOKEN_RE = re.compile(r"(?:\d{1,3}:)?\d{1,2}\.\d{2}")


def normalize_label(raw: str) -> str:
    """Uppercase, collapse whitespace, drop thousands separators."""
    s = raw.upper().replace("’", "'").strip()
    s = re.sub(r"(?<=\d),(?=\d)", "", s)
    s = re.sub(r"[\s ]+", " ", s)
    return s.strip(" .:*#")


def canonical_individual(raw: str, ctx: str) -> str:
    key = normalize_label(raw)
    if key not in INDIVIDUAL_EVENT_NAMES:
        raise ParseError(f"{ctx}: unrecognised individual event label {raw!r} (normalised {key!r})")
    return INDIVIDUAL_EVENT_NAMES[key]


def canonical_relay(raw: str, ctx: str) -> str:
    key = normalize_label(raw)
    if key not in RELAY_EVENT_NAMES:
        raise ParseError(f"{ctx}: unrecognised relay event label {raw!r} (normalised {key!r})")
    return RELAY_EVENT_NAMES[key]


def canonical_board(raw: str, ctx: str) -> tuple[str, str]:
    key = normalize_label(raw)
    if key not in BOARD_NAMES:
        raise ParseError(f"{ctx}: unrecognised diving board label {raw!r} (normalised {key!r})")
    return BOARD_NAMES[key]


def require_time(token: str, ctx: str) -> str:
    t = token.strip()
    if not TIME_RE.match(t):
        raise ParseError(f"{ctx}: {token!r} is not a published time")
    return t


def require_int(token: str, ctx: str) -> int:
    t = token.strip()
    if not re.fullmatch(r"\d{1,4}", t):
        raise ParseError(f"{ctx}: {token!r} is not an integer point total")
    return int(t)


def require_float(token: str, ctx: str) -> float:
    t = token.strip()
    if not re.fullmatch(r"\d{1,3}(?:\.\d{1,2})?", t):
        raise ParseError(f"{ctx}: {token!r} is not a degree of difficulty")
    return float(t)


def assert_events(found: Iterable[str], expected: Iterable[str], ctx: str) -> None:
    found_set = set(found)
    expected_set = set(expected)
    missing = sorted(expected_set - found_set)
    if missing:
        raise ParseError(f"{ctx}: expected events missing from the source: {missing}")


# --------------------------------------------------------------------------- #
# Expected event manifests - a source that does not contain all of these is a
# source we no longer understand, and we refuse to emit a partial table.
# --------------------------------------------------------------------------- #

FREE_1650_SET = [
    "50 Freestyle",
    "100 Freestyle",
    "200 Freestyle",
    "500 Freestyle",
    "1650 Freestyle",
]
STROKES_SET = [
    "100 Backstroke",
    "200 Backstroke",
    "100 Breaststroke",
    "200 Breaststroke",
    "100 Butterfly",
    "200 Butterfly",
    "200 Individual Medley",
    "400 Individual Medley",
]
ALL_RELAYS = [
    "200 Freestyle Relay",
    "400 Freestyle Relay",
    "800 Freestyle Relay",
    "200 Medley Relay",
    "400 Medley Relay",
]

EXPECTED_D1_INDIVIDUAL = FREE_1650_SET + STROKES_SET
EXPECTED_D2_INDIVIDUAL = FREE_1650_SET + ["1000 Freestyle"] + STROKES_SET
EXPECTED_D3_INDIVIDUAL = FREE_1650_SET + STROKES_SET
EXPECTED_NAIA_SCY_INDIVIDUAL = FREE_1650_SET + STROKES_SET
EXPECTED_NAIA_METRIC_INDIVIDUAL = [
    "50 Freestyle",
    "100 Freestyle",
    "200 Freestyle",
    "400 Freestyle",
    "1500 Freestyle",
] + STROKES_SET


# --------------------------------------------------------------------------- #
# Record builders
# --------------------------------------------------------------------------- #


def make_source(src: dict[str, Any], page: int) -> dict[str, Any]:
    return {
        "sourceId": src["id"],
        "url": src["url"],
        "sha256": src["sha256"],
        "page": page,  # 1-based, as a human reading the PDF would count
    }


def individual(
    *, division: str, season: str, gender: str, event: str, course: str, source: dict[str, Any], **scale: Any
) -> dict[str, Any]:
    return {
        "kind": "individual",
        "division": division,
        "season": season,
        "gender": gender,
        "event": event,
        "course": course,
        **scale,
        "source": source,
    }


def relay(
    *, division: str, season: str, gender: str, event: str, course: str, source: dict[str, Any], **scale: Any
) -> dict[str, Any]:
    return {
        "kind": "relay",
        "division": division,
        "season": season,
        "gender": gender,
        "event": event,
        "course": course,
        **scale,
        "source": source,
    }


def diving(
    *,
    division: str,
    season: str,
    gender: str,
    event: str,
    board: str,
    dive_count: int,
    points: int,
    course: str,
    source: dict[str, Any],
    minimum_dd: float | None = None,
    note: str | None = None,
) -> dict[str, Any]:
    rec: dict[str, Any] = {
        "kind": "diving",
        "division": division,
        "season": season,
        "gender": gender,
        "event": event,
        "course": course,
        "board": board,
        "diveCount": dive_count,
        "points": points,
        "source": source,
    }
    if minimum_dd is not None:
        rec["minimumDegreeOfDifficulty"] = minimum_dd
    if note:
        rec["note"] = note
    return rec


# --------------------------------------------------------------------------- #
# Shared line helpers
# --------------------------------------------------------------------------- #


def page_lines(pdf_path: Path, page_index: int) -> list[str]:
    import pdfplumber

    with pdfplumber.open(pdf_path) as pdf:
        if page_index >= len(pdf.pages):
            raise ParseError(f"{pdf_path.name}: expected a page {page_index} but the file has {len(pdf.pages)}")
        text = pdf.pages[page_index].extract_text()
    if not text:
        raise ParseError(f"{pdf_path.name}: page {page_index} produced no extractable text")
    return [ln.strip() for ln in text.splitlines() if ln.strip()]


def section(lines: list[str], start_marker: str, *stop_markers: str) -> list[str]:
    """Lines strictly between ``start_marker`` and the first following stop marker."""
    upper = [normalize_label(ln) for ln in lines]
    start = normalize_label(start_marker)
    try:
        i = upper.index(start)
    except ValueError:
        raise ParseError(f"section marker {start_marker!r} not found") from None
    stops = {normalize_label(m) for m in stop_markers}
    out: list[str] = []
    for j in range(i + 1, len(lines)):
        if upper[j] in stops:
            break
        out.append(lines[j])
    if not out:
        raise ParseError(f"section {start_marker!r} is empty")
    return out


def split_label_and_values(line: str) -> tuple[str, list[str]]:
    """Split a table row into its leading label and its trailing value tokens."""
    tokens = line.split()
    idx = len(tokens)
    while idx > 0 and re.fullmatch(r"(?:N/?A|NA|\*+|#|(?:\d{1,3}:)?\d{1,2}\.\d{2}|\d{1,4}(?:\.\d{1,2})?)", tokens[idx - 1]):
        idx -= 1
    return " ".join(tokens[:idx]), tokens[idx:]


# --------------------------------------------------------------------------- #
# D1 - 2025-26, men on page 1, women on page 2 (1-based)
# --------------------------------------------------------------------------- #


def parse_d1(src: dict[str, Any], pdf_path: Path) -> list[dict[str, Any]]:
    season = src["season"]
    records: list[dict[str, Any]] = []

    for page_index, gender in ((0, "Men"), (1, "Women")):
        who = gender.upper() + "'S"
        lines = page_lines(pdf_path, page_index)
        ctx = f"D1 {gender} p{page_index + 1}"
        source = make_source(src, page_index + 1)

        # --- individual: single STANDARD column ---
        ind_lines = section(lines, f"{who} SWIMMING STANDARDS", f"{who} RELAY STANDARDS")
        seen_ind: list[str] = []
        for line in ind_lines:
            if normalize_label(line) in {"25-YARD COURSE", "EVENT STANDARD"}:
                continue
            label, values = split_label_and_values(line)
            if not label:
                continue
            if len(values) != 1:
                raise ParseError(f"{ctx}: individual row {line!r} has {len(values)} values, expected exactly 1")
            event = canonical_individual(label, ctx)
            records.append(
                individual(
                    division="D1",
                    season=season,
                    gender=gender,
                    event=event,
                    course="SCY",
                    source=source,
                    scale="single",
                    standard=require_time(values[0], f"{ctx} {event}"),
                )
            )
            seen_ind.append(event)
        assert_events(seen_ind, EXPECTED_D1_INDIVIDUAL, f"{ctx} individual")

        # --- relays: QUALIFYING and PROVISIONAL ---
        relay_lines = section(lines, f"{who} RELAY STANDARDS", f"{who} DIVING STANDARDS")
        seen_relay: list[str] = []
        for line in relay_lines:
            if normalize_label(line) in {"25-YARD COURSE", "EVENT QUALIFYING PROVISIONAL"}:
                continue
            label, values = split_label_and_values(line)
            if not label:
                continue
            if len(values) != 2:
                raise ParseError(f"{ctx}: relay row {line!r} has {len(values)} values, expected 2")
            event = canonical_relay(label, ctx)
            records.append(
                relay(
                    division="D1",
                    season=season,
                    gender=gender,
                    event=event,
                    course="SCY",
                    source=source,
                    scale="qualifyingProvisional",
                    qualifying=require_time(values[0], f"{ctx} {event} qualifying"),
                    provisional=require_time(values[1], f"{ctx} {event} provisional"),
                )
            )
            seen_relay.append(event)
        assert_events(seen_relay, ALL_RELAYS, f"{ctx} relay")

        # --- diving: points, with footnote markers naming the dive-list size ---
        dive_lines = section(lines, f"{who} DIVING STANDARDS", "QUALIFYING STANDARDS")
        marker_dive_count: dict[str, int] = {}
        marker_note: dict[str, str] = {}
        for line in dive_lines:
            m = re.match(r"^(\*+)\s*Qualifying point total in any (\d+) dive list", line, re.I)
            if m:
                marker_dive_count[m.group(1)] = int(m.group(2))
                marker_note[m.group(1)] = re.sub(r"^\*+\s*", "", line).strip()
        if not marker_dive_count:
            raise ParseError(f"{ctx}: diving footnotes name no dive-list size; refusing to guess")

        seen_boards: list[str] = []
        for line in dive_lines:
            if normalize_label(line) in {"EVENT POINTS"} or line.lstrip().startswith("*"):
                continue
            m = re.match(r"^(?P<label>[A-Za-z0-9\- ]*?Diving)\s+(?P<rest>.+)$", line)
            if not m:
                continue
            board, event = canonical_board(m.group("label"), ctx)
            variants = [v.strip() for v in m.group("rest").split("/")]
            for variant in variants:
                vm = re.fullmatch(r"(\d{1,4})\s*(\*+)", variant)
                if not vm:
                    raise ParseError(
                        f"{ctx}: diving value {variant!r} in {line!r} has no footnote marker; "
                        "dive-list size would have to be guessed"
                    )
                marker = vm.group(2)
                if marker not in marker_dive_count:
                    raise ParseError(f"{ctx}: diving footnote marker {marker!r} is not defined on this page")
                records.append(
                    diving(
                        division="D1",
                        season=season,
                        gender=gender,
                        event=event,
                        board=board,
                        dive_count=marker_dive_count[marker],
                        points=require_int(vm.group(1), f"{ctx} {event}"),
                        course="SCY",
                        source=source,
                        note=marker_note.get(marker),
                    )
                )
            seen_boards.append(board)
        assert_events(seen_boards, ["1M", "3M", "PLATFORM"], f"{ctx} diving")

    return records


# --------------------------------------------------------------------------- #
# D2 - 2026-27, one file per gender, table on page 1 (1-based)
# --------------------------------------------------------------------------- #


def parse_d2(src: dict[str, Any], pdf_path: Path) -> list[dict[str, Any]]:
    season = src["season"]
    gender = {"M": "Men", "W": "Women"}.get(src["genders"], "")
    if not gender:
        raise ParseError(f"{src['id']}: expected a single-gender source, got genders={src['genders']!r}")
    who = gender.upper() + "'S"
    lines = page_lines(pdf_path, 0)
    ctx = f"D2 {gender} p1"
    source = make_source(src, 1)
    records: list[dict[str, Any]] = []

    ind_lines = section(lines, f"{who} SWIMMING STANDARDS", f"{who} RELAY STANDARDS")
    seen_ind: list[str] = []
    for line in ind_lines:
        if normalize_label(line) in {"25-YARD COURSE", "A B", "EVENT", "STANDARD STANDARD", "EVENT STANDARD"}:
            continue
        label, values = split_label_and_values(line)
        if not label:
            continue
        if len(values) != 2:
            raise ParseError(f"{ctx}: individual row {line!r} has {len(values)} values, expected A and B")
        event = canonical_individual(label, ctx)
        records.append(
            individual(
                division="D2",
                season=season,
                gender=gender,
                event=event,
                course="SCY",
                source=source,
                scale="ab",
                aStandard=require_time(values[0], f"{ctx} {event} A"),
                bStandard=require_time(values[1], f"{ctx} {event} B"),
            )
        )
        seen_ind.append(event)
    assert_events(seen_ind, EXPECTED_D2_INDIVIDUAL, f"{ctx} individual")

    relay_lines = section(lines, f"{who} RELAY STANDARDS", f"{who} DIVING STANDARDS")
    seen_relay: list[str] = []
    for line in relay_lines:
        if normalize_label(line) in {"25-YARD COURSE", "EVENT QUALIFYING PROVISIONAL"}:
            continue
        label, values = split_label_and_values(line)
        if not label:
            continue
        if len(values) != 2:
            raise ParseError(f"{ctx}: relay row {line!r} has {len(values)} values, expected 2")
        event = canonical_relay(label, ctx)
        if normalize_label(values[0]) not in {"N/A", "NA"}:
            raise ParseError(
                f"{ctx}: relay {event} publishes a QUALIFYING value {values[0]!r}. D2 has always printed N/A "
                "here; the source layout changed and the parser must be reviewed."
            )
        records.append(
            relay(
                division="D2",
                season=season,
                gender=gender,
                event=event,
                course="SCY",
                source=source,
                scale="provisionalOnly",
                provisional=require_time(values[1], f"{ctx} {event} provisional"),
            )
        )
        seen_relay.append(event)
    assert_events(seen_relay, ALL_RELAYS, f"{ctx} relay")

    # Diving: "EVENT Dual-6 Optionals Championship-11 Dives" then
    # "1-Meter Diving Points * 285 440", with a footnote per marker naming the
    # minimum degree of difficulty for the six optional dives.
    dive_lines = section(lines, f"{who} DIVING STANDARDS", "CONVERSIONS")
    header = next((ln for ln in dive_lines if normalize_label(ln).startswith("EVENT DUAL-")), None)
    if header is None:
        raise ParseError(f"{ctx}: diving header row not found; dive-list sizes would have to be guessed")
    counts = re.findall(r"-(\d+)\b", header)
    if len(counts) != 2:
        raise ParseError(f"{ctx}: diving header {header!r} does not name exactly two dive-list sizes")
    dual_count, champ_count = int(counts[0]), int(counts[1])

    marker_dd: dict[str, float] = {}
    marker_note: dict[str, str] = {}
    for line in dive_lines:
        m = re.match(
            r"^(?P<marker>\*+|#+)\s*A minimum degree of difficulty on the .*?shall be a (?P<dd>\d+(?:\.\d+)?)",
            line,
            re.I,
        )
        if m:
            marker_dd[m.group("marker")] = float(m.group("dd"))
            marker_note[m.group("marker")] = re.sub(r"^(\*+|#+)\s*", "", line).strip()

    seen_boards: list[str] = []
    for line in dive_lines:
        m = re.match(r"^(?P<label>[A-Za-z0-9\- ]*?Diving Points)\s*(?P<marker>\*+|#+)?\s+(?P<rest>.+)$", line)
        if not m:
            continue
        board, event = canonical_board(m.group("label"), ctx)
        marker = m.group("marker")
        values = m.group("rest").split()
        if len(values) != 2:
            raise ParseError(f"{ctx}: diving row {line!r} has {len(values)} scores, expected 2")
        min_dd = marker_dd.get(marker) if marker else None
        if marker and min_dd is None:
            raise ParseError(f"{ctx}: diving marker {marker!r} on {line!r} has no matching footnote")
        for dive_count, raw, carries_dd in (
            (dual_count, values[0], True),
            (champ_count, values[1], False),
        ):
            records.append(
                diving(
                    division="D2",
                    season=season,
                    gender=gender,
                    event=event,
                    board=board,
                    dive_count=dive_count,
                    points=require_int(raw, f"{ctx} {event} {dive_count}-dive"),
                    course="SCY",
                    source=source,
                    # The footnote is worded "on the ... six optional dives", so the
                    # published minimum DD is only asserted for the 6-dive variant.
                    minimum_dd=min_dd if (carries_dd and dive_count == 6) else None,
                    note=marker_note.get(marker) if marker else None,
                )
            )
        seen_boards.append(board)
    assert_events(seen_boards, ["1M", "3M"], f"{ctx} diving")

    return records


# --------------------------------------------------------------------------- #
# D3 - 2026-27, single combined file: Event | MEN A B Invited | WOMEN A B Invited
# --------------------------------------------------------------------------- #


def parse_d3(src: dict[str, Any], pdf_path: Path) -> list[dict[str, Any]]:
    season = src["season"]
    lines = page_lines(pdf_path, 0)
    ctx = "D3 p1"
    source = make_source(src, 1)
    records: list[dict[str, Any]] = []

    def index_of(pred) -> int:
        for i, ln in enumerate(lines):
            if pred(normalize_label(ln)):
                return i
        return -1

    i_ind = index_of(lambda s: s == "INDIVIDUAL")
    i_rel = index_of(lambda s: s == "RELAYS")
    i_div = index_of(lambda s: s.startswith("EVENT # OF DIVES"))
    if min(i_ind, i_rel, i_div) < 0:
        raise ParseError(f"{ctx}: could not locate Individual / Relays / diving sections ({i_ind}, {i_rel}, {i_div})")
    if not (i_ind < i_rel < i_div):
        raise ParseError(f"{ctx}: sections are out of the expected order")

    seen_ind: list[str] = []
    for line in lines[i_ind + 1 : i_rel]:
        label, values = split_label_and_values(line)
        if not label:
            continue
        if len(values) != 6:
            raise ParseError(
                f"{ctx}: individual row {line!r} has {len(values)} values, expected 6 "
                "(men A/B/Invited then women A/B/Invited)"
            )
        event = canonical_individual(label, ctx)
        for gender, trio in (("Men", values[0:3]), ("Women", values[3:6])):
            records.append(
                individual(
                    division="D3",
                    season=season,
                    gender=gender,
                    event=event,
                    course="SCY",
                    source=source,
                    scale="abInvited",
                    aStandard=require_time(trio[0], f"{ctx} {gender} {event} A"),
                    bStandard=require_time(trio[1], f"{ctx} {gender} {event} B"),
                    invitedStandard=require_time(trio[2], f"{ctx} {gender} {event} Invited"),
                )
            )
        seen_ind.append(event)
    assert_events(seen_ind, EXPECTED_D3_INDIVIDUAL, f"{ctx} individual")

    seen_relay: list[str] = []
    for line in lines[i_rel + 1 : i_div]:
        label, values = split_label_and_values(line)
        if not label:
            continue
        if len(values) != 6:
            raise ParseError(f"{ctx}: relay row {line!r} has {len(values)} values, expected 6")
        event = canonical_relay(label, ctx)
        for gender, trio in (("Men", values[0:3]), ("Women", values[3:6])):
            if normalize_label(trio[0]) not in {"NA", "N/A"}:
                raise ParseError(
                    f"{ctx}: relay {gender} {event} publishes an A-cut {trio[0]!r}. D3 has always printed NA "
                    "here; the source layout changed and the parser must be reviewed."
                )
            records.append(
                relay(
                    division="D3",
                    season=season,
                    gender=gender,
                    event=event,
                    course="SCY",
                    source=source,
                    scale="provisionalInvited",
                    provisional=require_time(trio[1], f"{ctx} {gender} {event} B"),
                    invited=require_time(trio[2], f"{ctx} {gender} {event} Invited"),
                )
            )
        seen_relay.append(event)
    assert_events(seen_relay, ALL_RELAYS, f"{ctx} relay")

    seen_dive: list[tuple[str, int]] = []
    for line in lines[i_div + 1 :]:
        m = re.match(
            r"^(?P<label>1-Meter|3-Meter|Platform)\s+(?P<dives>\d+)\s+Dives?\s+(?P<men>\d{1,4})\s+(?P<women>\d{1,4})$",
            line,
            re.I,
        )
        if not m:
            continue
        board, event = canonical_board(m.group("label"), ctx)
        dive_count = int(m.group("dives"))
        for gender, raw in (("Men", m.group("men")), ("Women", m.group("women"))):
            records.append(
                diving(
                    division="D3",
                    season=season,
                    gender=gender,
                    event=event,
                    board=board,
                    dive_count=dive_count,
                    points=require_int(raw, f"{ctx} {gender} {event} {dive_count}-dive"),
                    course="SCY",
                    source=source,
                )
            )
        seen_dive.append((board, dive_count))
    for expected in [("1M", 6), ("1M", 11), ("3M", 6), ("3M", 11)]:
        if expected not in seen_dive:
            raise ParseError(f"{ctx} diving: expected {expected[0]} {expected[1]}-dive row is missing")

    return records


# --------------------------------------------------------------------------- #
# NAIA - 2026-27, EVENTS | MEN YARDS | MEN METERS | WOMEN YARDS | WOMEN METERS,
# two rows per event (automatic then provisional). No relays in this file.
# --------------------------------------------------------------------------- #

# The NAIA sheet labels the metric column only "METERS" and never states the
# course length. We record it as METRIC_UNSPECIFIED rather than asserting SCM or
# LCM, because the source does not say. See CLAUDE.md "Data provenance".
NAIA_METRIC_COURSE = "METRIC_UNSPECIFIED"

# "500/400 FREESTYLE" means 500 yards OR 400 metres - a different distance per
# course, so the joint label expands to two different canonical events.
NAIA_SPLIT_LABELS: dict[str, tuple[str, str]] = {
    "500/400 FREESTYLE": ("500 Freestyle", "400 Freestyle"),
    "1650/1500 FREESTYLE": ("1650 Freestyle", "1500 Freestyle"),
}


def parse_naia(src: dict[str, Any], pdf_path: Path) -> list[dict[str, Any]]:
    season = src["season"]
    lines = page_lines(pdf_path, 0)
    ctx = "NAIA p1"
    source = make_source(src, 1)
    records: list[dict[str, Any]] = []

    header_idx = next(
        (i for i, ln in enumerate(lines) if normalize_label(ln) == "YARDS METERS YARDS METERS"),
        -1,
    )
    if header_idx < 0:
        raise ParseError(f"{ctx}: column header 'YARDS METERS YARDS METERS' not found")
    dive_header_idx = next(
        (i for i, ln in enumerate(lines) if normalize_label(ln).startswith("EVENT SCORE DIFFICULTY")),
        -1,
    )
    if dive_header_idx < 0:
        raise ParseError(f"{ctx}: diving header row not found")
    # The diving block is introduced by a wrapped "Minimum Degree of" caption that
    # sits above its own header row; the swimming table ends there.
    swim_end_idx = next(
        (
            i
            for i, ln in enumerate(lines)
            if i > header_idx and normalize_label(ln).startswith("MINIMUM DEGREE OF")
        ),
        dive_header_idx,
    )
    swim_end_idx = min(swim_end_idx, dive_header_idx)

    pending: tuple[str, str, list[str]] | None = None  # (scy event, metric event, auto values)
    seen_scy: list[str] = []
    seen_metric: list[str] = []

    for line in lines[header_idx + 1 : swim_end_idx]:
        label, values = split_label_and_values(line)
        if not label and not values:
            continue
        if len(values) != 4:
            if pending is None and not label:
                continue
            raise ParseError(f"{ctx}: row {line!r} has {len(values)} values, expected 4 (M yd, M m, W yd, W m)")

        if label:
            if pending is not None:
                raise ParseError(
                    f"{ctx}: event {pending[0]!r} was followed by another labelled row {label!r} instead of "
                    "its provisional row; the two-row layout changed"
                )
            key = normalize_label(label)
            if key in NAIA_SPLIT_LABELS:
                scy_event, metric_event = NAIA_SPLIT_LABELS[key]
            else:
                scy_event = metric_event = canonical_individual(label, ctx)
            pending = (scy_event, metric_event, values)
            continue

        if pending is None:
            raise ParseError(f"{ctx}: unlabelled value row {line!r} with no preceding event row")
        scy_event, metric_event, auto = pending
        prov = values
        pending = None
        for gender, yd_i, m_i in (("Men", 0, 1), ("Women", 2, 3)):
            records.append(
                individual(
                    division="NAIA",
                    season=season,
                    gender=gender,
                    event=scy_event,
                    course="SCY",
                    source=source,
                    scale="ab",
                    aStandard=require_time(auto[yd_i], f"{ctx} {gender} {scy_event} yards auto"),
                    bStandard=require_time(prov[yd_i], f"{ctx} {gender} {scy_event} yards provisional"),
                )
            )
            records.append(
                individual(
                    division="NAIA",
                    season=season,
                    gender=gender,
                    event=metric_event,
                    course=NAIA_METRIC_COURSE,
                    source=source,
                    scale="ab",
                    aStandard=require_time(auto[m_i], f"{ctx} {gender} {metric_event} metres auto"),
                    bStandard=require_time(prov[m_i], f"{ctx} {gender} {metric_event} metres provisional"),
                )
            )
        seen_scy.append(scy_event)
        seen_metric.append(metric_event)

    if pending is not None:
        raise ParseError(f"{ctx}: event {pending[0]!r} has an automatic row but no provisional row")
    assert_events(seen_scy, EXPECTED_NAIA_SCY_INDIVIDUAL, f"{ctx} individual (yards)")
    assert_events(seen_metric, EXPECTED_NAIA_METRIC_INDIVIDUAL, f"{ctx} individual (metres)")

    seen_boards: list[str] = []
    for line in lines[dive_header_idx + 1 :]:
        m = re.match(
            r"^(?P<label>1 METER|3 METER)\s*\((?P<dives>\d+)\s*DIVES?\)\s+"
            r"(?P<mp>\d{1,4})\s+(?P<mdd>\d{1,3}(?:\.\d{1,2})?)\s+"
            r"(?P<wp>\d{1,4})\s+(?P<wdd>\d{1,3}(?:\.\d{1,2})?)$",
            line,
            re.I,
        )
        if not m:
            continue
        board, event = canonical_board(m.group("label"), ctx)
        dive_count = int(m.group("dives"))
        for gender, pts, dd in (
            ("Men", m.group("mp"), m.group("mdd")),
            ("Women", m.group("wp"), m.group("wdd")),
        ):
            records.append(
                diving(
                    division="NAIA",
                    season=season,
                    gender=gender,
                    event=event,
                    board=board,
                    dive_count=dive_count,
                    points=require_int(pts, f"{ctx} {gender} {event}"),
                    course="SCY",
                    source=source,
                    minimum_dd=require_float(dd, f"{ctx} {gender} {event} min DD"),
                )
            )
        seen_boards.append(board)
    assert_events(seen_boards, ["1M", "3M"], f"{ctx} diving")

    # The published filename is "...-wo-Relays": this source contains no relay
    # standards. They are absent, not zero, and are never invented.
    return records


PARSERS = {
    "ncaa-d1-2025-26": parse_d1,
    "ncaa-d2-men-2026-27": parse_d2,
    "ncaa-d2-women-2026-27": parse_d2,
    "ncaa-d3-2026-27": parse_d3,
    "naia-2026-27": parse_naia,
}


# --------------------------------------------------------------------------- #
# Driver
# --------------------------------------------------------------------------- #


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--print-only", action="store_true", help="parse and report; write no files")
    args = parser.parse_args()

    if not MANIFEST_PATH.exists():
        print(
            f"Missing {MANIFEST_PATH.relative_to(REPO_ROOT)}. Run scripts/fetch-cutlines.py first.",
            file=sys.stderr,
        )
        return 2
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    sources = manifest.get("sources", [])
    if not sources:
        print("Manifest lists no sources.", file=sys.stderr)
        return 2

    by_season: dict[str, list[dict[str, Any]]] = {}
    season_sources: dict[str, list[dict[str, Any]]] = {}
    failures: list[str] = []

    for src in sources:
        parse = PARSERS.get(src["id"])
        if parse is None:
            failures.append(f"{src['id']}: no parser registered for this source")
            continue
        pdf_path = SOURCES_DIR / src["filename"]
        if not pdf_path.exists():
            failures.append(f"{src['id']}: {pdf_path.name} is not on disk; re-run fetch-cutlines.py")
            continue
        try:
            records = parse(src, pdf_path)
        except ParseError as exc:
            failures.append(f"{src['id']}: {exc}")
            continue
        if not records:
            failures.append(f"{src['id']}: parser produced zero records")
            continue
        by_season.setdefault(src["season"], []).extend(records)
        season_sources.setdefault(src["season"], []).append(
            {
                "id": src["id"],
                "division": src["division"],
                "url": src["url"],
                "sha256": src["sha256"],
                "retrievedAt": src.get("retrievedAt"),
                "pageCount": src.get("pageCount"),
            }
        )
        kinds = {"individual": 0, "relay": 0, "diving": 0}
        for r in records:
            kinds[r["kind"]] += 1
        print(
            f"OK  {src['id']:<22} {len(records):>4} records "
            f"({kinds['individual']} individual, {kinds['relay']} relay, {kinds['diving']} diving)"
        )

    if failures:
        print("\nEXTRACTION FAILED:", file=sys.stderr)
        for line in failures:
            print(f"  - {line}", file=sys.stderr)
        print(
            "\nNo file written. A division that cannot be fully parsed is emitted as absent,\n"
            "never as zeros or a partial table.",
            file=sys.stderr,
        )
        return 1

    generated_at = (
        _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    )

    if args.print_only:
        for season, records in sorted(by_season.items()):
            print(f"\n{season}: {len(records)} records")
        return 0

    written: list[str] = []
    for season, records in sorted(by_season.items()):
        records.sort(
            key=lambda r: (r["division"], r["gender"], r["kind"], r["course"], r["event"], r.get("diveCount", 0))
        )
        divisions = sorted({r["division"] for r in records})
        payload = {
            "version": season,
            "season": season,
            "generatedAt": generated_at,
            "generator": "scripts/extract-cutlines.py",
            "divisions": divisions,
            "sources": season_sources[season],
            "cutlines": records,
        }
        out = CUTLINES_DIR / f"{season}.json"
        out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        written.append(season)
        print(f"Wrote {out.relative_to(REPO_ROOT)}  ({len(records)} records, divisions {divisions})")

    index = {
        "description": (
            "Versioned qualifying-standard tables, generated from the archived PDFs in "
            "sources/ by scripts/extract-cutlines.py. Each <version>.json is "
            "{version, season, generatedAt, divisions, sources, cutlines[]}. The server "
            "serves these via GET /api/cutlines/:version and accepts either a bare array "
            "or an object with a `cutlines` key. Never hand-edit these files."
        ),
        "default": "2026-2027",
        "serverBuiltinVersion": "2025-2026",
        "versions": sorted(written, reverse=True),
        "updatedAt": generated_at,
    }
    index_path = CUTLINES_DIR / "index.json"
    index_path.write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {index_path.relative_to(REPO_ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
