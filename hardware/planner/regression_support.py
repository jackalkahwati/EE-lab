"""Test-owned source snapshots for trusted legacy regressions.

This is a fail-closed Python harness, not an OS sandbox for hostile code/native
extensions. Only copied Python entrypoints may spawn; arbitrary tools, networking,
and writes outside the snapshot fail until separately provisioned. Never copy a
checkout wholesale or manufacture historical reports to satisfy assertions.
"""
from contextlib import contextmanager
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import secrets
import shutil
import signal
import stat
import subprocess
import sys
import tempfile


MARKER = ".regression-snapshot.json"
ROOT_ENV = "EE_LAB_REGRESSION_ROOT"
TOKEN_ENV = "EE_LAB_REGRESSION_TOKEN"
LIBRARY_ENV_KEYS = frozenset({"FL_KICAD_SYMBOLS", "FL_KICAD_FOOTPRINTS", "FL_KICAD_3DMODELS"})
SOURCE_TREES = (
    "hardware/planner", "hardware/blocks",
    "software/prompt-to-pcb-ui/scripts", "tools",
)
# Reviewed input catalogs, not generated run evidence. Copies are independently
# mutable: pattern build/ingest must never write the checkout catalogs.
INPUT_FILES = frozenset({
    "hardware/planner/datasheet_db_v2.json",
    "hardware/planner/design_rules.json",
    "hardware/planner/design_rules_auto.json",
    "hardware/planner/references/manifest.json",
    "hardware/blocks/parts_cache.json",
})
INPUT_DIRS = frozenset({
    "hardware/planner/patterns", "hardware/planner/library", "hardware/blocks/routes",
})
CANDIDATE_REPAIRS = (
    "hardware/planner/regression_support.py",
    "hardware/planner/test_regression_support.py",
    "hardware/planner/report_regression_fixtures.py",
)


def source_allowed(relative):
    """Narrow path policy, applied to tracked files AND explicit candidates."""
    p = PurePosixPath(relative)
    if p.is_absolute() or ".." in p.parts or not p.parts:
        return False
    if any(part.startswith(".") or part.lower() in {
        "runs", "private", "credentials", "node_modules", "__pycache__",
    } or any(word in part.lower() for word in ("credential", "secret", "token"))
           for part in p.parts):
        return False
    if p.suffix == ".py" and any(
        p.is_relative_to(PurePosixPath(tree)) for tree in SOURCE_TREES
    ):
        return True
    return str(p) in INPUT_FILES or (str(p.parent) in INPUT_DIRS and p.suffix == ".json")


def _regular_source(root, relative):
    p = root
    for part in PurePosixPath(relative).parts:
        p = p / part
        mode = p.lstat().st_mode
        if stat.S_ISLNK(mode):
            raise ValueError("Snapshot source must not be a symlink: %s" % relative)
    if not stat.S_ISREG(p.stat().st_mode):
        raise ValueError("Snapshot source must be a regular file: %s" % relative)
    return p


def tracked_sources(repo_root):
    """Use the index only as a provenance list; copy current candidate contents."""
    result = subprocess.run(
        ["git", "-C", str(repo_root), "ls-files", "-z"],
        check=True, capture_output=True,
        env={"PATH": os.defpath, "HOME": str(repo_root), "GIT_CONFIG_NOSYSTEM": "1",
             "GIT_CONFIG_GLOBAL": os.devnull},
    )
    return tuple(sorted(n for n in result.stdout.decode().split("\0") if source_allowed(n)))


def approved_library_roots(values, repo_root):
    """Explicit immutable KiCad libraries only, never ambient provider paths."""
    result = {}
    for key, value in values.items():
        if key not in LIBRARY_ENV_KEYS:
            raise ValueError("Unsupported library environment key: %s" % key)
        lexical = Path(os.path.abspath(value))
        path = lexical.resolve()
        for candidate in (lexical, path):
            if candidate == Path.home() or candidate == Path(candidate.anchor) or any(
                part.lower() in {"runs", ".ssh", ".aws", ".config", "credentials"}
                for part in candidate.parts
            ) or candidate.is_relative_to(Path(repo_root).resolve()):
                raise ValueError("Not an external immutable library root: %s" % value)
        if not path.is_dir():
            raise ValueError("Library root is not a directory: %s" % value)
        result[key] = str(path)
    return result


def sanitized_environment(root, token, library_roots=None):
    """Construct from scratch, never forward provider/auth/proxy/user config."""
    root = Path(root).resolve()
    return {
        "PATH": os.defpath,
        "HOME": str(root / ".home"),
        "USERPROFILE": str(root / ".home"),
        "TMPDIR": str(root / ".tmp"), "TMP": str(root / ".tmp"),
        "TEMP": str(root / ".tmp"),
        "XDG_CONFIG_HOME": str(root / ".home/config"),
        "XDG_CACHE_HOME": str(root / ".home/cache"),
        "XDG_DATA_HOME": str(root / ".home/data"),
        "PYTHONPATH": os.pathsep.join((str(root / ".guard"), str(root / "hardware/planner"))),
        "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
        "PYTHONUNBUFFERED": "1", "PYTHONHASHSEED": "0",
        "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8", "TZ": "UTC",
        "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
        "AWS_EC2_METADATA_DISABLED": "true",
        ROOT_ENV: str(root), TOKEN_ENV: token,
        **(library_roots or {}),
    }


def require_snapshot():
    """Reject real-checkout invocation, even with a forged environment flag."""
    actual = Path(__file__).resolve().parents[2]
    advertised = os.environ.get(ROOT_ENV)
    token = os.environ.get(TOKEN_ENV)
    if not advertised or not token or Path(advertised).resolve() != actual:
        raise RuntimeError("Regression producer requires a test-owned source snapshot")
    marker = actual / MARKER
    if marker.is_symlink() or not marker.is_file() or (actual / ".git").exists():
        raise RuntimeError("Regression snapshot marker missing or invalid")
    record = json.loads(marker.read_text())
    if record.get("root") != str(actual) or record.get("token") != token:
        raise RuntimeError("Regression snapshot marker/root mismatch")
    return actual


def install_runtime_guard():
    """Inherited via sitecustomize by Python children; fail closed on bypasses.

    Hard-coded /tmp writes (e.g. M3A) intentionally fail rather than touch shared
    paths. Native binaries need a separately approved OS isolation/tool policy.
    """
    root = require_snapshot()
    record = json.loads((root / MARKER).read_text())
    original = Path(record["source_root"])
    library_roots = record.get("library_roots", {})
    read_roots = [root] + [Path(p) for p in record["runtime_roots"]] + [
        Path(p) for p in library_roots.values()
    ]
    environment = sanitized_environment(root, os.environ[TOKEN_ENV], library_roots)
    # macOS can inject __CF_USER_TEXT_ENCODING during interpreter startup.
    # Remove additions rather than widening the inherited environment policy.
    os.environ.clear()
    os.environ.update(environment)
    interpreter = Path(sys.executable).resolve()

    def inside(path, base=root):
        if isinstance(path, int) or path is None:
            return True
        return Path(os.fsdecode(path)).resolve().is_relative_to(base)

    def writable(path):
        if not inside(path):
            raise PermissionError("Regression write outside snapshot: %s" % path)

    def readable(path):
        if isinstance(path, int) or path is None:
            return
        lexical = Path(os.path.abspath(os.fsdecode(path)))
        if lexical.is_relative_to(original) and not lexical.is_relative_to(root):
            raise PermissionError("Regression read from original checkout: %s" % path)
        if lexical == Path(os.devnull):
            return
        if not any(inside(path, base) for base in read_roots):
            raise PermissionError("Regression read outside approved roots: %s" % path)

    def audit(event, args):
        if event == "open":
            path, mode, flags = args
            if isinstance(path, int):
                return
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if writing:
                writable(path)
            else:
                readable(path)
        elif event in {"os.listdir", "os.scandir"}:
            readable(args[0] if args else os.getcwd())
        elif event in {"os.remove", "os.rmdir", "os.mkdir", "os.chmod", "os.chown", "os.utime", "os.truncate"}:
            writable(args[0])
        elif event in {"os.rename", "os.link"}:
            writable(args[0]); writable(args[1])
        elif event == "os.symlink":
            raise PermissionError("Regression symlink creation is not allowed")
        elif event.startswith("socket.") or event in {"os.system", "os.posix_spawn", "os.fork", "os.forkpty", "os.exec"}:
            raise PermissionError("Regression external execution/network blocked: %s" % event)
        elif event == "subprocess.Popen":
            executable, argv, cwd, env = args
            if Path(executable).resolve() != interpreter or not isinstance(argv, (tuple, list)):
                raise PermissionError("Regression child must use the guarded Python interpreter")
            # No -c/-m/-I/-E/-S, shell, or alternate site startup. Children run
            # actual copied scripts with the same guard and source imports.
            if len(argv) < 2 or str(argv[1]).startswith("-") or not inside(argv[1]):
                raise PermissionError("Regression child must execute a copied Python script")
            if Path(argv[1]).suffix != ".py" or (cwd is not None and not inside(cwd)):
                raise PermissionError("Regression child path is outside the snapshot")
            child_env = os.environ if env is None else env
            if dict(child_env) != environment:
                raise PermissionError("Regression child environment must remain sanitized")

    sys.addaudithook(audit)


@dataclass
class RegressionSnapshot:
    root: Path
    env: dict
    copied_files: tuple

    @property
    def planner(self):
        return self.root / "hardware/planner"

    def run_legacy(self, script_name, timeout=900):
        """Execute the copied entrypoint, not a real script with a temporary cwd."""
        if Path(script_name).name != str(script_name):
            raise ValueError("Expected a planner script basename")
        script = self.planner / script_name
        if script.is_symlink() or not script.is_file():
            raise ValueError("Script is not a copied regular source: %s" % script_name)
        process = subprocess.Popen(
            [sys.executable, str(script)], cwd=str(self.planner), env=self.env,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
            start_new_session=True,
        )
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            stdout, stderr = process.communicate()
            raise subprocess.TimeoutExpired(process.args, timeout, stdout, stderr)
        finally:
            # A timed-out/crashed parent must not leave grandchildren using a
            # snapshot after its context exits. The process owns its session.
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        return subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)


@contextmanager
def regression_snapshot(repo_root, candidate_files=(), max_bytes=32 * 1024 * 1024,
                        library_roots=None):
    """Copy allowlisted tracked sources plus explicitly named candidate repairs.

    Deleted tracked inputs, symlinks, unapproved candidate files, and size limit
    overruns fail honestly. Never consult/copy public/runs, even if tracked.
    """
    repo_root = Path(repo_root).resolve()
    libraries = approved_library_roots(library_roots or {}, repo_root)
    # Python runtime/package directories, not arbitrary inherited PYTHONPATH.
    import sysconfig
    runtime_roots = sorted({str(Path(sysconfig.get_path(name)).resolve())
                            for name in ("stdlib", "platstdlib", "purelib", "platlib")})
    tracked = set(tracked_sources(repo_root))
    candidates = {str(p) for p in candidate_files}
    for path in candidates:
        if not source_allowed(path) or PurePosixPath(path).suffix != ".py":
            raise ValueError("Unapproved candidate source: %s" % path)
    paths = sorted(tracked | candidates)
    with tempfile.TemporaryDirectory(prefix="ee-lab-regression-") as temporary:
        root = Path(temporary).resolve() / "repo"
        root.mkdir()
        total = 0
        for relative in paths:
            source = _regular_source(repo_root, relative)
            total += source.stat().st_size
            if total > max_bytes:
                raise ValueError("Regression source snapshot exceeds byte limit")
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
        token = secrets.token_hex(24)
        (root / MARKER).write_text(json.dumps({
            "root": str(root), "source_root": str(repo_root), "token": token,
            "files": paths, "copied_bytes": total,
            "runtime_roots": runtime_roots, "library_roots": libraries,
        }))
        for directory in (".guard", ".tmp", ".home/config", ".home/cache", ".home/data"):
            (root / directory).mkdir(parents=True, exist_ok=True)
        # sitecustomize import failures normally only print a warning and carry
        # on. Terminate explicitly so a missing guard can NEVER run the script.
        (root / ".guard/sitecustomize.py").write_text(
            "import os, traceback\ntry:\n"
            "    from regression_support import install_runtime_guard\n"
            "    install_runtime_guard()\nexcept BaseException:\n"
            "    traceback.print_exc()\n    os._exit(125)\n"
        )
        yield RegressionSnapshot(root, sanitized_environment(root, token, libraries), tuple(paths))
