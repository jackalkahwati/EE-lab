"""Datasheet extraction (Phase 3) — REAL text extraction, never invention.

Runs `pdftotext` over a datasheet PDF and pulls a small set of high-value fields
with strict provenance: supply-voltage range, package, decoupling requirement,
absolute-max hints, and interface keywords. Every field carries its source, the
page it was found on, an extraction confidence, the method, and needs_review.

HONESTY: if a field is not found, it is left UNKNOWN — this module never guesses a
value. Low confidence + needs_review is the default for everything it does find,
because regex over datasheet prose is evidence, not proof. A human confirms.

  from ingest_datasheet import extract
  fields = extract("/path/to/ADS1115.pdf")   # {} if no PDF / pdftotext missing
"""
import os
import re
import shutil
import subprocess


def _pages(pdf_path):
    """Return [(page_no, text), ...] via pdftotext, or [] if unavailable."""
    if not pdf_path or not os.path.exists(pdf_path) or not shutil.which("pdftotext"):
        return []
    try:
        # -layout keeps pin tables roughly aligned; page breaks are form-feeds
        out = subprocess.run(["pdftotext", "-layout", pdf_path, "-"],
                             capture_output=True, text=True, timeout=60).stdout
    except Exception:
        return []
    return list(enumerate(out.split("\f"), start=1))


_VOLT = re.compile(
    r"(?:supply|operating|analog\s+supply|VDD|VCC|AVDD)[^\n]{0,40}?"
    r"(\d\.?\d*)\s*V?\s*(?:to|–|-|…)\s*(\d\.?\d*)\s*V", re.I)
_PKG = re.compile(r"\b(TSSOP|MSOP|VSSOP|SOIC|SOT-?23|QFN|WSON|DFN|TQFP|LQFP|BGA|"
                  r"MicroSMD|X2QFN|VQFN)[- ]?(\d+)?\b")
_DECAP = re.compile(r"(0\.1\s*[µu]F|100\s*nF|1\s*[µu]F|10\s*[µu]F)[^\n]{0,60}?"
                    r"(?:bypass|decoupl|supply)", re.I)
_ABSMAX = re.compile(r"absolute\s+maximum", re.I)


def _mk(value, page, conf, method, note=""):
    return {"value": value, "source": "datasheet", "page": page,
            "confidence": conf, "method": method, "needs_review": True, "note": note}


def extract(pdf_path):
    """Extract a small, honest set of datasheet fields. Returns a dict of
    field -> evidence record (only for fields actually found)."""
    pages = _pages(pdf_path)
    if not pages:
        return {"_available": False,
                "_note": "no datasheet PDF / pdftotext unavailable — datasheet "
                         "fields left UNKNOWN (not guessed)"}
    found = {"_available": True, "_pages": len(pages)}
    for pageno, text in pages:
        if "voltage" not in found:
            m = _VOLT.search(text)
            if m:
                lo, hi = float(m.group(1)), float(m.group(2))
                if 0.5 <= lo < hi <= 60:
                    found["voltage"] = _mk({"vcc_min": lo, "vcc_max": hi}, pageno,
                                           0.55, "regex:supply-range")
        if "package" not in found:
            m = _PKG.search(text)
            if m:
                found["package"] = _mk(m.group(0).strip(), pageno, 0.6, "regex:package")
        if "decoupling" not in found:
            m = _DECAP.search(text)
            if m:
                found["decoupling"] = _mk(re.sub(r"\s+", "", m.group(1)), pageno,
                                          0.5, "regex:decoupling",
                                          "datasheet mentions a supply bypass cap")
        if "abs_max_present" not in found and _ABSMAX.search(text):
            found["abs_max_present"] = _mk(True, pageno, 0.7, "regex:section",
                                           "an Absolute Maximum Ratings section "
                                           "exists — extract limits by hand")
    return found


if __name__ == "__main__":
    import json
    import sys
    print(json.dumps(extract(sys.argv[1] if len(sys.argv) > 1 else ""), indent=1))
