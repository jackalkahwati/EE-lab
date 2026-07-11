"""Prototype demo: contract-free netmap inference (the open-contract wedge).

Runs resolve_part.infer_bind on (1) a part source_part has ALREADY resolved
(the cached i2c temp sensor) and (2) a complex BLE-SoC-class pinout, to show
that any part maps to a best-effort netmap plus an explicit, honest list of the
pins a human must still bind — with no hand-authored CONTRACT per part.

    python3 hardware/blocks/infer_demo.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import resolve_part  # noqa: E402


def run(title, pins):
    """pins: list of (number, name)."""
    pmap, rep = resolve_part.infer_bind(pins)
    print("=" * 68)
    print(title, "—", rep["coverage"], "|", rep["trust"])
    print("-" * 68)
    for role, hits in rep["bound"].items():
        print("  %-9s %s" % (role, ", ".join(hits)))
    if rep["review"]:
        print("  REVIEW (human must map): "
              + ", ".join("%s(%s)" % (nm, num) for num, nm in rep["review"]))
    if rep["review_categories"]:
        print("  needs-design categories:", ", ".join(rep["review_categories"]))
    print()


def from_cache():
    """The i2c temp sensor that source_part already resolved (real pinout)."""
    cache = json.load(open(os.path.join(HERE, "parts_cache.json")))
    for key, part in cache.items():
        pins = [(str(p.get("number")), p.get("name", "")) for p in part.get("pins", [])]
        run("source_part-resolved: %s (%s)" % (part.get("mpn", "?"), key), pins)


def ble_soc():
    """A representative BLE audio/SoC-class pinout (nRF52 family), the part
    class the fixed block library could NOT build. Hand-listed here only to
    show inference scales to a complex chip; in production these come from
    source_part's datasheet extraction."""
    names = [
        "VDD", "VSS", "DEC1", "DEC4", "VDDH", "VBUS", "D+", "D-",
        "XC1", "XC2", "ANT", "SWDIO", "SWDCLK", "RESET",
        "P0.00", "P0.01", "P0.02/AIN0", "P0.03/AIN1", "SCL", "SDA",
        "P0.06/TXD", "P0.08/RXD", "P0.13", "P0.14",
    ]
    run("BLE SoC-class (nRF52 family)", [(str(i + 1), n) for i, n in enumerate(names)])


if __name__ == "__main__":
    from_cache()
    ble_soc()
