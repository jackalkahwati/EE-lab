"""Pin Allocation Engine (Phase 4).

Given an MCU spec and a list of function REQUESTS (role + net name + required
capability), assign real footprint pads — conflict-free and capability-respecting.

Guarantees (the honesty of the allocator):
- reserved pads (power / ground / reset / boot / debug) are never handed out;
- a pad is never assigned twice (no silent reuse);
- an ADC signal only lands on an ADC-capable pad, a PWM output only on a
  PWM-capable pad, I2C/SPI/UART/CAN only on pads that can carry them;
- if a request cannot be satisfied it is reported as a CONFLICT, not forced.

Emits pin_assignment.json / .md + a firmware pin map + the pad->net map synth
uses to place the MCU footprint.

  from pin_allocator import allocate
"""

# capability -> also acceptable fallback capabilities (a plain GPIO can be a CS,
# a chip-select, an enable, etc. — but NEVER ADC or a dedicated bus line)
_FALLBACK = {
    "spi_cs": ["gpio"],
    "gpio": [],
    "pwm": [],          # PWM must be a real PWM pad
    "adc": [],          # ADC must be a real ADC pad
    "i2c_sda": [], "i2c_scl": [],
    "spi_sck": [], "spi_mosi": [], "spi_miso": [],
    "uart_tx": [], "uart_rx": [],
    "can_tx": [], "can_rx": [],
}


def allocate(spec, requests):
    """requests: list of {"role","net","cap"}. Returns the allocation record."""
    cap = spec.get("capable", {})
    reserved = {
        "power": list(map(str, spec.get("power_pins", []))),
        "ground": list(map(str, spec.get("ground_pins", []))),
        "reset": list(map(str, spec.get("reset_pins", []))),
        "boot": list(map(str, spec.get("boot_pins", []))),
        "debug": list(map(str, spec.get("debug_pins", []))),
        "clock": list(map(str, spec.get("clock_pins", []))),
        "usb": list(map(str, spec.get("usb_pins", []))),
    }
    reserved_pads = set()
    for grp in reserved.values():
        reserved_pads.update(grp)
    reserved_pads.update(map(str, spec.get("avoid", [])))

    # Build each request's pad options (capability set + allowed fallbacks, minus
    # reserved pads). Then solve a BIPARTITE MATCHING so a flexible function (a
    # GPIO with 26 options) never steals a pad a scarce function (uart_tx with 2
    # options) needs — greedy allocation gets this wrong; matching finds a valid
    # assignment whenever one exists, and only reports a conflict when it truly
    # cannot be satisfied.
    options = []
    for r in requests:
        want = r["cap"]
        pool = list(map(str, cap.get(want, [])))
        for fb in _FALLBACK.get(want, []):
            pool += list(map(str, cap.get(fb, [])))
        seen = set()
        pool = [p for p in pool if p not in reserved_pads and not (p in seen or seen.add(p))]
        options.append(pool)

    # order by fewest options first so scarce functions match earliest (Kuhn's
    # algorithm is correct regardless, but this yields tidier assignments)
    order = sorted(range(len(requests)), key=lambda i: len(options[i]))
    pad_to_req = {}  # pad -> request index

    def _augment(ri, visited):
        for pad in options[ri]:
            if pad in visited:
                continue
            visited.add(pad)
            if pad not in pad_to_req or _augment(pad_to_req[pad], visited):
                pad_to_req[pad] = ri
                return True
        return False

    for ri in order:
        _augment(ri, set())

    req_to_pad = {ri: pad for pad, ri in pad_to_req.items()}
    assignments = []
    conflicts = []
    for i, r in enumerate(requests):
        if i in req_to_pad:
            assignments.append({"role": r["role"], "net": r["net"],
                                 "pad": req_to_pad[i], "cap": r["cap"]})
        else:
            conflicts.append({
                "role": r["role"], "net": r["net"], "cap": r["cap"],
                "why": "no free %s-capable pad left" % r["cap"],
            })

    pmap = {a["pad"]: a["net"] for a in assignments}
    # power/ground/regulator pads -> rails (synth wires these)
    reg = spec.get("regulator_out")
    fw_map = {a["role"]: a["pad"] for a in assignments}
    return {
        "mcu": spec["mpn"], "family": spec["family"],
        "kicad_symbol": spec["kicad_symbol"], "kicad_footprint": spec["kicad_footprint"],
        "assignments": assignments,
        "reserved": reserved,
        "regulator_out": reg,
        "conflicts": conflicts,
        "pad_net_map": pmap,
        "firmware_pin_map": fw_map,
        "ok": len(conflicts) == 0,
    }


def to_markdown(alloc, decision=None):
    md = ["# MCU Pin Assignment\n"]
    if decision:
        md.append("**Selected MCU:** %s (%s, %s)  ·  status %s  ·  confidence %.2f"
                  % (decision.get("selected"), decision.get("mpn"),
                     decision.get("package"), decision.get("status", "?"),
                     decision.get("confidence", 0)))
        md.append("**Why:** %s\n" % decision.get("why", ""))
        if decision.get("partial_warning"):
            md.append("> partial: %s\n" % decision["partial_warning"])
        if decision.get("rejected"):
            md.append("### Rejected candidates")
            for rj in decision["rejected"]:
                md.append("- **%s** — %s" % (rj["mcu"], "; ".join(rj["reasons"])))
            md.append("")
    md.append("### Assigned pins")
    md.append("| Role | Net | Pad | Capability |")
    md.append("|---|---|---|---|")
    for a in alloc["assignments"]:
        md.append("| %s | %s | %s | %s |" % (a["role"], a["net"], a["pad"], a["cap"]))
    md.append("\n### Reserved (never allocated)")
    for k, v in alloc["reserved"].items():
        if v:
            md.append("- **%s:** %s" % (k, ", ".join(v)))
    if alloc["conflicts"]:
        md.append("\n### CONFLICTS (unresolved — board would be incomplete)")
        for c in alloc["conflicts"]:
            md.append("- %s (%s): %s" % (c["role"], c["cap"], c["why"]))
    return "\n".join(md) + "\n"
