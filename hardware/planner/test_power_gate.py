"""The design gate must FAIL a board whose regulator output is on no net, whose
power pins lack decoupling, or whose input rail exceeds its parts with no
regulator — the boards that cannot power up."""
import os, sys, json
sys.path.insert(0, os.path.dirname(__file__))
import design_check, rule_match


def _rules():
    return rule_match.load_rules()


def _check(spec):
    r = design_check.check(spec, _rules())
    items = r.get("findings") if isinstance(r, dict) else r
    out = []
    for x in items or []:
        if isinstance(x, dict):
            if (x.get("severity") or x.get("sev")) == "fail": out.append(x)
        elif x and x[0] == "fail":
            out.append(x)
    return out


def _ldo_board(vout_wired=True, decap=True):
    parts = [{"name": "U2", "kind": "chip", "footprint": "sot23_5", "mpn": "AP2112K-3.3"},
             {"name": "C9", "kind": "chip", "footprint": "0402", "mpn": ""},
             {"name": "C10", "kind": "chip", "footprint": "0402", "mpn": ""},
             {"name": "J20", "kind": "connector", "footprint": "screwterminal_2", "mpn": "MX126-5.0-02P"}]
    nets = [["J20.1", "U2.1"], ["U2.1", "U2.3"]]
    if decap:
        nets.append(["U2.1", "C10.1"])
    if vout_wired:
        nets += [["U2.5", "C9.1"]]
    return {"parts": parts, "nets": nets, "gnd": ["U2.2", "C9.2", "C10.2", "J20.2"], "input_rail": "+5V"}


def test_regulator_output_on_no_net_fails():
    fails = _check(_ldo_board(vout_wired=False))
    assert any("OUTPUT pin 5 is on NO net" in str(f) for f in fails), fails


def test_wired_regulator_with_decoupling_passes_the_power_rules():
    fails = _check(_ldo_board())
    assert not any("OUTPUT pin" in str(f) or "decoupling" in str(f) for f in fails), fails


def test_missing_decoupling_fails():
    fails = _check(_ldo_board(decap=False))
    assert any("no decoupling capacitor" in str(f) for f in fails), fails


def test_input_rail_above_parts_without_regulator_fails():
    spec = _ldo_board(); spec["parts"] = [p for p in spec["parts"] if p["name"] != "U2"] + [{"name": "U3", "kind": "chip", "footprint": "qfn8", "mpn": "BME280"}]
    spec["nets"] = [["J20.1", "U3.8"], ["U3.8", "C9.1"], ["U3.6", "C10.1"]]; spec["gnd"] = ["U3.1", "U3.7", "C9.2", "C10.2", "J20.2"]; spec["input_rail"] = "+12V"
    fails = _check(spec)
    assert any("no regulator" in str(f) for f in fails), fails
