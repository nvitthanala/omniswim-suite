"""time_to_sec: a readable clock gives seconds, anything else gives None."""
import pytest

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


def test_no_sentinel_number_remains_in_the_source():
    with open(pc.__file__, encoding='utf-8') as fh:
        assert '9999.99' not in fh.read()
