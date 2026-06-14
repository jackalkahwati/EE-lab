"""Datasheet -> structured part spec. Reads a datasheet PDF (URL or local path)
and uses the frontier model to extract what the part resolver needs: the
package, the exact pinout (pin number -> name -> function), the supply, and the
recommended support circuit (decoupling, pull-ups, external parts).

This generalizes the resolver past parts that happen to have a KiCad symbol: any
part with a datasheet becomes usable. Footprint GEOMETRY is deliberately NOT
generated here — the extracted `package` name keys a verified land pattern in
resolve_part. The datasheet supplies pinout + circuit; the library supplies
geometry.

Usage:
    datasheet_to_spec.py <datasheet-url-or-pdf> [part-name]
Prints a JSON spec on stdout (and a SPEC_JSON: line for easy machine capture).
"""
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from digikey import load_env  # reuse the .env.local loader

SYS = (
    "You are an expert electronics engineer who reads component datasheets. "
    "Extract a precise, structured spec. Use the EXACT pin numbers and names from "
    "the pinout/terminal table — do not invent or renumber. Output ONLY one JSON "
    "object, no prose."
)

SCHEMA_HINT = '''Return JSON exactly shaped like:
{
  "part": "<MPN or family>",
  "package": "<e.g. 'SOIC-8' or 'QFN-24 4x4mm 0.5mm pitch' or 'VSSOP-8'>",
  "interface": "<one of: i2c_sensor, spi_device, uart_device, power, other>",
  "supply_v": "<e.g. '2.7-5.5V'>",
  "pins": [ {"number": "1", "name": "SDA", "function": "I2C data"}, ... ],
  "support": [ {"part": "decoupling cap", "value": "100nF", "between": "VDD-GND", "why": "..."}, ... ]
}
Only include pins that the datasheet's pin table lists. Keep functions short.'''


def fetch_text(src):
    """Get datasheet text from a URL or local PDF path (first pages, layout kept)."""
    if re.match(r"^https?://", src):
        req = urllib.request.Request(src, headers={"User-Agent": "Mozilla/5.0 FirstLight"})
        data = urllib.request.urlopen(req, timeout=45).read()
        fd, path = tempfile.mkstemp(suffix=".pdf")
        os.write(fd, data)
        os.close(fd)
    else:
        path = src
    # -layout preserves pin-table columns; first 14 pages hold the pinout + app circuit
    txt = subprocess.run(
        ["pdftotext", "-layout", "-f", "1", "-l", "14", path, "-"],
        capture_output=True, text=True, timeout=60).stdout
    return txt[:48000]


def extract(text, part_hint):
    key = os.environ.get("OPENAI_API_KEY")
    model = os.environ.get("OPENAI_MODEL", "gpt-5.1")
    if not key:
        raise SystemExit("OPENAI_API_KEY not set in .env.local")
    user = (
        "{}\n\nPart (hint): {}\n\nDatasheet text:\n\"\"\"\n{}\n\"\"\"".format(
            SCHEMA_HINT, part_hint or "(unknown)", text))
    body = json.dumps({
        "model": model,
        "response_format": {"type": "json_object"},
        "messages": [{"role": "system", "content": SYS}, {"role": "user", "content": user}],
    }).encode()
    req = urllib.request.Request(
        "https://api.openai.com/v1/chat/completions", data=body,
        headers={"Authorization": "Bearer " + key, "content-type": "application/json"})
    d = json.loads(urllib.request.urlopen(req, timeout=120).read())
    return json.loads(d["choices"][0]["message"]["content"])


def main():
    load_env()
    if len(sys.argv) < 2:
        print(__doc__)
        return
    src = sys.argv[1]
    part_hint = sys.argv[2] if len(sys.argv) > 2 else ""
    spec = extract(fetch_text(src), part_hint)
    print(json.dumps(spec, indent=2))
    print("SPEC_JSON:" + json.dumps(spec))


if __name__ == "__main__":
    main()
