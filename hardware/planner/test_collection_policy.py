"""Keep native test definitions out of the subprocess-only legacy bridge.

Inspect source, never import legacy scripts: many execute at import time, write
artifacts, or exit the interpreter. This guard covers the native patterns used
here plus pytest classes and unittest.TestCase classes.
"""
import ast
from pathlib import Path

import pytest

from conftest import _NATIVE_PYTEST_FILES, collect_ignore


HERE = Path(__file__).resolve().parent
_FUNCTIONS = (ast.FunctionDef, ast.AsyncFunctionDef)


def _has_native_tests(source):
    tree = ast.parse(source)
    unittest_names = {"unittest"}
    testcase_names = set()
    for node in tree.body:
        if isinstance(node, ast.Import):
            unittest_names.update(alias.asname or alias.name for alias in node.names
                                  if alias.name == "unittest")
        elif isinstance(node, ast.ImportFrom) and node.module == "unittest":
            testcase_names.update(alias.asname or alias.name for alias in node.names
                                  if alias.name == "TestCase")

    for node in tree.body:
        if isinstance(node, _FUNCTIONS) and node.name.startswith("test_"):
            return True
        if not isinstance(node, ast.ClassDef):
            continue
        is_testcase = any(
            (isinstance(base, ast.Name) and base.id in testcase_names)
            or (isinstance(base, ast.Attribute) and base.attr == "TestCase"
                and isinstance(base.value, ast.Name) and base.value.id in unittest_names)
            for base in node.bases
        )
        if (node.name.startswith("Test") or is_testcase) and any(
                isinstance(method, _FUNCTIONS)
                and method.name.startswith("test" if is_testcase else "test_")
                for method in node.body):
            return True
    return False


def test_native_definitions_are_registered_not_inert_legacy_scripts():
    native_definitions = {
        path.name for path in HERE.glob("test_*.py")
        if _has_native_tests(path.read_text())
    }
    missing = native_definitions - _NATIVE_PYTEST_FILES
    assert not missing, f"Register native tests in conftest._NATIVE_PYTEST_FILES: {sorted(missing)}"
    ignored = {Path(path).name for path in collect_ignore}
    assert not native_definitions & ignored
    assert "test_power_gate.py" in native_definitions


@pytest.mark.parametrize("source", [
    "def test_example():\n    assert True\n",
    "async def test_example():\n    assert True\n",
    "class TestExample:\n    def test_example(self):\n        assert True\n",
    "import unittest\nclass Example(unittest.TestCase):\n    def test_example(self): pass\n",
    "import unittest as ut\nclass Example(ut.TestCase):\n    def test_example(self): pass\n",
    "from unittest import TestCase as Case\nclass Example(Case):\n    def test_example(self): pass\n",
])
def test_native_definition_patterns(source):
    assert _has_native_tests(source)


@pytest.mark.parametrize("source", [
    "assert 1 + 1 == 2\n",
    "def helper():\n    def test_nested(): pass\n",
    "class Helper:\n    def test_helper(self): pass\n",
    "class TestData:\n    value = 1\n",
])
def test_script_and_helper_patterns_are_not_native_definitions(source):
    assert not _has_native_tests(source)
