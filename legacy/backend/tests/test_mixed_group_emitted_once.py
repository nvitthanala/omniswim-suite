"""A tied group that mixes scoring and non-scoring rows emits each row once.

`_process_scoring_event` splits a group of same-round, same-rank rows into
`ineligible` (`is_scoring_athlete` is False) and `eligible`. It used to emit
`ineligible` early and then emit the whole `group` again at the end of the
group, so an ineligible row that shared a printed rank with a scoring row was
returned twice. The same dict object appeared twice in the output, and a
consumer that counted rows or summed them saw an extra row.

A row reaches the group split as "ineligible" only when the untimed-row gate
(`_row_time_seconds`: finals, then prelims, then relay clock) reads a time but
`_swim_result_clock` (finals-round rows: relay clock, finals, then `time`) does
not. A finals-round row that has only a prelims clock is such a row.
"""
import pytest
from conftest import make_row

import point_calculator as pc


def _count_of(rows, row):
    return sum(1 for r in rows if r is row)


def _prelims_only_final_row(name, team):
    # Round A Final, but only a prelims clock is printed: timed to the gate,
    # not a scoring result to `is_scoring_athlete`.
    return make_row(name, 1, None, prelims_time='50.00', team=team)


def test_timed_but_ineligible_row_sharing_a_rank_is_emitted_once(cfg):
    alice = make_row('Alice Synthetic', 1, '50.00', team='Test Team A')
    bob = _prelims_only_final_row('Bob Synthetic', 'Test Team B')
    cara = make_row('Cara Synthetic', 2, '51.00', team='Test Team C')
    rows = [alice, bob, cara]
    assert pc.is_scoring_athlete(bob) is False  # the precondition this test relies on
    assert pc._unreadable_time_warning(bob) is None

    scored = pc.calculate_points(rows, cfg)

    assert len(scored) == 3
    for row in rows:
        assert _count_of(scored, row) == 1, row['name']
    by_name = {r['name']: r for r in scored}
    assert by_name['Alice Synthetic']['calculated_points'] == 20
    assert by_name['Bob Synthetic']['calculated_points'] == 0.0
    assert by_name['Cara Synthetic']['calculated_points'] == 17


def test_several_ineligible_rows_in_one_group_are_each_emitted_once(cfg):
    rows = [
        make_row('Alice Synthetic', 1, '50.00', team='Test Team A'),
        make_row('Bea Synthetic', 1, '50.00', team='Test Team B'),
        _prelims_only_final_row('Bob Synthetic', 'Test Team C'),
        _prelims_only_final_row('Cal Synthetic', 'Test Team D'),
    ]

    scored = pc.calculate_points(rows, cfg)

    assert len(scored) == 4
    for row in rows:
        assert _count_of(scored, row) == 1, row['name']
    # The two scoring swimmers tie for places 1 and 2: (20 + 17) / 2 each.
    by_name = {r['name']: r for r in scored}
    assert by_name['Alice Synthetic']['calculated_points'] == pytest.approx(18.5)
    assert by_name['Bea Synthetic']['calculated_points'] == pytest.approx(18.5)
    assert by_name['Bob Synthetic']['calculated_points'] == 0.0
    assert by_name['Cal Synthetic']['calculated_points'] == 0.0
