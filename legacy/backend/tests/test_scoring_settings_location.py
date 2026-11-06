"""The settings file resolves from the legacy layout, with no patching."""
from pathlib import Path

import point_calculator as pc

REPO_ROOT = Path(pc.__file__).resolve().parents[2]


def test_settings_found_when_data_dir_is_the_root_data_folder(monkeypatch):
    # The shell passes OMNI_DATA_DIR=<repo>/data (parsingPipeline.ts). Since the
    # legacy move that folder holds no settings file, so the lookup must fall
    # through to legacy/data/scoring_settings.json.
    monkeypatch.setenv('OMNI_DATA_DIR', str(REPO_ROOT / 'data'))
    assert not (REPO_ROOT / 'data' / 'scoring_settings.json').exists()
    assert (REPO_ROOT / 'legacy' / 'data' / 'scoring_settings.json').is_file()
    assert pc._resolve_scoring_settings()
