"""
Extract HyTek "Team Rankings - Through Event N" totals from meet PDF text.
"""
import re
from pathlib import Path
from typing import Any

try:
    import pdfplumber
except ImportError:
    pdfplumber = None


def _parse_points_token(s: str) -> float:
    cleaned = s.replace(',', '').strip()
    if not cleaned:
        return 0.0
    return float(cleaned)


def _normalize_team_line(line: str) -> tuple[int, str, float] | None:
    """Parse rank + school + points from a HyTek team score line."""
    line = line.strip()
    if not line or re.search(r'\bTotal\b', line, re.I):
        return None
    m = re.match(
        r'^\s*(\d{1,2})\s+(.+?)\s+([\d,]+(?:\.\d+)?)\s*(?:\t.*)?$',
        line,
    )
    if not m:
        return None
    rank = int(m.group(1))
    team = m.group(2).strip()
    if not team or team.lower() == 'school':
        return None
    pts = _parse_points_token(m.group(3))
    return rank, team, pts


def extract_team_rankings_from_lines(lines: list[str]) -> dict[str, Any]:
    """
    Returns {
      eventThrough: int | None,
      women: { schoolName: points },
      men: { schoolName: points },
    }
    """
    text = '\n'.join(lines)
    event_through = None
    etm = re.search(r'Team Rankings\s*-\s*Through Event\s+(\d+)', text, re.I)
    if etm:
        event_through = int(etm.group(1))

    women: dict[str, float] = {}
    men: dict[str, float] = {}

    upper_lines = [l.strip() for l in lines if l.strip()]

    w_idx = next(
        (i for i, l in enumerate(upper_lines) if re.match(r'^Women\s*-\s*Team Scores', l, re.I)),
        None,
    )
    m_idx = next(
        (i for i, l in enumerate(upper_lines) if re.match(r'^Men\s*-\s*Team Scores', l, re.I)),
        None,
    )

    def parse_block(block_lines: list[str], dest: dict[str, float]) -> None:
        for ln in block_lines:
            if re.match(r'^(Women|Men)\s*-\s*Team Scores', ln, re.I):
                continue
            if re.match(r'^Place\s+School', ln, re.I):
                continue
            parsed = _normalize_team_line(ln)
            if parsed:
                _, team, pts = parsed
                dest[team] = pts

    if w_idx is not None:
        end = m_idx if m_idx is not None and m_idx > w_idx else len(upper_lines)
        parse_block(upper_lines[w_idx + 1 : end], women)

    if m_idx is not None:
        parse_block(upper_lines[m_idx + 1 :], men)

    return {
        'eventThrough': event_through,
        'women': women,
        'men': men,
    }


def extract_team_rankings_from_pdf(pdf_path: str, pages_to_scan: int = 8) -> dict[str, Any]:
    if pdfplumber is None:
        raise RuntimeError('pdfplumber is required to extract team rankings from PDF')
    path = Path(pdf_path)
    if not path.is_file():
        raise FileNotFoundError(pdf_path)

    lines: list[str] = []
    with pdfplumber.open(str(path)) as pdf:
        total = len(pdf.pages)
        start = max(0, total - pages_to_scan)
        for i in range(start, total):
            tx = pdf.pages[i].extract_text()
            if tx:
                lines.extend(tx.split('\n'))

    return extract_team_rankings_from_lines(lines)


if __name__ == '__main__':
    import json
    import sys

    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: team_rankings_parser.py <pdf_path>'}))
        sys.exit(1)
    try:
        result = extract_team_rankings_from_pdf(sys.argv[1])
        print(json.dumps(result))
    except Exception as exc:
        print(json.dumps({'error': str(exc)}))
        sys.exit(1)
