"""M10 — RF / Controlled-Impedance Rules v1. Architecture and gates only:
no impedance correctness without stackup + field-solver evidence, ever."""

RF_DETECT = ["SMA", "U.FL", "antenna", "RF", "coax", "2.4GHz", "915MHz",
             "LoRa antenna path"]

REQUIREMENTS = {
    "controlled_impedance": "stackup definition + field-solver evidence + "
                            "fab impedance coupon — ALL ABSENT",
    "rf_launch": "connector launch geometry review — ABSENT",
    "keepouts": "ground keepout/stitching pattern per structure — model only",
    "matching": "antenna matching network placeholders only — values need "
                "VNA evidence",
}
BLOCKED = ["impedance_correctness", "antenna_performance", "RF_compliance",
           "EMC", "link_budget", "radiated_power"]


def rf_gate(board_text):
    hits = [k for k in RF_DETECT if k.lower() in board_text.lower()]
    if hits:
        return {"verdict": "architecture_only", "detected": hits,
                "requirements": REQUIREMENTS, "blocked_claims": BLOCKED,
                "note": "RF structures detected -> the board may place "
                        "connectors/keepout NOTES but claims nothing; "
                        "50-ohm routing is NOT claimed without solver + "
                        "coupon evidence"}
    return {"verdict": "no_rf_content", "detected": []}
