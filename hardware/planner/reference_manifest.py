"""Controlled reference-design manifest (Phase 8 v1).

Compose does NOT scrape the internet. Reference designs enter through a curated
manifest — a human drops files into references/<bucket>/ and registers each with
a provenance + license entry. This module defines the trust hierarchy + license
gates and reads/validates the manifest.

Trust hierarchy (for pattern reuse decisions):
  firstlight_generated  — our own validated designs; highest trust, permissive
  manufacturer_eval_board / app_note — highest trust for COMPONENT usage, but
                          reference_only unless the license explicitly allows reuse
  open_source           — useful only with a clear license; direct reuse only for
                          permissive licenses or after review
  forum_blog            — idea/reference only, NEVER direct reuse in v1

  from reference_manifest import load, can_direct_reuse
"""
import json
import os

REF_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "references")
MANIFEST = os.path.join(REF_DIR, "manifest.json")

SOURCE_TYPES = ("firstlight_generated", "manufacturer_eval_board", "app_note",
                "open_source", "forum_blog", "ingested_ucs", "component_contract")

TRUST = {"firstlight_generated": "high", "manufacturer_eval_board": "high",
         "app_note": "high", "open_source": "medium", "forum_blog": "low",
         "ingested_ucs": "high", "component_contract": "high"}

LICENSE_STATUS = ("permissive_reuse", "attribution_required",
                  "copyleft_review_required", "manufacturer_reference_only",
                  "unknown_needs_review", "do_not_reuse")

# what a given license permits — the honesty gate. Direct reuse ONLY for
# permissive or FirstLight-owned; everything else is reference/adapt/review.
_ALLOWED_USE = {
    "permissive_reuse": "direct_reuse",
    "attribution_required": "adapt_with_attribution",
    "copyleft_review_required": "reference_only",
    "manufacturer_reference_only": "reference_only",
    "unknown_needs_review": "needs_review",
    "do_not_reuse": "none",
}


def allowed_use(license_status):
    return _ALLOWED_USE.get(license_status, "needs_review")


def can_direct_reuse(license_status):
    """The gate: only a permissive license (or FirstLight-owned) may be reused
    directly. Unknown / manufacturer / copyleft / forum -> NO direct reuse."""
    return license_status == "permissive_reuse"


def default_license_for(source_type):
    """Conservative default when a reference doesn't state a license."""
    if source_type in ("firstlight_generated", "ingested_ucs", "component_contract"):
        return "permissive_reuse"          # our own IP / our own part ingestion
    if source_type in ("manufacturer_eval_board", "app_note"):
        return "manufacturer_reference_only"
    if source_type == "forum_blog":
        return "do_not_reuse"              # v1: idea-only, never reused
    return "unknown_needs_review"


def _entry(name, source_type, **kw):
    lic = kw.get("license_status") or default_license_for(source_type)
    return {
        "name": name, "source_type": source_type,
        "trust_level": TRUST.get(source_type, "low"),
        "license_status": lic, "allowed_use": allowed_use(lic),
        "url": kw.get("url"), "manufacturer": kw.get("manufacturer"),
        "document_title": kw.get("document_title"), "revision": kw.get("revision"),
        "date": kw.get("date"), "local_files": kw.get("local_files", []),
        "notes": kw.get("notes", ""),
        "status": "registered" if kw.get("local_files") else "needs_reference",
    }


def validate(entry):
    errs = []
    if entry.get("source_type") not in SOURCE_TYPES:
        errs.append("unknown source_type: %s" % entry.get("source_type"))
    if entry.get("license_status") not in LICENSE_STATUS:
        errs.append("unknown license_status: %s" % entry.get("license_status"))
    # a reference with local files but no license is a hazard -> force review
    if entry.get("local_files") and entry.get("license_status") == "unknown_needs_review":
        errs.append("has local files but license unknown — cannot be reused")
    return errs


def load():
    """Load the manifest (creating a seed if absent). Returns the list of refs."""
    if not os.path.exists(MANIFEST):
        seed = _seed()
        os.makedirs(REF_DIR, exist_ok=True)
        json.dump({"version": 1, "references": seed}, open(MANIFEST, "w"), indent=1)
        return seed
    try:
        return json.load(open(MANIFEST)).get("references", [])
    except Exception:
        return []


def _seed():
    """Seed the manifest with what is genuinely local + honest placeholders for
    references to be curated later. No fabricated external sources."""
    return [
        _entry("FirstLight golden sensor hub (Compose-generated)",
               "firstlight_generated",
               local_files=["../../software/prompt-to-pcb-ui/public/runs/golden-sensor-hub"],
               notes="Compose's own validated RP2040 sensor hub — reusable FL pattern"),
        _entry("FirstLight ADS1115 measurement front-end (Compose-recovered)",
               "firstlight_generated",
               local_files=["../../software/prompt-to-pcb-ui/public/runs/fl1meas-rec2-a3"],
               notes="Recovered fine-pitch board that passes 0/0 — reusable FL pattern"),
        _entry("ADS1115 ingested UCS component", "ingested_ucs",
               local_files=["library/ADS1115IDGS.json"],
               notes="approved partial UCS — component-usage reference"),
        # honest placeholders — register real files + license before these are usable
        _entry("ADS1115 evaluation board (ADS1115EVM)", "manufacturer_eval_board",
               manufacturer="Texas Instruments", url=None,
               notes="PLACEHOLDER — drop the EVM package into references/eval_boards/ "
                     "and set url/revision/license before ingestion"),
        _entry("TI precision-ADC layout app note", "app_note",
               manufacturer="Texas Instruments",
               notes="PLACEHOLDER — reference_only; add the PDF + URL when curated"),
    ]
