"""Expose every legacy script as a pytest item in a test-owned source snapshot."""
import os
from pathlib import Path
import subprocess

import pytest

from regression_support import CANDIDATE_REPAIRS, LIBRARY_ENV_KEYS, regression_snapshot

HERE = Path(__file__).resolve().parent
# Keep the collector's native registry authoritative. Never run pytest-style
# modules as scripts: a zero exit code would silently lose their assertions.
from conftest import _NATIVE_PYTEST_FILES as NATIVE_TESTS
LEGACY_SCRIPTS = sorted(
    path for path in HERE.glob("test_*.py") if path.name not in NATIVE_TESTS
)


@pytest.mark.parametrize("script", LEGACY_SCRIPTS, ids=lambda path: path.stem)
def test_legacy_script(script):
    repo_root = HERE.parents[1]
    candidates = tuple(path for path in CANDIDATE_REPAIRS if (repo_root / path).is_file())
    # Explicit CI/toolchain library paths are validated as immutable external
    # roots. No other caller environment, credentials, or provider CLI survives.
    libraries = {key: os.environ[key] for key in LIBRARY_ENV_KEYS if os.environ.get(key)}
    try:
        with regression_snapshot(repo_root, candidate_files=candidates,
                                 library_roots=libraries) as snapshot:
            result = snapshot.run_legacy(script.name, timeout=900)
    except subprocess.TimeoutExpired as exc:
        pytest.fail("%s timed out after %ss\n%s\n%s" % (
            script.name, exc.timeout, exc.stdout or "", exc.stderr or ""))

    output = (result.stdout or "") + (result.stderr or "")
    assert result.returncode == 0, "%s failed with exit code %d\n%s" % (
        script.name, result.returncode, output)
