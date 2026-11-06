"""parse_meet rolls per-row warnings up into one entry per code."""
import parse_meet


def test_collect_warnings_counts_rows_per_code():
    rows = [
        {'name': 'A', 'parse_warnings': [{'code': 'unreadable_time', 'message': 'A: no time'}]},
        {'name': 'B', 'parse_warnings': [{'code': 'unreadable_time', 'message': 'B: no time'}]},
        {'name': 'C', 'parse_warnings': [{'code': 'relay_split_legacy_fallback', 'message': 'C relay'}]},
        {'name': 'D'},
    ]
    rolled = {w['code']: w for w in parse_meet._collect_warnings(rows)}
    assert rolled['unreadable_time']['rows'] == 2
    assert rolled['unreadable_time']['examples'] == ['A: no time', 'B: no time']
    assert rolled['relay_split_legacy_fallback']['rows'] == 1


def test_collect_warnings_is_empty_when_no_row_has_one():
    assert parse_meet._collect_warnings([{'name': 'A'}, {'name': 'B'}]) == []


def test_main_reports_points_on_status_clock_as_a_tagged_error(monkeypatch, capsys):
    # The error JSON is the contract the Node route reads: error, code, rows.
    import json

    import point_calculator
    from conftest import make_row

    rows = [make_row('Bob Synthetic', 2, 'DQ', pdf_points=17)]
    cfg = {
        'scoringPoints': [20, 17], 'relayMultiplier': 2, 'usePdfPlacePoints': True,
    }

    def fake_extract(_path, _fmt):
        return rows

    monkeypatch.setattr(parse_meet, '_extract_athletes', fake_extract)
    monkeypatch.setattr(parse_meet, '_team_rankings', lambda _path: None)
    monkeypatch.setattr(
        parse_meet, '_score_athletes',
        lambda raw, _max=None: point_calculator.calculate_points(raw, cfg),
    )
    monkeypatch.setattr('sys.argv', ['parse_meet.py', 'synthetic.pdf'])
    try:
        parse_meet.main()
    except SystemExit as exit_:
        assert exit_.code == 1
    out = json.loads(capsys.readouterr().out)
    assert out['code'] == 'points_on_status_clock'
    assert len(out['rows']) == 1
    assert 'Bob Synthetic' in out['rows'][0]
    assert 'athletes' not in out
