"""Pytest collection policy for the planner's legacy script regressions.

Most historical ``test_*.py`` files execute immediately and call ``sys.exit``;
importing them directly makes pytest abort during collection.  The native
pytest bridge runs those scripts in isolated subprocesses instead.
"""
from pathlib import Path


_NATIVE_PYTEST_FILES = {"test_core_regressions.py", "test_legacy_regressions.py",
                        "test_design_gate.py", "test_silk_polarity.py",
                        "test_footprint_family.py"}
collect_ignore = [
    str(path)
    for path in Path(__file__).parent.glob("test_*.py")
    if path.name not in _NATIVE_PYTEST_FILES
]
