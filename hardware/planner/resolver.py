"""Component Resolver (Phase 8) — map a request (exact part OR generic capability)
to a real, supported implementation, or say honestly why it can't.

Resolution order for an exact MPN:
  1. seed library / already-ingested library
  2. ingest from a KiCad symbol by MPN (real)
  3. unsupported stub with the reason

For a capability request ("temperature sensor", "rs485", ...) we look up the
capability -> candidate parts table and resolve the best candidate.

A resolution NEVER pretends: it returns support_status from the spec itself, plus
concrete reasons drawn from the spec's missing_fields (missing symbol / footprint
/ interface / etc.). The recovery loop uses the reasons to decide what to do.
"""
import ingest

# capability -> ordered candidate MPNs (seed library). The resolver walks these
# until one resolves as supported.
CAPABILITY_MAP = {
    "temperature": ["BME280"], "humidity": ["BME280"], "pressure": ["BME280"],
    "environmental": ["BME280"], "air_quality": [], "gas": [], "voc": [],
    "current_sense": ["INA219"], "power_monitor": ["INA219"],
    "accelerometer": ["LIS3DH"], "motion": ["LIS3DH"],
    "rtc": ["DS3231"], "real_time_clock": ["DS3231"],
    "gpio_expander": ["MCP23017"],
    "spi_flash": ["W25Q128JVSIQ"], "flash": ["W25Q128JVSIQ"], "storage": ["W25Q128JVSIQ"],
    "rs485": ["MAX3485"], "shift_register": ["74HC595"], "led_driver": ["74HC595"],
    "addressable_led": ["WS2812B"], "rgb_led": ["WS2812B"],
    "motor_driver": ["DRV8833"], "dc_motor": ["DRV8833"],
    "battery_charger": ["MCP73831"], "charger": ["MCP73831"],
    "buck": ["TPS62162"], "step_down": ["TPS62162"],
    "ldo": ["AP2112K-3.3"], "regulator_3v3": ["AP2112K-3.3", "TPS62162"],
    "usb_c_power": ["USB4085-GF-A"], "usb_power": ["USB4085-GF-A"],
    "battery_connector": ["S2B-PH-K-S"], "battery": ["S2B-PH-K-S"],
    "display": ["SSD1306-OLED-I2C"], "oled": ["SSD1306-OLED-I2C"],
}

# capabilities a part actually provides (for substitution reporting). Read from
# the spec 'capabilities' override when present; else inferred from category.
def part_capabilities(spec):
    caps = list(spec.get("capabilities", []))
    if caps:
        return caps
    cat = spec.get("category", "")
    for key, mpns in CAPABILITY_MAP.items():
        if spec.get("mpn") in mpns:
            caps.append(key)
    return caps or [cat.split(".")[-1]]


def _reasons(spec):
    r = []
    for mf in spec.get("missing_fields", []):
        r.append("missing " + mf.replace("_", " ").replace(".", " "))
    r += ["low confidence: " + x for x in spec.get("_status_reasons", [])
          if "low confidence" in x]
    if spec.get("_stub_reason"):
        r.append(spec["_stub_reason"])
    return r


def resolve_part_request(mpn, lib):
    """Resolve an exact part number. Returns a resolution dict."""
    # 1. library (seeds + previously ingested)
    if mpn in lib:
        spec = lib[mpn]
        return _resolution(mpn, spec, "library")
    # alias match
    for m, s in lib.items():
        if mpn in s.get("aliases", []) or mpn.upper() == m.upper():
            return _resolution(mpn, s, "library")
    # 2. ingest from KiCad by MPN (real)
    spec = ingest.from_mpn(mpn)
    if spec.get("support_status") != "unsupported" and spec.get("pins"):
        lib[spec["mpn"]] = spec  # add newly-ingested part to the library
        return _resolution(mpn, spec, "ingested:kicad")
    # 3. unsupported
    return _resolution(mpn, spec, "unresolved")


def resolve_capability(capability, lib):
    """Resolve a generic capability to the best supported candidate."""
    cands = CAPABILITY_MAP.get(capability, [])
    if not cands:
        return {"request": capability, "kind": "capability", "status": "unsupported",
                "spec": None, "source": "none",
                "reasons": ["no known supported part provides '%s'" % capability],
                "capability": capability}
    best = None
    for mpn in cands:
        res = resolve_part_request(mpn, lib)
        if res["status"] == "supported":
            res["kind"] = "capability"
            res["request"] = capability
            res["capability"] = capability
            return res
        best = best or res
    best["kind"] = "capability"
    best["request"] = capability
    best["capability"] = capability
    return best


def _resolution(request, spec, source):
    return {
        "request": request, "kind": "part",
        "status": spec.get("support_status", "unsupported"),
        "spec": spec if spec.get("pins") else None,
        "mpn": spec.get("mpn"),
        "source": source,
        "reasons": _reasons(spec),
        "capabilities": part_capabilities(spec) if spec.get("pins") else [],
    }
