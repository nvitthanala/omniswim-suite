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
    else:
        assert not present
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  });

  it('warns on stderr when scoring settings are missing and keeps the D2 default', () => {
    const py = String.raw`
import os, sys
from pathlib import Path
sys.path.insert(0, 'backend')
os.environ['OMNI_DATA_DIR'] = os.path.abspath('.')
Path.is_file = lambda self: False
import point_calculator
cfg = point_calculator._resolve_scoring_settings()
assert cfg['scoringPoints'] == point_calculator.DEFAULT_NCAA_D2_SCORING
`;
    const result = require('node:child_process').spawnSync('python', ['-c', py], { cwd: root, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain('WARNING: No scoring config file found');
    expect(result.stdout).toBe('');
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
