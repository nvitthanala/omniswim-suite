"""
Parse HyTek psych sheet PDFs into individual seed entries (no relay lineups).

Supports one-column (regular) and two-column (divided) layouts via pdf_parser.
Auto mode scores each format attempt and returns the best result.

Usage:
    python psych_parser.py <pdf_path> [format]

Emits JSON on stdout:
    { "results": [ ... ], "format_used": "divided" }
"""
import json
import re
import sys


def _is_relay_event(event):
    return bool(event and re.search(r"\brelay\b", str(event), re.I))


def _psych_time(row):
    for key in ("time", "finals_time", "prelims_time"):
        val = row.get(key)
        if not val:
            continue
        s = str(val).strip()
        if s and s.upper() not in ("NT", "NS", "NP", "DQ", "DFS", "SCR"):
            return s
    return ""


def _normalize_rows(raw):
    if not isinstance(raw, list):
        return []
    out = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        if row.get("is_relay") or _is_relay_event(row.get("event", "")):
            continue
        if row.get("is_exhibition") or row.get("is_time_trial"):
            continue
        seed = _psych_time(row)
        if not seed:
            continue
        normalized = dict(row)
        normalized["is_relay"] = False
        normalized["finals_time"] = None
        normalized["prelims_time"] = None
        normalized["time"] = seed
        normalized["round_swam"] = "Psych Sheet"
        normalized["is_psych_sheet"] = True
        out.append(normalized)
    return out


def _time_minutes(clock):
    s = str(clock or "").strip()
    if ":" not in s:
        return None
    parts = s.split(":", 1)
    try:
        return float(parts[0]) + float(parts[1]) / 60.0
    except (TypeError, ValueError):
        return None


def _score_quality(normalized):
    if not normalized:
        return -1_000_000
    score = len(normalized)
    for row in normalized:
        ev = str(row.get("event") or "")
        if len(ev) > 80:
            score -= 100
        if re.search(r"\b(FR|SO|JR|SR|5Y)\b", ev) and re.search(r"\d{1,2}\.\d{2}", ev) and len(ev) > 45:
            score -= 80
        mins = _time_minutes(row.get("time"))
        if mins is not None:
            if re.search(r"\b1000\b", ev) and mins < 5:
                score -= 60
            if re.search(r"\b1650\b", ev) and mins < 8:
                score -= 60
            if re.search(r"\b500\b", ev) and mins < 2:
                score -= 40
    return score


def _formats_to_try(format_type):
    fmt = (format_type or "auto").lower()
    if fmt in ("divided", "regular"):
        alt = "regular" if fmt == "divided" else "divided"
        return [fmt, alt]
    return ["divided", "regular", "auto"]


def parse_psych_pdf(file_path, format_type="auto"):
    import pdf_parser

    best = None
    best_score = -1_000_000
    best_fmt = None
    seen = set()

    for fmt in _formats_to_try(format_type):
        if fmt in seen:
            continue
        seen.add(fmt)
        rows = _normalize_rows(pdf_parser.parse_pdf(file_path, fmt))
        score = _score_quality(rows)
        if score > best_score:
            best_score = score
            best = rows
            best_fmt = fmt

    return best or [], best_fmt


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}))
        sys.exit(1)
    fmt = sys.argv[2] if len(sys.argv) > 2 else "auto"
    try:
        results, format_used = parse_psych_pdf(sys.argv[1], fmt)
        print(json.dumps({"results": results, "format_used": format_used}))
    except Exception as exc:
        print(json.dumps({"error": str(exc)}))
        sys.exit(1)
