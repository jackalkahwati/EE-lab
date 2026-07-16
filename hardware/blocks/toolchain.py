"""Toolchain path resolver — single source of truth for external binaries and
KiCad shared libraries (Python side).

Every path resolves to the current macOS install location by DEFAULT (so the
Mac keeps working with nothing set) and to an environment-variable override when
one is present (so a Linux/cloud container becomes possible just by setting the
env vars). No behavior changes on the Mac.

Env names (mirror lib/toolchain.ts + scripts/toolchain.py exactly):
  FL_KICAD_CLI · FL_KICAD_PYTHON · FL_KICAD_FOOTPRINTS · FL_KICAD_SYMBOLS
  FL_KICAD_3DMODELS · CLAUDE_CLI_PATH · FL_FFMPEG

This file is the canonical copy. software/prompt-to-pcb-ui/scripts/toolchain.py
is a byte-identical mirror; other pipeline dirs import THIS module by adding
hardware/blocks to sys.path. Keep the two copies in sync.
"""
import os
import shutil

_KICAD_APP = "/Applications/KiCad/KiCad.app/Contents"


def kicad_cli():
    """kicad-cli binary (pcb drc / export / render)."""
    # FL_KICAD_CLI is the standardized name; KICAD_CLI is honored as a legacy
    # alias so an existing override keeps working (neither is set on the Mac).
    return (os.environ.get("FL_KICAD_CLI")
            or os.environ.get("KICAD_CLI")
            or _KICAD_APP + "/MacOS/kicad-cli")


def kicad_python():
    """KiCad's bundled python3 (pcbnew + jsonschema for pipeline scripts)."""
    return (os.environ.get("FL_KICAD_PYTHON")
            or _KICAD_APP
            + "/Frameworks/Python.framework/Versions/Current/bin/python3")


def kicad_footprints():
    """KiCad shared footprint libraries (.pretty dirs)."""
    return (os.environ.get("FL_KICAD_FOOTPRINTS")
            or _KICAD_APP + "/SharedSupport/footprints")


def kicad_symbols():
    """KiCad shared symbol libraries (.kicad_sym)."""
    return (os.environ.get("FL_KICAD_SYMBOLS")
            or _KICAD_APP + "/SharedSupport/symbols")


def kicad_3dmodels():
    """KiCad shared 3D models (.wrl/.step)."""
    return (os.environ.get("FL_KICAD_3DMODELS")
            or _KICAD_APP + "/SharedSupport/3dmodels")


def claude_bin():
    """Claude Code CLI binary. Explicit CLAUDE_CLI_PATH wins; otherwise the
    first existing common install location; otherwise a bare `claude` so a
    Linux box with claude on PATH just works."""
    p = os.environ.get("CLAUDE_CLI_PATH")
    if p:
        return p
    home = os.environ.get("HOME", "")
    for cand in (home + "/.local/bin/claude", "/opt/homebrew/bin/claude",
                 "/usr/local/bin/claude"):
        if os.path.exists(cand):
            return cand
    return shutil.which("claude") or "claude"


def ffmpeg_bin():
    """ffmpeg binary. FL_FFMPEG override, else homebrew path, else PATH lookup."""
    p = os.environ.get("FL_FFMPEG")
    if p:
        return p
    brew = "/opt/homebrew/bin/ffmpeg"
    if os.path.exists(brew):
        return brew
    return shutil.which("ffmpeg") or "ffmpeg"
