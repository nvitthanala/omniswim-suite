"""C4: a row with no readable swim time earns no place and no points.

Each scoring case below scored points before time_to_sec returned None, because
the place came from the printed rank and nothing looked at the clock.
"""
import copy

import pytest
from conftest import make_row

import point_calculator as pc


def _by_name(rows):
    return {r['name']: r for r in rows}


def _warning_codes(row):
    return [w['code'] for w in row.get('parse_warnings', [])]


def test_unparseable_clock_does_not_dilute_a_tie(cfg):
    # Same round and same printed rank form one group. The bad row used to count
    # in the group and split places 1 and 2 (20 + 17) between the two swimmers.
    rows = [
        make_row('Alice Synthetic', 1, '50.00', team='Test Team A'),
        make_row('Bob Synthetic', 1, 'abc', team='Test Team B'),
    ]
    scored = _by_name(pc.calculate_points(rows, cfg))
    assert scored['Alice Synthetic']['calculated_points'] == 20
    assert scored['Bob Synthetic']['calculated_points'] == 0.0
    assert _warning_codes(scored['Bob Synthetic']) == ['unreadable_time']
    assert scored['Bob Synthetic']['parse_warnings'][0]['reason'] == 'unparseable'
    assert 'parse_warnings' not in scored['Alice Synthetic']


def test_nt_in_a_prelims_round_scores_nothing(cfg):
    # Prelims of a distance event score, and the finals-only NT guard does not
    # apply to them.
    event = 'Event 3 Women 1650 Yard Freestyle'
    rows = [
        make_row('Alice Synthetic', 1, None, prelims_time='16:00.00', event=event,
                 round_swam='Preliminaries'),
        make_row('Bob Synthetic', 2, None, prelims_time='NT', event=event,
                 round_swam='Preliminaries', team='Test Team B'),
        make_row('Cara Synthetic', 3, None, prelims_time='16:10.00', event=event,
                 round_swam='Preliminaries', team='Test Team C'),
    ]
    scored = _by_name(pc.calculate_points(rows, cfg))
    assert scored['Alice Synthetic']['calculated_points'] == 20
    assert scored['Bob Synthetic']['calculated_points'] == 0.0
    assert scored['Cara Synthetic']['calculated_points'] == 16
    assert scored['Bob Synthetic']['parse_warnings'][0]['reason'] == 'status_code'
    assert scored['Bob Synthetic']['podium'] is None


def test_unreadable_clock_frees_its_timed_final_ladder_slot(cfg):
    # Timed-final distance: the ladder skips non-point-earning finishers. An
    # unreadable clock is one, so the next finisher takes second-place points.
    event = 'Event 3 Women 1650 Yard Freestyle'
    rows = [
        make_row('Alice Synthetic', 1, '16:00.00', event=event, round_swam='Finals'),
        make_row('Bob Synthetic', 2, 'abc', event=event, round_swam='Finals', team='Test Team B'),
        make_row('Cara Synthetic', 3, '16:20.00', event=event, round_swam='Finals', team='Test Team C'),
    ]
    scored = _by_name(pc.calculate_points(rows, cfg))
    assert scored['Alice Synthetic']['calculated_points'] == 20
    assert scored['Bob Synthetic']['calculated_points'] == 0.0
    assert scored['Cara Synthetic']['calculated_points'] == 17
    assert _warning_codes(scored['Bob Synthetic']) == ['unreadable_time']


def test_relay_with_an_unreadable_team_clock_scores_nothing(cfg):
    event = 'Event 2 Women 4x100 Yard Freestyle Relay'

    def relay(team, rank, clock):
        return [
            make_row(f'{team} leg {i}', rank, clock, team=team, event=event, is_relay=True,
                     relay_team_time=clock)
            for i in range(1, 5)
        ]

    rows = relay('Test Team A', 1, 'abc') + relay('Test Team B', 2, '3:30.00')
    scored = pc.calculate_points(rows, cfg)
    team_a = [r for r in scored if r['team'] == 'Test Team A']
    team_b = [r for r in scored if r['team'] == 'Test Team B']
    assert len(team_a) == 4
    assert all(r['calculated_points'] == 0.0 for r in team_a)
    assert all(_warning_codes(r) == ['unreadable_time'] for r in team_a)
    # Second place: 17 points x relayMultiplier 2, split over four legs.
    assert all(r['calculated_points'] == 17 * 2 / 4 for r in team_b)


def test_status_codes_and_empty_clocks_are_recorded_with_their_reason(cfg):
    rows = [
        make_row('Alice Synthetic', 1, '50.00'),
        make_row('Bob Synthetic', 2, 'NT', team='Test Team B'),
        make_row('Cara Synthetic', 3, 'DQ', team='Test Team C'),
        make_row('Dana Synthetic', 4, None, team='Test Team D'),
    ]
    scored = _by_name(pc.calculate_points(rows, cfg))
    reasons = {
        name: scored[name]['parse_warnings'][0]['reason']
        for name in ('Bob Synthetic', 'Cara Synthetic', 'Dana Synthetic')
    }
    assert reasons == {
        'Bob Synthetic': 'status_code',
        'Cara Synthetic': 'status_code',
        'Dana Synthetic': 'empty',
    }
    assert scored['Dana Synthetic']['parse_warnings'][0]['value'] is None


def test_no_row_is_dropped_or_duplicated(cfg):
    rows = [
        make_row('Alice Synthetic', 1, '50.00'),
        make_row('Bob Synthetic', 2, 'NT', team='Test Team B'),
        make_row('Cara Synthetic', 3, 'abc', team='Test Team C'),
        make_row('Dana Synthetic', 4, '52.00', team='Test Team D'),
    ]
    scored = pc.calculate_points(copy.deepcopy(rows), cfg)
    assert sorted(r['name'] for r in scored) == sorted(r['name'] for r in rows)
    by_name = _by_name(scored)
    assert by_name['Dana Synthetic']['calculated_points'] == 15
    # The printed rank is source data and is never rewritten.
    assert by_name['Bob Synthetic']['rank'] == 2


def test_warning_is_not_added_twice_when_scored_again(cfg):
    rows = [make_row('Bob Synthetic', 2, 'NT')]
    once = pc.calculate_points(rows, cfg)
    twice = pc.calculate_points(once, cfg)
    assert _warning_codes(twice[0]) == ['unreadable_time']


def test_sort_key_orders_a_missing_time_last_without_a_sentinel():
    timed = make_row('Alice Synthetic', 1, '50.00')
    untimed = make_row('Bob Synthetic', 1, 'abc')
    assert sorted([pc.get_ev_sort_key(untimed), pc.get_ev_sort_key(timed)])[0] == pc.get_ev_sort_key(timed)
    assert pc.get_ev_sort_key(untimed)[2] is True


def test_pdf_place_points_mode_keeps_printed_points_but_still_warns(cfg):
    # In this mode the meet's own points column is trusted, so the clock is never
    # consulted for scoring. The unreadable clock must still be recorded.
    cfg = {**cfg, 'usePdfPlacePoints': True}
    rows = [
        make_row('Alice Synthetic', 1, '50.00', pdf_points=20),
        make_row('Bob Synthetic', 2, 'abc', pdf_points=17, team='Test Team B'),
    ]
    scored = _by_name(pc.calculate_points(rows, cfg))
    assert scored['Alice Synthetic']['calculated_points'] == 20
    assert 'parse_warnings' not in scored['Alice Synthetic']
    assert scored['Bob Synthetic']['calculated_points'] == 17
    assert _warning_codes(scored['Bob Synthetic']) == ['unreadable_time']
    assert 'kept' in scored['Bob Synthetic']['parse_warnings'][0]['message']


def test_garbled_clock_keeps_printed_points_and_the_team_total_matches(cfg):
    # Architect ruling: the PDF's printed points are trusted in this mode, so the
    # team total must equal the meet's printed team ranking even when one clock
    # is garbled. The unreadable time is recorded, never scored from.
    cfg = {**cfg, 'usePdfPlacePoints': True}
    rows = [
        make_row('Alice Synthetic', 1, '50.00', pdf_points=20, team='Test Team A'),
        make_row('Bob Synthetic', 2, 'abc', pdf_points=17, team='Test Team A'),
        make_row('Cara Synthetic', 3, '52.00', pdf_points=16, team='Test Team B'),
    ]
    printed_team_totals = {'Test Team A': 37, 'Test Team B': 16}  # synthetic ranking
    scored = pc.calculate_points(rows, cfg)
    totals = {}
    for r in scored:
        totals[r['team']] = totals.get(r['team'], 0) + r['calculated_points']
    assert totals == printed_team_totals
    assert _by_name(scored)['Bob Synthetic']['calculated_points'] == 17
    assert pc.time_to_sec(_by_name(scored)['Bob Synthetic']['finals_time']) is None


@pytest.mark.parametrize('clock', ['DQ', 'NT', 'NS', 'SCR', 'DNF', 'dq'])
def test_status_clock_with_printed_points_raises(cfg, clock):
    cfg = {**cfg, 'usePdfPlacePoints': True}
    rows = [
        make_row('Alice Synthetic', 1, '50.00', pdf_points=20),
        make_row('Bob Synthetic', 2, clock, pdf_points=17, team='Test Team B'),
    ]
    with pytest.raises(pc.PointsOnStatusClock) as exc:
        pc.calculate_points(rows, cfg)
    assert exc.value.code == 'points_on_status_clock'
    assert exc.value.total == 1
    assert 'Bob Synthetic' in str(exc.value)
    assert 'row 1' in exc.value.rows[0]


def test_status_clock_with_zero_or_no_points_does_not_raise(cfg):
    cfg = {**cfg, 'usePdfPlacePoints': True}
    rows = [
        make_row('Alice Synthetic', 1, '50.00', pdf_points=20),
        make_row('Bob Synthetic', 2, 'DQ', pdf_points=0, team='Test Team B'),
        make_row('Cara Synthetic', 3, 'NT', pdf_points=None, team='Test Team C'),
    ]
    scored = _by_name(pc.calculate_points(rows, cfg))
    assert scored['Bob Synthetic']['calculated_points'] == 0.0
    assert scored['Cara Synthetic']['calculated_points'] == 0.0


def test_status_clock_check_applies_only_in_pdf_points_mode(cfg):
    # Calculated mode ignores pdf_points, so the printed value cannot be trusted
    # and is not checked: the row simply earns nothing for its status clock.
    cfg = {**cfg, 'usePdfPlacePoints': False}
    rows = [make_row('Bob Synthetic', 1, 'DQ', pdf_points=17)]
    assert pc.calculate_points(rows, cfg)[0]['calculated_points'] == 0.0
