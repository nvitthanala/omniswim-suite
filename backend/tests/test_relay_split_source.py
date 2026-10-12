"""C5: a relay entry records where its split times came from.

The text is synthetic (see synthetic_meet_text.py). `parse_pdf` needs a PDF and
a process pool, so the fixture swaps the page reader for the synthetic text and
runs the real parser on it.
"""
import concurrent.futures

import pytest
from synthetic_meet_text import SYNTHETIC_RELAY_TEXT

import pdf_parser

LEGACY_CODE = 'relay_split_legacy_fallback'


class _FakePdf:
    pages = [object()]

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class _FakeExecutor:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def map(self, _fn, _items):
        return [SYNTHETIC_RELAY_TEXT]


@pytest.fixture
def parse_synthetic(monkeypatch):
    monkeypatch.setattr(pdf_parser.pdfplumber, 'open', lambda _path: _FakePdf())
    monkeypatch.setattr(concurrent.futures, 'ProcessPoolExecutor', _FakeExecutor)

    def run():
        by_event = {}
        for row in pdf_parser.parse_pdf('synthetic.pdf', 'auto'):
            by_event.setdefault(row['event'].split()[1], []).append(row)
        return by_event

    return run


def _codes(row):
    return [w['code'] for w in row.get('parse_warnings', [])]


def test_structured_split_parse_is_flagged_structured(parse_synthetic):
    events = parse_synthetic()
    for event_no in ('5', '6'):
        legs = events[event_no]
        assert len(legs) == 4
        assert {r['relay_split_source'] for r in legs} == {'structured'}
        assert all('parse_warnings' not in r for r in legs)
    assert [r['relay_leg_split'] for r in events['5']] == ['25.00'] * 4


def test_entry_with_no_split_lines_has_no_source(parse_synthetic):
    legs = parse_synthetic()['7']
    assert len(legs) == 4
    assert {r['relay_split_source'] for r in legs} == {None}
    assert all('parse_warnings' not in r for r in legs)


def test_builder_failure_falls_back_to_legacy_and_says_so(parse_synthetic, monkeypatch):
    def boom(*_args, **_kwargs):
        raise ValueError('forced failure')

    # The short builder serves the 4x50 entry (event 5) only.
    monkeypatch.setattr(pdf_parser, '_build_short_relay_split_payload', boom)
    events = parse_synthetic()
    legs = events['5']
    assert {r['relay_split_source'] for r in legs} == {'legacy'}
    assert all(_codes(r) == [LEGACY_CODE] for r in legs)
    # The legacy path still reads the parenthesised leg times.
    assert [r['relay_leg_split'] for r in legs] == ['25.00'] * 4
    # The 4x100 entry did not touch the failing builder.
    assert {r['relay_split_source'] for r in events['6']} == {'structured'}


def test_unexpected_error_in_payload_building_also_falls_back_to_legacy(parse_synthetic, monkeypatch):
    def boom(*_args, **_kwargs):
        raise RuntimeError('forced failure')

    monkeypatch.setattr(pdf_parser, '_build_relay_split_payload', boom)
    events = parse_synthetic()
    for event_no in ('5', '6'):
        legs = events[event_no]
        assert {r['relay_split_source'] for r in legs} == {'legacy'}
        assert all(_codes(r) == [LEGACY_CODE] for r in legs)
    # No split lines were printed for event 7, so nothing fell back there.
    assert {r['relay_split_source'] for r in events['7']} == {None}
