"""Shared fixtures for the backend tests."""
import pytest

# A small scoring table for tests. It is a test input, not a competition rule:
# every scoring call in these tests passes it explicitly so no test depends on
# data/scoring_settings.json.
SCORING_POINTS = [20, 17, 16, 15, 14, 13, 12, 11, 9, 7, 6, 5, 4, 3, 2, 1]


@pytest.fixture
def cfg():
    return {
        'scoringPoints': list(SCORING_POINTS),
        'relayMultiplier': 2,
        'halfRateRelaySwimmer': False,
        'maxIndividualScorersPerTeam': 999,
        'maxRelaysScoringPerTeam': 999,
        'scorerCapScope': 'event',
        'aFinalBracketSize': 8,
        'scoredEventNumberMax': None,
    }


def make_row(name, rank, finals_time, *, team='Test Team A', event='Event 1 Women 100 Yard Freestyle',
             round_swam='A Final', prelims_time=None, gender='Women', **extra):
    """One parsed result row, in the shape pdf_parser emits."""
    row = {
        'name': name,
        'rank': rank,
        'team': team,
        'year': 'SR',
        'event': event,
        'gender': gender,
        'round_swam': round_swam,
        'finals_time': finals_time,
        'prelims_time': prelims_time,
        'is_relay': False,
    }
    row.update(extra)
    return row
