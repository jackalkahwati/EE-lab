"""M6 — Multi-Rail and Mixed-Signal Chip Synthesis v1.

Domain-aware power planning for chips with multiple rails and analog
domains. Every domain gets its OWN net (never silently merged); unknown
domains still block; analog input pins are never exposed as generic
digital IO — they are listed as requiring an analog front end, and analog
accuracy claims stay blocked.
"""
import re

DOMAIN_PATTERNS = [
    (r"^(VCC|VDD|DVDD|VDDD|VDDIO|IOVDD)$", "digital"),
    (r"^VCCA$", "dual_supply_a"), (r"^VCCB$", "dual_supply_b"),
    (r"^(AVDD|VDDA|AVCC|VA)$", "analog"),
    (r"^(VBAT|VBACKUP)$", "battery_backup"),
    (r"^(VREF|REFIN|VREFP)$", "reference"),
    (r"^(VIN|V\+)$", "supply_input"),
]
ANALOG_PIN = re.compile(r"^(AIN\d*|IN[+-]|VIN[+-]?\d*|CH\d+|ADC\d*)$")

DEFAULT_RAIL_NETS = {"digital": "+3V3", "dual_supply_a": "+3V3",
                     "dual_supply_b": "VCCB_RAIL", "analog": "AVDD_RAIL",
                     "battery_backup": "VBAT_RAIL",
                     "reference": "VREF_RAIL", "supply_input": "+5V"}

BLOCKED_MIXED_SIGNAL = ["analog_accuracy", "noise_performance",
                        "reference_stability", "calibrated_measurement"]


def plan_rails(pins, rail_overrides=None):
    """Return per-domain rail assignment or block on unknown domains.
    rail_overrides: {"VCCB": "+5V", ...} from the board spec (human intent)."""
    rail_overrides = rail_overrides or {}
    domains, unknown = {}, []
    for p in pins:
        if p["etype"] != "power_in":
            continue
        nm = p["name"].upper().split("/")[0]
        if "GND" in nm or nm == "VSS":
            continue
        dom = None
        for pat, d in DOMAIN_PATTERNS:
            if re.match(pat, nm):
                dom = d
                break
        if dom is None:
            unknown.append(nm)
            continue
        net = rail_overrides.get(nm, DEFAULT_RAIL_NETS[dom])
        domains.setdefault(dom, {"pins": [], "net": net,
                                 "review": net not in ("+3V3", "+5V", "GND")})
        domains[dom]["pins"].append(p["number"])
    if unknown:
        return None, ("unknown power domain(s) %s — blocked, no guess" %
                      sorted(set(unknown)))
    return domains, "ok"


def split_analog(io_pins):
    """Digital IO vs analog inputs. Analog pins NEVER join a generic IO
    header — they require an analog front end (review)."""
    dig, ana = [], []
    for io in io_pins:
        nm = io["name"].upper().replace("~", "").replace("{", "").replace("}", "")
        (ana if ANALOG_PIN.match(nm) else dig).append(io)
    return dig, ana
