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
