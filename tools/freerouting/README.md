# freerouting (chip-scale autorouter)

The chip-scale redesign loop (`tools/tscircuit/run_board.mjs`) prefers
**freerouting** — a real push-and-shove autorouter — over tscircuit's built-in
router, because it produces far cleaner boards (fewer vias, passes fab DRC). It
runs **headless as a backend subprocess** (`java -jar ... -de board.dsn -do
board.ses`), no GUI window.

## Setup (one-time, local/self-hosted only)

1. **Java** (runtime): `brew install openjdk` — the runner looks for
   `/opt/homebrew/opt/openjdk/bin/java` (or `$JAVA_HOME`, `/usr/bin/java`).
2. **The jar** (55MB, not committed): download the official v2.2.4 release into
   this directory:
   ```
   gh release download v2.2.4 --repo freerouting/freerouting \
     --pattern "freerouting-2.2.4.jar" --dir tools/freerouting
   ```

If Java or the jar is absent, the loop transparently falls back to the built-in
router + geometry repair (and says so) — nothing breaks, results are just less
clean.

## How it's invoked

The runner spawns it headless with capped network timeouts (its startup
update-check otherwise stalls ~2min on the socket):
```
java -Djava.awt.headless=true \
     -Dsun.net.client.defaultConnectTimeout=1500 \
     -Dsun.net.client.defaultReadTimeout=1500 \
     -jar freerouting-2.2.4.jar -de board.dsn -do board.ses -mp 10
```
circuit-json ⇄ Specctra DSN/SES conversion is handled by the `dsn-converter`
npm package in `tools/tscircuit`.
