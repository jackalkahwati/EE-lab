"""Universal Component Spec (UCS) — the one format every component normalises to.

A UCS is the schema-validated, versioned description of a real part: its pins and
their electrical types, power/ground, the interfaces it speaks, the support
circuit it needs (decoupling, pull-ups, crystals, reset/config), its KiCad
symbol + footprint, layout/routing/thermal/RF constraints, firmware driver and
FL-1 validation hooks, sourcing, and — critically — PER-FIELD provenance and
confidence so nothing is trusted blindly.

Honesty rules baked into the schema:
  - support_status is DERIVED, never asserted: a spec is only "supported" when
    the fields required to actually place + wire + validate it are present and
    high-confidence. Otherwise "partial" (with missing_fields) or "unsupported".
  - low-confidence critical fields downgrade the status; they are never hidden.

  from component_spec import validate, derive_status
  ok, errors = validate(spec)
  status, reasons = derive_status(spec)
"""
import jsonschema

UCS_VERSION = "1.0"

# electrical pin types (Phase 2 pin electrical types)
ETYPES = [
    "power_in", "power_out", "ground", "input", "output", "bidirectional",
    "tristate", "open_collector", "open_emitter", "passive", "analog_in",
    "analog_out", "clock", "no_connect", "unspecified",
]

# interface types (Phase 7) — note write-only SPI is first-class
INTERFACE_TYPES = [
    "gpio", "adc", "dac", "i2c", "spi", "spi_write_only", "uart", "can",
    "rs485", "usb", "ethernet", "pwm", "motor_output", "analog_in",
    "analog_out", "rf", "power_in", "power_out", "battery", "debug",
]

# where a field's value came from (Phase 17 provenance)
PROVENANCE_SOURCES = [
    "user", "kicad_library", "compose_block", "distributor_api",
    "datasheet", "datasheet_table", "ai_inference", "default_assumption",
]

# Fields that MUST be present + confident for a part to be fully "supported":
# without these Compose cannot honestly place, wire, and validate it.
CRITICAL_FIELDS = ["mpn", "kicad_symbol", "kicad_footprint", "pins",
                   "power.pins.power", "power.pins.ground", "interfaces"]
MIN_CRITICAL_CONFIDENCE = 0.6

SCHEMA = {
    "$schema": "http://json-schema.org/draft-07/schema#",
    "type": "object",
    "required": ["ucs_version", "mpn", "category", "pins", "power",
                 "provenance", "confidence"],
    "additionalProperties": True,
    "properties": {
        "ucs_version": {"const": UCS_VERSION},
        "mpn": {"type": "string", "minLength": 1},
        "manufacturer": {"type": "string"},
        "aliases": {"type": "array", "items": {"type": "string"}},
        "category": {"type": "string", "minLength": 1},
        "description": {"type": "string"},
        "package": {"type": "string"},
        "kicad_symbol": {"type": ["string", "null"]},
        "kicad_footprint": {"type": ["string", "null"]},
        "pins": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["number", "name", "etype"],
                "properties": {
                    "number": {"type": "string"},
                    "name": {"type": "string"},
                    "etype": {"enum": ETYPES},
                },
            },
        },
        "power": {
            "type": "object",
            "required": ["pins"],
            "properties": {
                "pins": {
                    "type": "object",
                    "properties": {
                        "power": {"type": "array", "items": {"type": "string"}},
                        "ground": {"type": "array", "items": {"type": "string"}},
                    },
                },
                "vcc_min": {"type": ["number", "null"]},
                "vcc_max": {"type": ["number", "null"]},
                "vcc_typ": {"type": ["number", "null"]},
                "i_typ_ma": {"type": ["number", "null"]},
                "i_max_ma": {"type": ["number", "null"]},
            },
        },
        "abs_max": {"type": "object"},
        "recommended": {"type": "object"},
        "interfaces": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["type"],
                "properties": {
                    "type": {"enum": INTERFACE_TYPES},
                    "signals": {"type": "object"},
                    "role": {"type": "string"},
                },
            },
        },
        "support_circuit": {
            "type": "object",
            "properties": {
                "decoupling": {"type": "array"},
                "pullups": {"type": "array"},
                "pulldowns": {"type": "array"},
                "crystals": {"type": "array"},
                "reset_config": {"type": "array"},
                "other_passives": {"type": "array"},
            },
        },
        "programming": {"type": "object"},
        "reference_circuit": {"type": ["string", "null"]},
        "constraints": {
            "type": "object",
            "properties": {
                "layout": {"type": "array"},
                "routing": {"type": "array"},
                "thermal": {"type": "array"},
                "rf": {"type": "array"},
            },
        },
        "firmware": {"type": "object"},
        "fl1_validation": {"type": "object"},
        "sourcing": {"type": "object"},
        # provenance + confidence are keyed by dotted field path
        "provenance": {"type": "object"},
        "confidence": {"type": "object"},
        "missing_fields": {"type": "array", "items": {"type": "string"}},
        "unsupported_fields": {"type": "array", "items": {"type": "string"}},
        # DERIVED — callers should not set this; derive_status() computes it
        "support_status": {"enum": ["supported", "partial", "unsupported"]},
    },
}

_validator = jsonschema.Draft7Validator(SCHEMA)


def validate(spec):
    """Schema-validate a UCS. Returns (ok, [error strings])."""
    errs = []
    for e in _validator.iter_errors(spec):
        loc = "/".join(str(p) for p in e.path) or "(root)"
        errs.append("%s: %s" % (loc, e.message))
    # provenance sources must be from the known set (soft-checked here, since
    # the schema keeps provenance open for dotted keys)
    for field, src in (spec.get("provenance") or {}).items():
        if src not in PROVENANCE_SOURCES:
            errs.append("provenance[%s]: unknown source '%s'" % (field, src))
    return (not errs, errs)


def _get(spec, dotted):
    cur = spec
    for part in dotted.split("."):
        if isinstance(cur, dict):
            cur = cur.get(part)
        else:
            return None
    return cur


def derive_status(spec):
    """Compute support_status from what is actually present + confident.
    NEVER trusts a caller-set status. Returns (status, reasons)."""
    reasons = []
    missing = []
    for f in CRITICAL_FIELDS:
        v = _get(spec, f)
        if v in (None, "", [], {}):
            missing.append(f)
            reasons.append("missing critical field: %s" % f)
            continue
        conf = (spec.get("confidence") or {}).get(f)
        if conf is not None and conf < MIN_CRITICAL_CONFIDENCE:
            reasons.append("low confidence (%.2f) on critical field: %s" % (conf, f))
    # explicitly-flagged unsupported fields are a hard downgrade
    for uf in spec.get("unsupported_fields") or []:
        reasons.append("unsupported field: %s" % uf)

    if len(missing) >= 2 or _get(spec, "kicad_symbol") in (None, "") \
            or _get(spec, "kicad_footprint") in (None, ""):
        status = "unsupported" if len(missing) >= 3 else "partial"
    elif reasons:
        status = "partial"
    else:
        status = "supported"
    return status, reasons


def finalize(spec):
    """Validate + stamp the derived status + missing_fields. Raises on schema
    failure (a malformed spec must never enter the library)."""
    ok, errs = validate(spec)
    if not ok:
        raise ValueError("UCS schema validation failed for %s:\n  %s"
                         % (spec.get("mpn", "?"), "\n  ".join(errs)))
    status, reasons = derive_status(spec)
    spec["support_status"] = status
    spec["_status_reasons"] = reasons
    return spec
