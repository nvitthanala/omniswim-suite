"""time_to_sec: a readable clock gives seconds, anything else gives None."""
import pytest
from conftest import make_row

import point_calculator as pc


@pytest.mark.parametrize(
    ('clock', 'seconds'),
    [
        ('50.00', 50.0),
        ('1:02.50', 62.5),
        ('15:30.25', 930.25),
        ('1:02.63R', 62.63),   # a trailing qualifier letter is stripped, as before
        ('X52.10', 52.1),      # exhibition marker
        ('224.60', 224.6),     # a diving score is a number, not a clock
    ],
)
def test_readable_clock_gives_seconds(clock, seconds):
    assert pc.time_to_sec(clock) == pytest.approx(seconds)


@pytest.mark.parametrize(
    'clock',
    [None, '', '   ', 'NT', 'nt', 'DQ', 'DFS', 'SCR', 'NS', 'abc', '..', ':', '1:', ':30.00', '1:02:03.00'],
)
def test_unreadable_clock_gives_none(clock):
    assert pc.time_to_sec(clock) is None


def test_two_colon_clock_is_a_visible_absent_time_not_62_seconds(cfg):
    # "1:02:03.00" read as 62.0 before 9c87d57c, silently dropping the 03.00.
    # It now has no seconds value: the row earns no points and says why.
    rows = [
        make_row('Alice Synthetic', 1, '50.00', team='Test Team A'),
        make_row('Bob Synthetic', 2, '1:02:03.00', team='Test Team B'),
    ]
    scored = {r['name']: r for r in pc.calculate_points(rows, cfg)}
    bob = scored['Bob Synthetic']
    assert bob['calculated_points'] == 0.0
    assert [w['code'] for w in bob['parse_warnings']] == ['unreadable_time']
    assert bob['parse_warnings'][0]['value'] == '1:02:03.00'
    assert scored['Alice Synthetic']['calculated_points'] == 20


@pytest.mark.parametrize(
    ('clock', 'seconds'),
    [('25.00', 25.0), ('1:40.50', 100.5), ('7:02.10', 422.1)],
)
def test_relay_split_clock_reads_m_ss_hh(clock, seconds):
    import pdf_parser

    assert pdf_parser._relay_time_to_seconds(clock) == pytest.approx(seconds)


@pytest.mark.parametrize('clock', [None, '', 'NT', 'DQ', 'SCR', 'abc', '1:', '1:02:03.00'])
def test_relay_split_clock_gives_none_when_unreadable(clock):
    # HyTek prints a swim as m:ss.hh. A clock with two colons is a PDF artifact:
    # it used to read as 3723.0 seconds here, while time_to_sec returned None for
    # the same text.
    import pdf_parser

    assert pdf_parser._relay_time_to_seconds(clock) is None


def test_no_sentinel_number_remains_in_the_source():
    with open(pc.__file__, encoding='utf-8') as fh:
        assert '9999.99' not in fh.read()
