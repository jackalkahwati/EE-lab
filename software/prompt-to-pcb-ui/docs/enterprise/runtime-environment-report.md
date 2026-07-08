# Runtime environment report

- node: v25.9.0 · next: 16.2.6 · react: ^19
- tailwind: v4 (oxide native scanner) · three: ^0.185.1
- kicad-cli: 10.0.1 · planner python: Python 3.9.6

## Known runtime issues (documented honestly)
- Tailwind v4 oxide scanner CRASHES on multi-MB binaries in non-gitignored paths (silent worker death -> TurbopackInternalError on globals.css; dev hangs). Guards: *.glb gitignored + @source not "../public" in globals.css. Any new generated binary must be gitignored BEFORE the next build.
- next start holds the port across rebuilds — kill by PID from lsof -t -iTCP:<port> before restarting, or EADDRINUSE serves the STALE build
- pcbnew (kipython) requires crash-isolated subprocesses for fixture suites (M3A harness does this)
- plain-ESM .mjs modules are shared between Next API routes and node test scripts — keep them dependency-free

## Allowed/unsupported runtime matrix
- node 25.x + next 16.2 (turbopack): validated (this machine)
- node 22 LTS: expected OK — NOT validated
- webpack build: works via next build --webpack; not the default
- windows: NOT validated (kicad paths are macOS-specific in scripts)
