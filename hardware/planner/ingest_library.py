"""Approved component library (Phase 8).

After human review, an ingested UCS is saved here with an explicit support
status. Only `supported` or `partial` components may be used in synthesis;
`needs_review` and `unsupported` are recorded but NOT offered to the design
engine — the honesty gate between "ingested" and "usable".

  library/<mpn>.json      one approved UCS per file
  from ingest_library import save, load_all, get, approve
"""
import json
import os

LIB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "library")
USABLE = ("supported", "partial")


def _path(mpn):
    safe = "".join(c if c.isalnum() or c in "-_." else "_" for c in mpn)
    return os.path.join(LIB_DIR, safe + ".json")


def approve(spec, status, approver="user", note=""):
    """Set the human-decided support status. Refuses to mark a spec 'supported'
    if it still has validation errors (unsupported_fields) — honesty gate."""
    if status == "supported" and spec.get("unsupported_fields"):
        status = "partial"
        note = (note + " | downgraded to partial: unresolved fields %s"
                % spec["unsupported_fields"]).strip(" |")
    spec = dict(spec)
    spec["support_status"] = status
    spec["approval"] = {"by": approver, "status": status, "note": note}
    return spec


def save(spec):
    """Persist an approved spec. Returns its path."""
    os.makedirs(LIB_DIR, exist_ok=True)
    p = _path(spec["mpn"])
    json.dump(spec, open(p, "w"), indent=1)
    return p


def load_all(usable_only=False):
    out = {}
    if not os.path.isdir(LIB_DIR):
        return out
    for fn in os.listdir(LIB_DIR):
        if not fn.endswith(".json"):
            continue
        try:
            s = json.load(open(os.path.join(LIB_DIR, fn)))
        except Exception:
            continue
        if usable_only and s.get("support_status") not in USABLE:
            continue
        out[s.get("mpn", fn[:-5])] = s
    return out


def get(mpn, usable_only=True):
    lib = load_all(usable_only=usable_only)
    return lib.get(mpn)
