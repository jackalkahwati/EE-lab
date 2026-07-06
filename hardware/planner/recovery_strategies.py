"""Recovery strategy library (Phase 2) + ranking.

Each strategy declares which failure types it applies to, its preconditions,
expected effect, risks, whether it preserves function, and whether it needs human
approval. `rank(failures)` returns an ordered list of concrete (strategy, target)
plans to try — cheapest/safest first, ending in an honest "mark unsupported" that
never claims success.

A strategy's `hint` describes how it changes the NEXT board attempt (a synth
recovery hint). Strategies that cannot be auto-applied (substitute, approval) are
marked terminal-for-auto so the orchestrator surfaces them instead of guessing.
"""
from failure_taxonomy import (
    FINE_PITCH_ESCAPE, CLEARANCE, UNCONNECTED, KEEPOUT_PLACEMENT, ERC,
    FOOTPRINT_MISMATCH, MISSING_PASSIVE, PIN_ALLOCATION, MCU_UNFIT,
    HIGH_SPEED_UNSUPPORTED, HIGHSPEED_PAIR_FAIL, COMPONENT_UNSUPPORTED, SOURCING,
)

STRATEGIES = {
    "increase_spacing": {
        "applies": [FINE_PITCH_ESCAPE, CLEARANCE, UNCONNECTED],
        "precondition": "the failure names a component",
        "effect": "give the router more room around the part to escape cleanly",
        "risks": "larger board", "preserves_function": True, "requires_approval": False,
        "auto": True,
    },
    "rotate_component": {
        "applies": [FINE_PITCH_ESCAPE, KEEPOUT_PLACEMENT, CLEARANCE],
        "precondition": "component may be rotated without violating orientation rules",
        "effect": "change the pin-escape geometry / antenna orientation",
        "risks": "antenna/thermal orientation for some parts", "preserves_function": True,
        "requires_approval": False, "auto": True,
    },
    "move_to_edge": {
        "applies": [KEEPOUT_PLACEMENT, UNCONNECTED],
        "precondition": "part has an antenna/connector that prefers a board edge",
        "effect": "place a module at the board edge so its keepout hangs off-board",
        "risks": "mechanical fit", "preserves_function": True,
        "requires_approval": False, "auto": True,
    },
    "enlarge_board": {
        "applies": [FINE_PITCH_ESCAPE, CLEARANCE, UNCONNECTED, KEEPOUT_PLACEMENT],
        "precondition": "board size is not mechanically fixed",
        "effect": "more routing/placement room",
        "risks": "bigger, costlier board", "preserves_function": True,
        "requires_approval": False, "auto": True,
    },
    "alternate_footprint": {
        "applies": [FINE_PITCH_ESCAPE, FOOTPRINT_MISMATCH],
        "precondition": "a validated coarser footprint for the same part exists",
        "effect": "escape a wider-pitch land the router can close",
        "risks": "must be a real, validated alternative", "preserves_function": True,
        "requires_approval": True, "auto": False,     # needs a real validated alt
    },
    "substitute_component": {
        "applies": [COMPONENT_UNSUPPORTED, FOOTPRINT_MISMATCH, SOURCING],
        "precondition": "an approved equivalent preserving value/interface exists",
        "effect": "swap to a supportable equivalent",
        "risks": "function drift", "preserves_function": True,
        "requires_approval": True, "auto": False,
    },
    "substitute_mcu": {
        "applies": [MCU_UNFIT, PIN_ALLOCATION],
        "precondition": "a qualifying MCU exists",
        "effect": "use an MCU that meets the requirements",
        "risks": "firmware target change", "preserves_function": True,
        "requires_approval": True, "auto": False,      # handled by the MCU engine
    },
    "rerun_allocator": {
        "applies": [PIN_ALLOCATION],
        "precondition": "reserve debug/boot pins and retry allocation",
        "effect": "resolve the pin conflict without changing the MCU",
        "risks": "may still not fit", "preserves_function": True,
        "requires_approval": False, "auto": True,
    },
    "add_missing_passive": {
        "applies": [MISSING_PASSIVE],
        "precondition": "the datasheet/contract names the required passive",
        "effect": "add the required support part",
        "risks": "value must be correct", "preserves_function": True,
        "requires_approval": False, "auto": True,
    },
    "match_pair_length": {
        "applies": [HIGHSPEED_PAIR_FAIL],
        "precondition": "a routed diff pair failed length/skew",
        "effect": "add a length-match meander to the shorter member + re-check "
                  "(never relax a REQUIRED high-speed constraint)",
        "risks": "board space", "preserves_function": True, "requires_approval": False,
        "auto": True,
    },
    "move_endpoints_closer": {
        "applies": [HIGHSPEED_PAIR_FAIL],
        "precondition": "connector/ESD/PHY can be placed nearer the pair endpoints",
        "effect": "shorten + symmetrize the pair route",
        "risks": "placement fit", "preserves_function": True, "requires_approval": False,
        "auto": True,
    },
    "mark_unsupported": {
        "applies": [FINE_PITCH_ESCAPE, KEEPOUT_PLACEMENT, HIGH_SPEED_UNSUPPORTED,
                    HIGHSPEED_PAIR_FAIL, UNCONNECTED, ERC, CLEARANCE, PIN_ALLOCATION,
                    COMPONENT_UNSUPPORTED],
        "precondition": "no auto strategy resolved the failure",
        "effect": "stop and report an honest, specific blocker (never a fake pass)",
        "risks": "none — this is the honest terminal state", "preserves_function": True,
        "requires_approval": False, "auto": True, "terminal": True,
    },
}

# per-failure ordered strategy preference (cheapest/safest auto first, terminal last)
_ORDER = {
    FINE_PITCH_ESCAPE: ["increase_spacing", "rotate_component", "enlarge_board",
                        "alternate_footprint", "mark_unsupported"],
    CLEARANCE: ["increase_spacing", "enlarge_board", "mark_unsupported"],
    KEEPOUT_PLACEMENT: ["move_to_edge", "enlarge_board", "rotate_component",
                        "mark_unsupported"],
    UNCONNECTED: ["increase_spacing", "enlarge_board", "mark_unsupported"],
    PIN_ALLOCATION: ["rerun_allocator", "substitute_mcu", "mark_unsupported"],
    MCU_UNFIT: ["substitute_mcu", "mark_unsupported"],
    FOOTPRINT_MISMATCH: ["alternate_footprint", "substitute_component", "mark_unsupported"],
    COMPONENT_UNSUPPORTED: ["substitute_component", "mark_unsupported"],
    MISSING_PASSIVE: ["add_missing_passive", "mark_unsupported"],
    HIGH_SPEED_UNSUPPORTED: ["mark_unsupported"],
    HIGHSPEED_PAIR_FAIL: ["match_pair_length", "move_endpoints_closer", "mark_unsupported"],
    ERC: ["mark_unsupported"],
    SOURCING: ["substitute_component", "mark_unsupported"],
}

_PHASE8 = {FINE_PITCH_ESCAPE: "fine-pitch fanout / escape routing",
           KEEPOUT_PLACEMENT: "keepout-aware placement",
           HIGH_SPEED_UNSUPPORTED: "controlled-impedance / high-speed routing"}


def phase8_capability(failure_type):
    return _PHASE8.get(failure_type)


def rank(failures):
    """Return an ordered list of {strategy, failure, meta} plans to try. The
    primary (highest-severity) failure drives the plan; ties break to fine-pitch/
    keepout first."""
    if not failures:
        return []
    prio = {FINE_PITCH_ESCAPE: 0, KEEPOUT_PLACEMENT: 0, PIN_ALLOCATION: 1,
            MCU_UNFIT: 1, CLEARANCE: 2, UNCONNECTED: 2}
    primary = sorted(failures, key=lambda f: (prio.get(f["type"], 3),))[0]
    plans = []
    for name in _ORDER.get(primary["type"], ["mark_unsupported"]):
        s = STRATEGIES[name]
        plans.append({"strategy": name, "failure": primary, "meta": s,
                      "auto": s.get("auto", False)})
    return plans
