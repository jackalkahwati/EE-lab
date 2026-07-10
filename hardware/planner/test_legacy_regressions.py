"""Expose the legacy script-style regression suite as real pytest items."""
import os
from pathlib import Path
import subprocess
import sys

import pytest


HERE = Path(__file__).resolve().parent
NATIVE_TESTS = {"test_core_regressions.py", "test_legacy_regressions.py"}
LEGACY_SCRIPTS = sorted(
    path for path in HERE.glob("test_*.py") if path.name not in NATIVE_TESTS
)


@pytest.mark.parametrize("script", LEGACY_SCRIPTS, ids=lambda path: path.stem)
def test_legacy_script(script):
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    try:
        result = subprocess.run(
            [sys.executable, str(script)],
            cwd=str(HERE),
            env=env,
            capture_output=True,
            text=True,
            timeout=900,
        )
    except subprocess.TimeoutExpired as exc:
        pytest.fail("%s timed out after %ss\n%s\n%s" % (
            script.name, exc.timeout, exc.stdout or "", exc.stderr or ""))

    output = (result.stdout or "") + (result.stderr or "")
    assert result.returncode == 0, "%s failed with exit code %d\n%s" % (
        script.name, result.returncode, output)
