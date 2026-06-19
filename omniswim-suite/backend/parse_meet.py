"""
Unified meet parsing entry point.

Runs the full PDF pipeline in a single Python process instead of three
separate subprocess spawns:

    1. pdf_parser.extract           -> raw athlete rows
    2. point_calculator.calculate   -> scored athlete rows
    3. team_rankings_parser.extract -> official team totals (optional)

Usage:
    python parse_meet.py <pdf_path> [format]

Emits a single JSON object on stdout:
    { "athletes": [...], "conference": str | None, "officialTeamScores": {...} | None }

On failure emits: { "error": "<message>" }
"""
import json
import sys
import traceback


def _load_callable(module, names):
    for name in names:
        fn = getattr(module, name, None)
        if callable(fn):
            return fn
    return None


def _extract_athletes(pdf_path, fmt):
    import pdf_parser

    # pdf_parser exposes its work through a CLI main; prefer a direct function
    # if one exists, otherwise fall back to invoking the documented entry point.
    fn = _load_callable(
        pdf_parser,
        ['parse_pdf', 'extract_results', 'extract', 'main_parse', 'parse'],
    )
    if fn is not None:
        return fn(pdf_path, fmt)

    # Fallback: reuse the script's __main__ behavior by calling its core helper.
    # pdf_parser prints JSON when run as a script; replicate by capturing here.
    raise RuntimeError(
        'pdf_parser does not expose a callable parse function; run via legacy path'
    )


def _score_athletes(raw_athletes):
    import point_calculator

    fn = _load_callable(point_calculator, ['calculate_points'])
    if fn is None:
        raise RuntimeError('point_calculator.calculate_points not found')
    return fn(raw_athletes)


def _team_rankings(pdf_path):
    try:
        import team_rankings_parser

        fn = _load_callable(
            team_rankings_parser,
            ['extract_team_rankings_from_pdf'],
        )
        if fn is None:
            return None
        result = fn(pdf_path)
        if isinstance(result, dict) and not result.get('error'):
            if result.get('men') or result.get('women'):
                return {
                    'eventThrough': result.get('eventThrough'),
                    'men': result.get('men') or {},
                    'women': result.get('women') or {},
                }
    except Exception:
        return None
    return None


def main():
    if len(sys.argv) < 2:
        print(json.dumps({'error': 'Usage: parse_meet.py <pdf_path> [format]'}))
        sys.exit(1)

    pdf_path = sys.argv[1]
    fmt = sys.argv[2] if len(sys.argv) > 2 else 'auto'

    try:
        raw = _extract_athletes(pdf_path, fmt)
        if isinstance(raw, str):
            raw = json.loads(raw)
        if isinstance(raw, dict) and raw.get('error'):
            print(json.dumps({'error': raw['error']}))
            sys.exit(1)

        scored = _score_athletes(raw)
        conference = None
        if isinstance(scored, list) and scored and isinstance(scored[0], dict):
            c = scored[0].get('conference')
            if isinstance(c, str):
                conference = c

        official = _team_rankings(pdf_path)

        print(json.dumps({
            'athletes': scored,
            'conference': conference,
            'officialTeamScores': official,
        }))
    except Exception as exc:  # noqa: BLE001 - surface any failure as JSON
        print(json.dumps({'error': str(exc), 'trace': traceback.format_exc()}))
        sys.exit(1)


if __name__ == '__main__':
    main()
