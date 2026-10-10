import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runPythonScript } from '../apps/shell/lib/routes/parsingPipeline';

const root = path.resolve(__dirname, '..');

describe('backend diagnostic behavior', () => {
  it('only fails rankings extraction when a mocked rankings marker is present', () => {
    const py = String.raw`
import sys, types
sys.path.insert(0, 'backend')
import parse_meet
for present in (False, True):
    module = types.SimpleNamespace(
        extract_team_rankings_from_pdf=lambda _: (_ for _ in ()).throw(ValueError('synthetic extraction failure')),
        has_team_rankings_marker_in_pdf=lambda _: present,
    )
    sys.modules['team_rankings_parser'] = module
    try:
        value = parse_meet._team_rankings('mock.pdf')
        assert value is None and not present
    except RuntimeError as exc:
        assert present and 'Team Rankings page was detected' in str(exc)
        assert exc.code == 'rankings_extraction_failed'
    else:
        assert not present
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('raises when scoring settings are missing instead of applying a D2 default', () => {
    const py = String.raw`
import os, sys
from pathlib import Path
sys.path.insert(0, 'backend')
os.environ['OMNI_DATA_DIR'] = os.path.abspath('.')
Path.is_file = lambda self: False
import point_calculator
assert not hasattr(point_calculator, 'DEFAULT_NCAA_D2_SCORING')
try:
    point_calculator._resolve_scoring_settings()
except point_calculator.ScoringSettingsMissing as exc:
    assert 'no default scoring table' in str(exc)
    print('raised')
else:
    raise AssertionError('missing settings silently produced a configuration')
try:
    point_calculator.calculate_points([{'name': 'x'}])
except point_calculator.ScoringSettingsMissing:
    print('raised')
else:
    raise AssertionError('calculate_points scored without settings')
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toEqual(['raised', 'raised']);
  });

  it('refuses explicit settings that lack a scoring table or relay multiplier', () => {
    const py = String.raw`
import sys
sys.path.insert(0, 'backend')
import point_calculator as pc
for bad in ({'relayMultiplier': 2}, {'scoringPoints': [], 'relayMultiplier': 2},
             {'scoringPoints': [9, 4, 3], 'relayMultiplier': None},
             {'scoringPoints': [9, 4, 3], 'relayMultiplier': True},
             {'scoredEventNumberMax': 42}):
    try:
        pc._resolve_scoring_settings(bad)
    except pc.ScoringSettingsMissing:
        print('raised')
    else:
        raise AssertionError('accepted incomplete settings: %r' % (bad,))
ok = pc._resolve_scoring_settings({'scoringPoints': [9, 4, 3], 'relayMultiplier': 2})
assert ok['scoringPoints'] == [9, 4, 3]
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(5);
  });

  it('layers the meet event cutoff over the settings file instead of replacing it', () => {
    const py = String.raw`
import os, sys
sys.path.insert(0, 'backend')
os.environ['OMNI_DATA_DIR'] = os.path.abspath('data')
import point_calculator as pc
import json
with open('data/scoring_settings.json', encoding='utf-8') as f:
    file_cfg = json.load(f)
cfg = pc._resolve_scoring_settings(None, {'scoredEventNumberMax': 42})
assert cfg['scoredEventNumberMax'] == 42
assert cfg['scoringPoints'] == file_cfg['scoringPoints']
assert cfg['maxIndividualScorersPerTeam'] == file_cfg['maxIndividualScorersPerTeam']
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('parse_meet hands the event cutoff over as an override, never as the whole settings', () => {
    const py = String.raw`
import sys
sys.path.insert(0, 'backend')
import types
calls = []
fake = types.SimpleNamespace(calculate_points=lambda athletes, scoring_settings=None, overrides=None: calls.append((scoring_settings, overrides)) or athletes)
sys.modules['point_calculator'] = fake
import parse_meet
parse_meet._score_athletes([], 42)
parse_meet._score_athletes([], None)
assert calls == [(None, {'scoredEventNumberMax': 42}), (None, None)], calls
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('raises on a malformed pdf_points value instead of scoring it as zero', () => {
    const py = String.raw`
import sys
sys.path.insert(0, 'backend')
import point_calculator as pc
row = {'event': 'Event 3 Women 100 Yard Freestyle', 'pdf_points': ' 12 '}
for fn in (lambda: pc._pdf_place_points_for_row(row, {}),
           lambda: pc._results_have_pdf_place_points([row]),
           lambda: pc._apply_pdf_points_overrides([row])):
    try:
        fn()
    except ValueError:
        print('raised')
    else:
        raise AssertionError('malformed pdf_points was accepted')
assert pc._pdf_place_points_for_row({'event': 'Event 3 Women 100 Yard Freestyle', 'pdf_points': 12}, {}) == 12.0
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(3);
  });

  it('parse_meet tags its error JSON with the failure code', () => {
    const py = String.raw`
import io, json, sys, types, contextlib
sys.path.insert(0, 'backend')
import parse_meet
parse_meet._extract_athletes = lambda *_: []
parse_meet._team_rankings = lambda _: (_ for _ in ()).throw(parse_meet.RankingsExtractionError('x'))
sys.argv = ['parse_meet.py', 'a.pdf']
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        parse_meet.main()
except SystemExit as e:
    assert e.code == 1
out = json.loads(buf.getvalue())
assert out['code'] == 'rankings_extraction_failed' and out['error'] == 'x', out

import point_calculator
parse_meet._team_rankings = lambda _: None
def no_settings(*a, **k):
    raise point_calculator.ScoringSettingsMissing('no settings')
point_calculator.calculate_points = no_settings
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        parse_meet.main()
except SystemExit:
    pass
out = json.loads(buf.getvalue())
assert out['code'] == 'scoring_settings_missing', out

# An untagged failure carries a null code.
parse_meet._extract_athletes = lambda *_: (_ for _ in ()).throw(ValueError('plain'))
buf = io.StringIO()
try:
    with contextlib.redirect_stdout(buf):
        parse_meet.main()
except SystemExit:
    pass
assert json.loads(buf.getvalue())['code'] is None
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('the legacy calculator CLI honours the cutoff argument and tags a settings failure', () => {
    const py = String.raw`
import io, json, os, runpy, sys
from pathlib import Path
os.environ['OMNI_DATA_DIR'] = os.path.abspath('data')
rows = [{'name': 'A B', 'team': 'Delta State University', 'event': ev, 'gender': 'Women', 'rank': '1',
         'finals_time': '1:03.53', 'prelims_time': 'NT', 'round_swam': 'A Final', 'year': 'SR'}
        for ev in ('Event 25 Women 100 Yard Breaststroke', 'Event 43 Women 100 Yard Breaststroke')]

def run_cli(argv):
    out = io.StringIO()
    sys.argv = ['point_calculator.py'] + argv
    sys.stdin = io.StringIO(json.dumps(rows))
    real, sys.stdout = sys.stdout, out
    try:
        runpy.run_path('backend/point_calculator.py', run_name='__main__')
    finally:
        sys.stdout = real
    return json.loads(out.getvalue())

no_cut = run_cli([])
cut = run_cli(['42'])
assert [r['calculated_points'] for r in no_cut] == [20, 20], no_cut
assert [r['calculated_points'] for r in cut] == [20, 0], cut

Path.is_file = lambda self: False
failed = run_cli([])
assert failed['code'] == 'scoring_settings_missing' and 'no default scoring table' in failed['error'], failed
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('the team rankings CLI reports whether a rankings page exists, and null when it cannot tell', () => {
    const py = String.raw`
import io, json, runpy, sys
def run_cli(path):
    out = io.StringIO()
    sys.argv = ['team_rankings_parser.py', path]
    real, sys.stdout = sys.stdout, out
    try:
        runpy.run_path('backend/team_rankings_parser.py', run_name='__main__')
    except SystemExit:
        pass
    finally:
        sys.stdout = real
    return json.loads(out.getvalue())
r = run_cli('does-not-exist.pdf')
assert r['markerFound'] is None and r['error'], r
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('accepts valid stdout when the Python process also writes a warning to stderr', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'omniswim-python-stderr-'));
    const script = path.join(dir, 'warning.py');
    writeFileSync(script, "import sys\nprint('\\\"ok\\\"')\nprint('WARNING: fallback applied', file=sys.stderr)\n");
    try {
      const output = await runPythonScript({ projectRoot: root, dataDir: dir }, script, []);
      expect(JSON.parse(output)).toBe('ok');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
