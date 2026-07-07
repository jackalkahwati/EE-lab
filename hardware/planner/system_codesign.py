"""Phase 19 — multi-board + electromechanical co-design model for the FL-1
modular machine. Engineering CONCEPT layer: no certification, safety, EMC, or
thermal compliance claims; unknowns marked; the six plugin boards stay
review-required and unmodified.
"""

BOARDS = [
    ("controller_backplane", "Controller / Backplane v2.1", "fl1-core-controller-v21", 0),
    ("digital_bringup", "Digital Bring-up v2.1", "fl1-core-digital-v21", 1),
    ("relay_probe_matrix", "Relay / Probe Matrix v2.1", "fl1-core-relay-v21", 2),
    ("calibration_reference", "Calibration / Reference v2", "fl1-cal-board-v4", 3),
    ("external_instrument_interface", "External Instrument Interface EII-1", "fl1-eii1-v1", 4),
    ("power_current_monitor", "Power / Current Monitor PCM-1", "fl1-pcm1-v1", 5),
]


def system_architecture():
    return {
        "version": "v1", "concept": "modular six-card FL-1 machine on a passive "
        "six-slot bus-v2 backplane, open-frame first article",
        "modules": [
            {"module": name, "slot": slot, "i2c_identity": "0x5%d (slot strap)" % slot}
            for _r, name, _run, slot in BOARDS],
        "backplane": "FL-1 Passive Backplane v1 (REAL routed board, run "
                     "fl1-backplane-v1): 6x 2x07 bus-v2 slots, shared "
                     "power/I2C/FAULT/INTERLOCK/RST_OUT/TRIG, per-slot ID "
                     "straps 0x50-0x55, system I2C pull-ups, safety-line TPs",
        "dut_connection": "DUT adapter card (swappable) cabled to the relay/"
                          "probe matrix PROBEn header + PCM-1 DUT_V/SHUNT path "
                          "+ digital bring-up GPIO bank",
        "external_instruments": "EII-1 front edge: TTL UART header + trigger/"
                                "sync GPIO bank; COTS instruments keep their "
                                "own identity in evidence",
        "power": "single bench 5V entry on the backplane power inlet; each "
                 "card regulates/consumes per its own proven design",
        "calibration_access": "cal card REF_OUT/REF_DIV TPs face the service "
                              "side; cal chain reachable without removing cards",
        "service": "cards extract individually (vertical plug-in); identity "
                   "rescan after any swap",
        "unresolved": ["backplane connector is a 2x07 pin header (no keying/"
                       "polarization yet) — Rev B: keyed shrouded header",
                       "card retention (friction only) — Rev B: standoff rail",
                       "I2C pull-up stacking across populated cards (recorded "
                       "in pinout compatibility report)",
                       "no chassis/enclosure yet (open-frame first article)"],
    }


def slot_standard(envelopes):
    max_w = max(e["dimensions_mm"][0] for e in envelopes)
    max_h = max(e["dimensions_mm"][1] for e in envelopes)
    return {
        "version": "v1",
        "styles_compared": [
            {"style": "backplane with vertical plugin cards (RECOMMENDED)",
             "why": "matches the bus-v2 slot-strap design; per-card service; "
                    "smallest bench footprint"},
            {"style": "horizontal card stack", "why_not": "stacking blocks TP access"},
            {"style": "motherboard + flat daughtercards",
             "why_not": "consumes bench area; cable exits collide"},
            {"style": "fixture-adjacent module row",
             "why_not": "long bus cabling; noise + skew"}],
        "slot": {"count": 6, "pitch_mm": 30.0,
                 "max_board_w_mm": round(max_w, 1), "max_board_h_mm": round(max_h, 1),
                 "mounting": "M3 standoffs at the 7mm-inset corner holes "
                             "(already on every board) + backplane header",
                 "standoff_height_mm": 8, "component_height_max_mm": 15,
                 "connector_side": "bottom edge (bus header) toward backplane",
                 "access_side": "top edge: TPs + DUT/instrument connectors",
                 "keepouts": "3mm around bus header; 2mm around mounting holes",
                 "extraction": "vertical pull; no tools; power off first"},
        "note": "boards are heterogeneous sizes today — the slot standard sets "
                "the ENVELOPE; Rev B may normalize card outlines",
    }


def fixture_options():
    opts = [
        ("cable harness to DUT", 0.8, 0.9, 0.8, 0.4, 0.9, "LOW",
         "flexible + cheap; repeatability poor"),
        ("pogo-pin bed / fixture plate", 0.6, 0.4, 0.5, 0.9, 0.3, "MEDIUM",
         "best repeatability; per-DUT tooling cost + mechanical design"),
        ("edge-connector DUT adapter", 0.5, 0.7, 0.6, 0.8, 0.6, "LOW",
         "only fits edge-connector DUTs"),
        ("swappable DUT adapter card (RECOMMENDED)", 0.9, 0.8, 0.9, 0.7, 0.7, "LOW",
         "per-DUT adapter carries the wiring; system side stays fixed; adapters "
         "are cheap boards Compose can generate"),
        ("hybrid relay/probe harness", 0.7, 0.7, 0.7, 0.5, 0.7, "LOW",
         "interim: harness + probe clips through the relay matrix"),
    ]
    return {"version": "v1", "options": [
        {"option": o, "flexibility": f, "manufacturability": m, "debug_access": d,
         "repeatability": r, "cost_score": c, "mechanical_risk": k, "note": n}
        for o, f, m, d, r, c, k, n in opts],
        "recommendation": "swappable DUT adapter card for first articles, with "
                          "the hybrid harness as the day-one interim",
        "interlock": "fixture removal opens INTERLOCK -> controller drops relay "
                     "enable (SR_OE) — behavior defined, validated at bring-up",
        "esd": "wrist-strap + dissipative mat assumption; no ESD-safe claim"}


def grounding():
    return {"version": "v1",
            "strategy": [
                "single system GND plane through the backplane; each card keeps "
                "its own proven GND/3V3 plane stack",
                "cal/reference card sits in slot 3, one slot away from the relay "
                "card's coil switching (slot 2) — partitioning by slot order",
                "DUT power return enters ONLY via PCM-1's shunt path, never "
                "through the cal card's slot region",
                "external instrument grounds meet at the EII-1 connector zone; "
                "COTS instruments are earth-referenced — ground-loop risk "
                "recorded as an unknown until measured",
                "chassis/shield: OPEN QUESTION for the open-frame first article "
                "(no chassis); enclosure phase will define the single tie point",
                "USB shield: service-laptop USB floats via the Pico module "
                "convention; no shield tie on cards"],
            "honesty": ["no EMC compliance claim", "no low-noise performance "
                        "claim without measurement", "no isolation claim "
                        "(none implemented)", "unknowns marked"]}


def power_architecture():
    return {"version": "v1",
            "input": "bench 5V DC via backplane power inlet (2-pin header, "
                     "labeled); NO mains anywhere in the system",
            "rails": {"+5V": "backplane-distributed to all slots",
                      "+3V3": "regulated per card (Pico module 3V3OUT — proven "
                              "per-board design unchanged)"},
            "current_assumptions": {"relay card peak": "~4 coils x ~70mA + logic "
                                    "(dominant load)", "other cards": "<150mA each",
                                    "system budget": "~1.5A at 5V, conservative"},
            "protection": "bench supply current limit is the FIRST-ARTICLE "
                          "protection; inline fuse on the backplane inlet is the "
                          "recorded recommendation before routine use",
            "sequencing": "single 5V rail — no sequencing needed; cards boot "
                          "safe (relay SR_OE, GPIO high-Z designs already gated)",
            "estop_interlock": "INTERLOCK line on the bus; controller policy "
                               "drops relay enable + flags FAULT",
            "dut_power": "monitor-only through PCM-1 (0-24V/0-500mA labeled); "
                         "programmable DUT power control remains "
                         "architecture_only — NO PSU claim",
            "honesty": ["no programmable-PSU claim", "no high-current claim",
                        "no high-voltage claim", "no safety certification claim"]}


def thermal():
    return {"version": "v1", "label": "ENGINEERING CONCEPT — no thermal "
            "compliance or validated-cooling claim",
            "heat_sources": [
                {"board": "Relay / Probe Matrix", "source": "4 relay coils + "
                 "ULN2803 (only when channels held closed)", "risk": "LOW-MED"},
                {"board": "PCM-1", "source": "shunt I^2R at sustained current",
                 "risk": "LOW (bounded by 0402 budget; bring-up thermal check)"},
                {"board": "all", "source": "Pico module regulator", "risk": "LOW"}],
            "system": {"airflow": "passive convection, vertical cards = natural "
                       "chimneys; open frame needs no fan at these loads",
                       "spacing": "30mm slot pitch leaves >20mm air gaps",
                       "sensors": "none fitted; bring-up uses IR spot checks",
                       "test": "thermal spot-check workflow in system validation"}}


def enclosure():
    return {"version": "v1",
            "options": [
                {"option": "open-frame engineering fixture (RECOMMENDED)",
                 "why": "fastest, full TP/debug access, matches first-article "
                        "intent; safety label set required"},
                {"option": "benchtop enclosure", "why_not_now": "blocks probe "
                 "access during bring-up; right for Rev B"},
                {"option": "card-cage", "why_not_now": "tooling cost before the "
                 "slot standard is proven"},
                {"option": "drawer/fixture style", "why_not_now": "premature "
                 "before the DUT adapter card exists"}],
            "open_frame": {"footprint_mm": [220, 200, 120],
                           "base": "aluminum plate + M3 standoffs",
                           "front": "EII-1 instrument headers + DUT area face the operator",
                           "labels": "5V ONLY / MONITOR-ONLY / relay channel map",
                           "service": "any card extracts vertically without "
                                      "removing others"}}


def workflows():
    assembly = ["inspect boards (incoming criteria)", "mount standoffs to plate",
                "install backplane", "install controller (slot 0)",
                "install remaining cards (slots 1-5)", "connect DUT harness",
                "verify slot straps (visual)", "power-on WITHOUT DUT",
                "identity scan 0x50-0x55", "system self-test",
                "install DUT fixture/adapter", "fixture validation",
                "mock DUT bring-up + ledger entry"]
    service = ["identify failed board (per-board validation + failure domains)",
               "power down", "extract module vertically", "replace module",
               "rescan identities (slot strap gives the SAME address to the "
               "replacement)", "rerun that board's validation workflow",
               "append service entry to the evidence ledger (never rewrite)"]
    return {"assembly": assembly, "service": service}


def validation_plan():
    return {"version": "v1", "stages": [
        {"stage": "backplane identity scan", "checks": ["all installed boards "
         "detected", "slot straps verified", "no identity conflicts"]},
        {"stage": "power-on sequence", "checks": ["current-limited 5V", "rails "
         "present on every card", "no unexpected draw"]},
        {"stage": "bus enumeration", "checks": ["I2C devices (EEPROMs 0x50-0x55, "
         "ADCs 0x48/0x49)", "UART paths", "trigger/sync", "fault/interlock/reset"]},
        {"stage": "relay/probe matrix", "checks": ["default disconnected",
         "route/disconnect channel", "continuity"]},
        {"stage": "calibration/reference", "checks": ["REF_OUT sanity", "ADC "
         "readback", "NO calibration claim without physical evidence"]},
        {"stage": "power/current monitor", "checks": ["V sense sanity", "I sense "
         "sanity", "monitor-only limits"]},
        {"stage": "digital bring-up", "checks": ["UART/I2C/SPI/GPIO loopback"]},
        {"stage": "external instrument interface", "checks": ["TTL loopback",
         "trigger safe at boot", "mock COTS command"]},
        {"stage": "full mock DUT bring-up", "checks": ["DUT power path disabled "
         "by default", "relay path connect", "digital read", "current monitor",
         "evidence logged", "safe shutdown"]}],
        "evidence": ["append-only ledger", "per-board serials", "system serial",
                     "run IDs", "simulated vs physical separation",
                     "failed evidence preserved"]}


def traceability():
    return {"version": "v1",
            "fields": ["system_serial (FL1-SYS-V1-NNNN)", "installed board "
                       "serials", "slot assignments", "board revisions",
                       "firmware versions", "calibration states",
                       "validation states", "package hashes", "assembly date",
                       "operator", "ledger links", "service history",
                       "replaced modules", "system configuration hash"],
            "lifecycle": ["architecture_defined", "assembly_planned",
                          "awaiting_boards", "boards_received",
                          "assembly_in_progress", "assembled",
                          "system_validation_pending", "system_validation_passed",
                          "system_validation_failed", "service_required", "retired"],
            "current_state": "architecture_defined (nothing ordered)"}


def costdown_roadmap():
    return {"version": "v1",
            "now": "modular six-card system on the passive backplane — the ONLY "
                   "first-article path (full gate evidence)",
            "later": [
                {"step": "Core-6 monolithic with Pico module", "status":
                 "routed clean in Phase 18.8 (51/51, 0 DRC, role 16/16) — "
                 "credible Rev C cost-down AFTER the modular system works"},
                {"step": "bare RP2040 migration", "status": "blocked by ONE "
                 "capability: quadrant-aware QFN-56 escape planning; then a "
                 "small RP2040 core test board with PHYSICAL bring-up before "
                 "any card migrates"},
                {"step": "what can merge later", "status": "controller + digital "
                 "+ EII (pure digital) merge lowest-risk; cal/reference merges "
                 "LAST (noise partitioning must be measured first)"},
                {"step": "what stays external COTS", "status": "scope, funcgen, "
                 "logic-analyzer timing, RF — unchanged by any cost-down"}],
            "rule": "monolithic evidence is FUTURE cost-down evidence only — "
                    "never the current product architecture"}


def system_manufacturing(envelopes):
    return {"version": "v1",
            "quote_checklist": ["7 PCBAs (6 cards review-required + backplane "
                                "review-required)", "mechanical parts", "cables",
                                "labels/QRs"],
            "mechanical_bom": ["M3x8 standoffs x28", "M3 screws/nuts",
                               "aluminum base plate 220x200", "2x07 socket "
                               "headers x6 (backplane mating)", "DUT harness "
                               "(interim)", "safety label set"],
            "cable_list": ["DUT harness (PROBEn + DUT_V/SHUNT + GPIO)",
                           "instrument TTL/trigger cables", "bench 5V lead"],
            "labor_placeholder": "assembly ~2h + validation ~2h per system "
                                 "(PLACEHOLDER, unverified)",
            "inspection": "per-board incoming criteria + system assembly "
                          "checklist", "packaging": "n/a until a system ships",
            "honesty": "board order recommendations unchanged; system not "
                       "production-ready; nothing ordered"}


def risk_register():
    rows = [
        ("2x07 pin header has no keying — reversed card insertion", "high", "medium",
         "Rev B keyed shrouded connector; v1: silk pin-1 marks + assembly checklist"),
        ("I2C pull-up stacking across populated cards", "medium", "high",
         "recorded in pinout compatibility report; card-side DNP option in Rev B; "
         "bench-verify bus levels at first assembly"),
        ("card retention is friction-only", "medium", "medium",
         "standoff rail in Rev B; v1 open-frame is stationary"),
        ("ground loops via earth-referenced COTS instruments", "medium", "medium",
         "single-point instrument ground at EII zone; measure at bring-up"),
        ("relay coil noise vs cal reference", "medium", "medium",
         "slot ordering partitioning; measure before any accuracy claim"),
        ("bench 5V supply misconfiguration", "medium", "low",
         "current-limit procedure + inline fuse recommendation"),
        ("DUT harness (interim) repeatability", "low", "high",
         "swappable DUT adapter card is the planned fix"),
        ("no enclosure: exposed conductors", "medium", "medium",
         "open-frame safety labels + bench discipline; enclosure in Rev B"),
    ]
    return {"version": "v1", "risks": [
        {"risk": r, "severity": s, "likelihood": l, "mitigation": m,
         "owner": "Jack (review) / Compose (evidence)", "review_required": s == "high"}
        for r, s, l, m in rows]}
