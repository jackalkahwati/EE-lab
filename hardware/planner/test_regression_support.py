"""Boundary tests only. Safe standalone invocation (does not collect legacy tests):

PYTEST_DISABLE_PLUGIN_AUTOLOAD=1 python3 -m pytest --noconftest -p no:cacheprovider \
    hardware/planner/test_regression_support.py
"""
import ast
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

from regression_support import (
    MARKER, ROOT_ENV, TOKEN_ENV, regression_snapshot, require_snapshot,
    sanitized_environment, source_allowed,
)


@pytest.fixture
def source_repo(tmp_path):
    root = tmp_path / "source"
    planner = root / "hardware/planner"
    planner.mkdir(parents=True)
    shutil.copyfile(Path(__file__).with_name("regression_support.py"), planner / "regression_support.py")
    (planner / "patterns").mkdir()
    (planner / "patterns/example.json").write_text('{"original": true}')
    (planner / "datasheet_db_v2.json").write_text('{"records": []}')
    (planner / "test_probe.py").write_text("from regression_support import require_snapshot\nprint(require_snapshot())\n")
    # Deliberately tracked forbidden paths must not sneak into the snapshot.
    for relative in ("software/prompt-to-pcb-ui/public/runs/private/data/report.json",
                     "hardware/planner/.env", "hardware/planner/credentials.py",
                     "hardware/planner/unapproved-output.json"):
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("PRIVATE_SENTINEL")
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    # Untracked source is absent unless explicitly named by the test owner.
    (planner / "local_only.py").write_text("LOCAL_SENTINEL = True\n")
    return root


def test_excludes_private_runs_credentials_and_untracked_files(source_repo):
    with regression_snapshot(source_repo) as snapshot:
        assert (snapshot.planner / "test_probe.py").is_file()
        assert not (snapshot.root / "software/prompt-to-pcb-ui/public/runs").exists()
        for name in (".env", "credentials.py", "local_only.py", "unapproved-output.json"):
            assert not (snapshot.planner / name).exists()
        assert all("PRIVATE_SENTINEL" not in (snapshot.root / n).read_text()
                   for n in snapshot.copied_files)


def test_candidate_sources_are_explicit_and_allowlisted(source_repo):
    with regression_snapshot(source_repo, candidate_files=("hardware/planner/local_only.py",)) as snapshot:
        assert (snapshot.planner / "local_only.py").read_text() == "LOCAL_SENTINEL = True\n"
    for forbidden in ("../escape.py", "hardware/planner/.env", "hardware/planner/credentials.py",
                      "software/prompt-to-pcb-ui/public/runs/private/source.py",
                      "hardware/planner/unapproved-output.json"):
        with pytest.raises(ValueError, match="Unapproved"):
            with regression_snapshot(source_repo, candidate_files=(forbidden,)):
                pytest.fail("Forbidden candidate copied")


def test_symlink_sources_and_symlink_parents_are_rejected(source_repo, tmp_path):
    planner = source_repo / "hardware/planner"
    secret = tmp_path / "outside.py"
    secret.write_text("PRIVATE_SENTINEL")
    (planner / "linked.py").symlink_to(secret)
    # Untracked symlink ignored; explicitly named or tracked symlink rejected.
    with regression_snapshot(source_repo) as snapshot:
        assert not (snapshot.planner / "linked.py").exists()
    with pytest.raises(ValueError, match="symlink"):
        with regression_snapshot(source_repo, candidate_files=("hardware/planner/linked.py",)):
            pytest.fail("Symlink copied")
    subprocess.run(["git", "-C", str(source_repo), "add", "hardware/planner/linked.py"], check=True)
    with pytest.raises(ValueError, match="symlink"):
        with regression_snapshot(source_repo):
            pytest.fail("Tracked symlink copied")
    subprocess.run(["git", "-C", str(source_repo), "rm", "--cached", "hardware/planner/linked.py"], check=True, capture_output=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "module.py").write_text("PRIVATE_SENTINEL")
    (planner / "linked_directory").symlink_to(outside, target_is_directory=True)
    with pytest.raises(ValueError, match="symlink"):
        with regression_snapshot(source_repo, candidate_files=("hardware/planner/linked_directory/module.py",)):
            pytest.fail("Symlink parent copied")


def test_snapshot_cleanup_on_success_failure_and_size_limit(source_repo, monkeypatch, tmp_path):
    import regression_support
    made = []
    original = regression_support.tempfile.TemporaryDirectory

    def recording_temporary_directory(*args, **kwargs):
        context = original(*args, dir=tmp_path, **kwargs)
        made.append(Path(context.name))
        return context

    monkeypatch.setattr(regression_support.tempfile, "TemporaryDirectory", recording_temporary_directory)
    with regression_snapshot(source_repo) as snapshot:
        assert snapshot.root.is_dir()
    assert not snapshot.root.exists()
    with pytest.raises(RuntimeError, match="intentional"):
        with regression_snapshot(source_repo):
            raise RuntimeError("intentional")
    with pytest.raises(ValueError, match="byte limit"):
        with regression_snapshot(source_repo, max_bytes=1):
            pytest.fail("Oversized snapshot copied")
    assert len(made) == 3
    assert all(not path.exists() for path in made)


def test_environment_is_allowlisted_not_inherited(tmp_path, monkeypatch):
    for name in ("OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_PROFILE",
                 "GOOGLE_APPLICATION_CREDENTIALS", "GITHUB_TOKEN", "HTTPS_PROXY",
                 "SSH_AUTH_SOCK", "PYTHONSTARTUP", "CLAUDE_CLI_PATH", "LD_PRELOAD"):
        monkeypatch.setenv(name, "PRIVATE_SENTINEL")
    env = sanitized_environment(tmp_path, "test-token")
    assert "PRIVATE_SENTINEL" not in str(env)
    assert env["HOME"] == str(tmp_path / ".home")
    assert env["TMPDIR"] == str(tmp_path / ".tmp")
    assert env["PYTHONNOUSERSITE"] == "1"
    assert env[ROOT_ENV] == str(tmp_path)
    assert env["PATH"] == os.defpath


def test_copied_paths_and_mutable_catalogs_are_independent(source_repo):
    script = source_repo / "hardware/planner/test_probe.py"
    script.write_text('''from pathlib import Path
from regression_support import require_snapshot
root = require_snapshot()
p = Path(__file__).resolve().parent
assert root in p.parents
assert Path.cwd() == p
(p / "patterns/example.json").write_text('{"changed": true}')
(p / "datasheet_db_v2.json").write_text('{"records": ["test"]}')
print(__file__)
''')
    with regression_snapshot(source_repo) as first:
        result = first.run_legacy("test_probe.py")
        assert result.returncode == 0, result.stderr
        assert str(first.planner / "test_probe.py") in result.stdout
        assert str(source_repo) not in result.stdout
        with regression_snapshot(source_repo) as second:
            assert second.root != first.root
            assert (second.planner / "patterns/example.json").read_text() == '{"original": true}'
    assert (source_repo / "hardware/planner/patterns/example.json").read_text() == '{"original": true}'
    assert (source_repo / "hardware/planner/datasheet_db_v2.json").read_text() == '{"records": []}'


def test_require_snapshot_refuses_direct_checkout_even_with_environment(monkeypatch):
    actual = Path(__file__).resolve().parents[2]
    monkeypatch.delenv(ROOT_ENV, raising=False)
    monkeypatch.delenv(TOKEN_ENV, raising=False)
    with pytest.raises(RuntimeError, match="test-owned"):
        require_snapshot()
    monkeypatch.setenv(ROOT_ENV, str(actual))
    monkeypatch.setenv(TOKEN_ENV, "forged")
    with pytest.raises(RuntimeError, match="marker"):
        require_snapshot()


def test_marker_mismatch_and_missing_guard_fail_before_script(source_repo):
    with regression_snapshot(source_repo) as snapshot:
        marker = snapshot.root / MARKER
        data = json.loads(marker.read_text())
        data["root"] = str(source_repo)
        marker.write_text(json.dumps(data))
        result = snapshot.run_legacy("test_probe.py")
        assert result.returncode == 125
        assert "marker/root mismatch" in result.stderr
        assert result.stdout == ""
    with regression_snapshot(source_repo) as snapshot:
        (snapshot.planner / "regression_support.py").unlink()
        result = snapshot.run_legacy("test_probe.py")
        assert result.returncode == 125
        assert result.stdout == ""


def test_nested_python_uses_snapshot_and_sanitized_environment(source_repo, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "PRIVATE_SENTINEL")
    planner = source_repo / "hardware/planner"
    (planner / "child.py").write_text('''import os
from pathlib import Path
from regression_support import require_snapshot
r = require_snapshot()
assert "ANTHROPIC_API_KEY" not in os.environ
assert Path(os.environ["HOME"]).is_relative_to(r)
assert Path.cwd().is_relative_to(r)
(Path(__file__).parent / "patterns/example.json").write_text("child mutation")
print(__file__)
''')
    (planner / "test_probe.py").write_text('''import subprocess, sys
from pathlib import Path
r = subprocess.run([sys.executable, str(Path(__file__).with_name("child.py"))], capture_output=True, text=True)
print(r.stdout, end="")
print(r.stderr, end="", file=sys.stderr)
sys.exit(r.returncode)
''')
    with regression_snapshot(source_repo, candidate_files=("hardware/planner/child.py",)) as snapshot:
        result = snapshot.run_legacy("test_probe.py")
        assert result.returncode == 0, result.stderr
        assert str(snapshot.planner / "child.py") in result.stdout
        assert (snapshot.planner / "patterns/example.json").read_text() == "child mutation"
    assert (planner / "patterns/example.json").read_text() == '{"original": true}'


@pytest.mark.parametrize("operation", [
    "Path(outside).write_text('overwrite')",
    "Path(original).read_text()",
    "Path(outside).read_text()",
    "subprocess.run(['/bin/sh', '-c', 'true'])",
    "subprocess.run([sys.executable, '-S', str(Path(__file__))])",
    "subprocess.run([sys.executable, str(Path(__file__))], env={})",
    "socket.socket()",
    "os.symlink(outside, Path(__file__).with_name('escape'))",
])
def test_runtime_guard_blocks_escape_and_provider_execution(source_repo, tmp_path, operation):
    outside = tmp_path / "outside.txt"
    outside.write_text("unchanged")
    original = source_repo / "hardware/planner/patterns/example.json"
    script = source_repo / "hardware/planner/test_probe.py"
    script.write_text("import os, socket, subprocess, sys\nfrom pathlib import Path\n" +
                      "outside = %r\noriginal = %r\n" % (str(outside), str(original)) + operation + "\n")
    with regression_snapshot(source_repo) as snapshot:
        result = snapshot.run_legacy("test_probe.py")
        assert result.returncode != 0
        assert "PermissionError" in result.stderr, result.stderr
    assert outside.read_text() == "unchanged"
    assert original.read_text() == '{"original": true}'


def test_original_run_symlink_and_external_target_are_unreadable(source_repo, tmp_path):
    outside = tmp_path / "private-history"
    outside.mkdir()
    (outside / "data.json").write_text("PRIVATE_SENTINEL")
    link = source_repo / "software/prompt-to-pcb-ui/public/runs"
    shutil.rmtree(link)
    link.symlink_to(outside, target_is_directory=True)
    for path in (link / "data.json", outside / "data.json"):
        (source_repo / "hardware/planner/test_probe.py").write_text(
            "from pathlib import Path\nprint(Path(%r).read_text())\n" % str(path))
        with regression_snapshot(source_repo) as snapshot:
            result = snapshot.run_legacy("test_probe.py")
            assert result.returncode != 0
            assert "PermissionError" in result.stderr
            assert "PRIVATE_SENTINEL" not in result.stdout


def test_explicit_library_roots_are_read_only_and_inherited(source_repo, tmp_path):
    library = tmp_path / "kicad-symbols"
    library.mkdir()
    symbol = library / "known.kicad_sym"
    symbol.write_text("immutable symbol")
    script = source_repo / "hardware/planner/test_probe.py"
    script.write_text('''import os, subprocess, sys
from pathlib import Path
p = Path(os.environ["FL_KICAD_SYMBOLS"]) / "known.kicad_sym"
assert p.read_text() == "immutable symbol"
try:
    p.write_text("changed")
except PermissionError:
    pass
else:
    raise AssertionError("external library was writable")
if len(sys.argv) == 1:
    subprocess.run([sys.executable, __file__, "child"], check=True)
''')
    with regression_snapshot(source_repo, library_roots={"FL_KICAD_SYMBOLS": library}) as snapshot:
        result = snapshot.run_legacy("test_probe.py")
        assert result.returncode == 0, result.stderr
    assert symbol.read_text() == "immutable symbol"
    for values in ({"ANTHROPIC_API_KEY": library}, {"FL_KICAD_SYMBOLS": source_repo},
                   {"FL_KICAD_SYMBOLS": source_repo / "software/prompt-to-pcb-ui/public/runs"}):
        with pytest.raises(ValueError):
            with regression_snapshot(source_repo, library_roots=values):
                pytest.fail("Invalid library accepted")


def test_timeout_reaps_parent_and_cleans_snapshot(source_repo):
    script = source_repo / "hardware/planner/test_probe.py"
    script.write_text("import time\ntime.sleep(30)\n")
    with pytest.raises(subprocess.TimeoutExpired):
        with regression_snapshot(source_repo) as snapshot:
            snapshot.run_legacy("test_probe.py", timeout=0.2)
    assert not snapshot.root.exists()


def test_manifest_covers_every_legacy_assertion_without_importing_scripts():
    planner = Path(__file__).resolve().parent
    manifest = json.loads((planner / "legacy_regression_manifest.json").read_text())
    registry = ast.parse((planner / "conftest.py").read_text())
    native = next(ast.literal_eval(n.value) for n in registry.body
                  if isinstance(n, ast.Assign) and any(
                      isinstance(t, ast.Name) and t.id == "_NATIVE_PYTEST_FILES" for t in n.targets))
    assert set(manifest["scope"]["native_files"]) == native
    actual = {p.name for p in planner.glob("test_*.py") if p.name not in native}
    assert {Path(s["path"]).name for s in manifest["scripts"]} == actual
    count = 0
    for script in manifest["scripts"]:
        source = (planner / Path(script["path"]).name).read_text()
        assert hashlib.sha256(source.encode()).hexdigest() == script["sha256"], script["path"]
        tree = ast.parse(source)
        # Legacy suite currently implements assertion sites through check();
        # fail if a future script adds another mechanism not yet inventoried.
        assert not any(isinstance(n, ast.Assert) for n in ast.walk(tree)), script["path"]
        sites = sorted((n for n in ast.walk(tree) if isinstance(n, ast.Call)
                        and isinstance(n.func, ast.Name) and n.func.id == "check"),
                       key=lambda n: n.lineno)
        # ast.unparse formatting varies across Python versions (notably tuple
        # targets in comprehensions). Compare syntax trees, not printer output.
        def expression_tree(text):
            return ast.dump(ast.parse(text, mode="eval"), include_attributes=False)

        expected = [(n.lineno, expression_tree(ast.unparse(n.args[0])),
                     expression_tree(ast.unparse(n.args[1]))) for n in sites]
        recorded = [(a["line"], expression_tree(a["label"]),
                     expression_tree(a["predicate"])) for a in script["assertions"]]
        assert recorded == expected, script["path"]
        assert script["static_check_sites"] == len(sites)
        count += len(sites)
    assert count == manifest["totals"]["static_check_sites"]
    assert len(actual) == manifest["totals"]["legacy_scripts"]


def test_missing_historical_artifact_fails_without_seeding(source_repo):
    script = source_repo / "hardware/planner/test_probe.py"
    script.write_text('''from regression_support import require_snapshot
r = require_snapshot()
(r / "software/prompt-to-pcb-ui/public/runs/private/data/report.json").read_text()
''')
    with regression_snapshot(source_repo) as snapshot:
        result = snapshot.run_legacy("test_probe.py")
        assert result.returncode != 0
        assert "FileNotFoundError" in result.stderr
        assert not (snapshot.root / "software/prompt-to-pcb-ui/public/runs").exists()
