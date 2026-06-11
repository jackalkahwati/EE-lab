# bringup-station

Control software for the autonomous electronics bring-up station. See
`../ARCHITECTURE.md` for the full architecture, HAL backend table, and the
EVT proof traceability matrix.

Everything runs against a fully simulated machine today — no hardware needed.

## Quick start

```bash
cd software/station
PYTHONPATH=src python3 -m pytest tests -q          # run the test suite
PYTHONPATH=src uvicorn bringup_station.api.server:app --port 8800
```

Then:

```bash
curl localhost:8800/status
curl -X POST localhost:8800/home
```

Run a test plan (powers the virtual DUT, probes a test point with force
guarding, measures through the relay matrix, checks limits):

```bash
curl -X POST localhost:8800/plans/run -H 'Content-Type: application/json' -d '{
  "plan": {"name": "rail check", "board": "demo", "steps": [
    {"action": "set_power", "params": {"volts": 5.0, "current_limit_a": 0.5}},
    {"action": "measure_voltage", "target": "TP1",
     "params": {"probe": 0, "channel": 0}, "limits": {"lo": 3.2, "hi": 3.4}},
    {"action": "power_off"}]},
  "board": {"name": "demo", "testpoints": [
    {"name": "TP1", "net": "3V3", "x_mm": 10.0, "y_mm": 5.0}]}
}'
```

## Layout

- `src/bringup_station/hal/` — device interfaces + simulated bench
  (`mocks.py`); real drivers land in `hal/drivers/` as hardware arrives
- `motion/gantry.py` — soft limits, safety gating, force-guarded probing
- `safety/interlocks.py` — e-stop/door gating (observes the hardwired chain)
- `switching/matrix.py` — relay routing rules incl. live-power source lock
- `vision/registration.py` — fiducial-based board-to-machine transform
- `boardio/testpoints.py` — board model, test point CSV/JSON import
- `sequencer/` — test plan model and execution engine with cleanup-on-abort
- `api/server.py` — FastAPI control API (web UI talks to this)
- `sim.py` — one call wires the whole simulated machine
