/**
 * Toolchain path resolver — the single source of truth for where the external
 * binaries and KiCad shared libraries live.
 *
 * Every path resolves to the current macOS install location by DEFAULT (so the
 * Mac keeps working with nothing set), and to an environment-variable override
 * when one is present (so a Linux/cloud container becomes possible just by
 * setting the env vars). No behavior changes on the Mac.
 *
 * Env names (mirror hardware/blocks/toolchain.py + scripts/toolchain.py exactly):
 *   FL_KICAD_CLI · FL_KICAD_PYTHON · FL_KICAD_FOOTPRINTS · FL_KICAD_SYMBOLS
 *   FL_KICAD_3DMODELS · CLAUDE_CLI_PATH · FL_FFMPEG
 */
import fs from 'node:fs'

const KICAD_APP = '/Applications/KiCad/KiCad.app/Contents'

/** kicad-cli binary (pcb drc / export / render). */
export function kicadCli(): string {
  // FL_KICAD_CLI is the standardized name; KICAD_CLI is honored as a legacy
  // alias so an existing override keeps working (neither is set on the Mac).
  return (
    process.env.FL_KICAD_CLI ||
    process.env.KICAD_CLI ||
    `${KICAD_APP}/MacOS/kicad-cli`
  )
}

/** KiCad's bundled python3 (has pcbnew + jsonschema for the pipeline scripts). */
export function kicadPython(): string {
  return (
    process.env.FL_KICAD_PYTHON ||
    `${KICAD_APP}/Frameworks/Python.framework/Versions/Current/bin/python3`
  )
}

/** KiCad shared footprint libraries (.pretty dirs). */
export function kicadFootprints(): string {
  return process.env.FL_KICAD_FOOTPRINTS || `${KICAD_APP}/SharedSupport/footprints`
}

/** KiCad shared symbol libraries (.kicad_sym). */
export function kicadSymbols(): string {
  return process.env.FL_KICAD_SYMBOLS || `${KICAD_APP}/SharedSupport/symbols`
}

/** KiCad shared 3D models (.wrl/.step). */
export function kicad3dModels(): string {
  return process.env.FL_KICAD_3DMODELS || `${KICAD_APP}/SharedSupport/3dmodels`
}

/**
 * Claude Code CLI binary. Explicit CLAUDE_CLI_PATH wins; otherwise the first
 * existing of the common install locations; otherwise a bare `claude` (PATH
 * lookup) so a Linux box with claude on PATH just works.
 */
export function claudeBin(): string {
  if (process.env.CLAUDE_CLI_PATH) return process.env.CLAUDE_CLI_PATH
  const home = process.env.HOME || ''
  for (const p of [`${home}/.local/bin/claude`, '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    try {
      if (fs.existsSync(p)) return p
    } catch {
      /* keep looking */
    }
  }
  return 'claude'
}

/** ffmpeg binary. FL_FFMPEG override, else homebrew path, else PATH lookup. */
export function ffmpegBin(): string {
  if (process.env.FL_FFMPEG) return process.env.FL_FFMPEG
  const brew = '/opt/homebrew/bin/ffmpeg'
  try {
    if (fs.existsSync(brew)) return brew
  } catch {
    /* fall through */
  }
  return 'ffmpeg'
}
