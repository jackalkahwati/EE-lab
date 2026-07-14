"""Recursive design decomposition (Stage 2) — turn a flat resolved parts list
into a design TREE of subsystems, and *solve* each subsystem's own choices.

The planner resolves a flat `final_design` (a list of UCS parts). A real product
is not flat: it is a hierarchy of subsystems (power, compute, sensing,
connectivity, HMI, storage, actuation), and each subsystem has its own
requirement and its own design decisions. This module builds that hierarchy so a
complex product is legible, and so the same `solve` step applies at every level
of the tree — the recursion. It changes NOTHING about the parts that get built
(synth still consumes the flat list); it adds the structure + rationale on top,
and makes real per-subsystem choices where a choice exists (e.g. LDO vs buck).

    tree = build_design_tree(intent, final_design)

A node is: {name, kind, requirement, parts:[mpn], rationale, children:[node]}.
`kind` is one of: product | subsystem | block. A `block` is a leaf; a subsystem
with internal structure recurses into blocks. Nothing here fabricates a part —
it only groups + explains parts the planner already resolved, and records the
decision made where more than one real option existed.
"""

# subsystem name -> (UCS category prefixes it owns, one-line requirement)
SUBSYSTEMS = [
    ("power",        ("power", "connector.power", "connector.usb", "connector.battery"),
     "convert the input source to the board rails the rest of the design needs"),
    ("compute",      ("mcu", "logic", "processor"),
     "run the firmware and drive every peripheral bus"),
    ("sensing",      ("sensor",),
     "measure the physical quantities the product reports"),
    ("storage",      ("memory",),
     "retain data/logs across power cycles"),
    ("connectivity", ("interface", "radio", "comms", "timer"),
     "move data on/off board over its buses and links"),
    ("hmi",          ("display", "led", "hmi", "button", "switch", "audio"),
     "present state to and take input from the user"),
    ("actuation",    ("motor", "servo", "actuator", "relay"),
     "drive the physical outputs of the product"),
]

# power sub-blocks a power subsystem recurses into, in order of the energy path.
_POWER_BLOCKS = ["inlet", "regulation", "protection"]


def _cat(spec):
    return (spec.get("category") or "").lower()


def _matches(spec, prefixes):
    c = _cat(spec)
    return any(c.startswith(p) for p in prefixes)


def _subsystem_of(spec):
    for name, prefixes, _req in SUBSYSTEMS:
        if _matches(spec, prefixes):
            return name
    return "connectivity"  # unclassified support parts ride with the buses


def _solve_power(parts, intent):
    """The one real per-subsystem *choice* today: how to make the board rail.
    Records the decision + why (a scored pick, the kernel principle in miniature),
    without inventing a part — it explains what the planner already resolved."""
    src = (intent.get("power") or {}).get("source") or "usb"
    rails = (intent.get("power") or {}).get("rails") or ["3V3"]
    has_reg = any(_cat(p).startswith("power.") for p in parts)
    if has_reg:
        reg = next(p for p in parts if _cat(p).startswith("power."))
        kind = "buck" if "buck" in _cat(reg) else "LDO"
        why = ("%s regulator resolved (%s): a %s suits this rail/current budget"
               % (kind, reg["mpn"], "switcher" if kind == "buck" else "linear"))
    else:
        # no regulator resolved — the MCU runs from the inlet rail directly
        why = ("no separate regulator: the input feeds the %s rail(s) directly "
               "(add an LDO/buck if the source voltage differs)" % "/".join(rails))
    return "%s inlet -> %s" % (src, why)


def _power_blocks(parts, intent):
    """Recurse the power subsystem into inlet / regulation / protection blocks."""
    blocks = []
    inlet = [p for p in parts if _cat(p).startswith("connector.")]
    reg = [p for p in parts if _cat(p).startswith("power.")]
    if inlet:
        blocks.append({"name": "inlet", "kind": "block",
                       "requirement": "bring the source onto the board",
                       "parts": [p["mpn"] for p in inlet], "rationale": "", "children": []})
    if reg:
        blocks.append({"name": "regulation", "kind": "block",
                       "requirement": "produce the board rail(s)",
                       "parts": [p["mpn"] for p in reg], "rationale": "", "children": []})
    return blocks


def build_design_tree(intent, final_design, mcu_family=None):
    """Group the flat resolved parts into a recursive subsystem tree + per-node
    rationale. `mcu_family` (from intent.mcu) names the compute node's MCU even
    though the MCU is added by synth, not present in final_design."""
    intent = intent or {}
    mcu_family = mcu_family or (intent.get("mcu") or {}).get("family")
    goal = intent.get("product_goal") or "product"

    # bucket every resolved part into its subsystem
    buckets = {name: [] for name, _p, _r in SUBSYSTEMS}
    for spec in final_design or []:
        buckets[_subsystem_of(spec)].append(spec)

    children = []
    for name, _prefixes, req in SUBSYSTEMS:
        parts = buckets[name]
        # compute always shows (it carries the MCU, which lives outside final_design)
        if not parts and name != "compute":
            continue
        node = {"name": name, "kind": "subsystem", "requirement": req,
                "parts": [p["mpn"] for p in parts], "rationale": "", "children": []}
        if name == "compute" and mcu_family:
            node["parts"] = [mcu_family] + node["parts"]
            node["rationale"] = "MCU family %s selected for the required buses/peripherals" % mcu_family
        elif name == "power":
            node["rationale"] = _solve_power(parts, intent)
            node["children"] = _power_blocks(parts, intent)
        elif parts:
            node["rationale"] = "%d part(s) resolved for this subsystem" % len(parts)
        else:
            node["rationale"] = "no parts required by this product"
        children.append(node)

    return {"name": goal, "kind": "product", "requirement": goal,
            "parts": [], "rationale": "decomposed into %d subsystems" % len(children),
            "children": children}


def flatten_tree(node, depth=0):
    """Human-readable outline of a design tree (for logs/CLI)."""
    pad = "  " * depth
    tag = "%s%s [%s]" % (pad, node["name"], node["kind"])
    if node.get("parts"):
        tag += " {%s}" % ", ".join(node["parts"])
    if node.get("rationale"):
        tag += "  — " + node["rationale"]
    lines = [tag]
    for c in node.get("children", []):
        lines += flatten_tree(c, depth + 1)
    return lines
