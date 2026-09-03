"""Design-correctness tooling contract tests (design_check / functional_wire /
functional_sim / rule_match), run the way the pipeline runs them: as
subprocesses, asserting the stdout verdict line + exit code.

Contract under test (see each script's docstring):
    design_check     GATE PASS (0) | GATE FAIL <n> (1) | GATE ERROR <why> (2)
    functional_wire  FUNCWIRE <n> (0)                   | FUNCWIRE ERROR <why> (2)
    functional_sim   FUNCSIM PASS (0) | FUNCSIM FAIL <n> (1) | FUNCSIM SKIP 0 (0)
                     | FUNCSIM ERROR <why> (2)
A traceback is never acceptable output; a malformed spec is ERROR (exit 2), never
a verdict; an empty design is not a pass; functional_wire is idempotent.

Fixture: fixtures/chipscale-spec-run-901d519c.json is a verbatim copy of a real
pipeline run's data/chipscale-spec.json (RP2040 + ADS1115 + REF3025 + CD74HC4067
measurement front end, power/bus nets only — i.e. the state BEFORE
functional_wire adds the application signal chains).
"""
import json
import os
import shutil
import subprocess
import sys

import pytest

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "fixtures", "chipscale-spec-run-901d519c.json")
sys.path.insert(0, HERE)

from rule_match import match_rule, validate_spec, SpecError  # noqa: E402


def run(script, *args):
    """Run a planner script; return (exit_code, stdout_lines, stderr)."""
    p = subprocess.run([sys.executable, os.path.join(HERE, script), *args],
                       capture_output=True, text=True, timeout=120, cwd=HERE)
    return p.returncode, [l for l in p.stdout.splitlines() if l.strip()], p.stderr


def write(tmp_path, name, obj):
    p = tmp_path / name
    p.write_text(json.dumps(obj))
    return str(p)


def verdict(lines):
    return lines[-1] if lines else ""


NGSPICE = shutil.which("ngspice") or os.path.exists("/opt/homebrew/bin/ngspice")


# ---------------------------------------------------------------------------
# (a) the real spec
# ---------------------------------------------------------------------------
def test_fixture_is_clean_real_spec():
    d = json.load(open(FIXTURE))
    assert isinstance(d["parts"], list) and len(d["parts"]) == 13
    assert {p["mpn"] for p in d["parts"] if p.get("mpn")} == {"RP2040", "ADS1115IDGS", "REF3025", "CD74HC4067"}
    assert isinstance(d["gnd"], list) and d["gnd"]


def test_design_check_real_spec_gives_a_verdict_not_an_error():
    code, out, err = run("design_check.py", FIXTURE)
    v = verdict(out)
    assert v.startswith("GATE PASS") or v.startswith("GATE FAIL "), out
    assert code in (0, 1) and code == (0 if v == "GATE PASS" else 1)
    assert "Traceback" not in err
    if v.startswith("GATE FAIL "):
        n = int(v.split()[-1])
        assert n == sum(1 for l in out if "✗ FAIL" in l)


def test_design_check_real_spec_before_wiring_fails_on_broken_measurement_chain():
    # unwired front end: the mux COM does not reach the ADC -> a real FAIL
    code, out, _ = run("design_check.py", FIXTURE)
    assert code == 1
    assert any("measurement chain broken" in l for l in out)


def test_functional_sim_real_spec_gives_a_verdict_not_an_error(tmp_path):
    spec = str(tmp_path / "real.json")
    shutil.copy(FIXTURE, spec)
    code, out, err = run("functional_sim.py", spec)
    v = verdict(out)
    assert "Traceback" not in err
    assert not v.startswith("FUNCSIM ERROR") or "ngspice" in v, out
    if NGSPICE:
        assert v in ("FUNCSIM PASS",) or v.startswith("FUNCSIM FAIL "), out
        assert code in (0, 1)
        assert any(l.startswith("SIM reference-stability ") for l in out)


# ---------------------------------------------------------------------------
# (b) empty spec — two shapes: no 'parts' key at all vs an empty parts list
# ---------------------------------------------------------------------------
def test_empty_object_is_error_exit_2_everywhere(tmp_path):
    spec = write(tmp_path, "empty.json", {})
    for script, tag in (("design_check.py", "GATE"), ("functional_wire.py", "FUNCWIRE"), ("functional_sim.py", "FUNCSIM")):
        code, out, err = run(script, spec)
        assert code == 2, (script, out, err)
        assert verdict(out).startswith(f"{tag} ERROR ") and "parts" in verdict(out), (script, out)
        assert "Traceback" not in err


def test_empty_parts_list_is_gate_fail_1_no_parts(tmp_path):
    spec = write(tmp_path, "noparts.json", {"parts": [], "nets": [], "gnd": []})
    code, out, _ = run("design_check.py", spec)
    assert code == 1
    assert verdict(out) == "GATE FAIL 1"
    assert any("no parts" in l for l in out)


def test_empty_parts_list_funcsim_is_skip_0_exit_0_not_pass(tmp_path):
    spec = write(tmp_path, "noparts.json", {"parts": [], "nets": [], "gnd": []})
    code, out, _ = run("functional_sim.py", spec)
    assert code == 0
    assert verdict(out).startswith("FUNCSIM SKIP 0")
    assert not any(l == "FUNCSIM PASS" for l in out)


def test_empty_parts_list_funcwire_adds_0(tmp_path):
    spec = write(tmp_path, "noparts.json", {"parts": [], "nets": [], "gnd": []})
    code, out, _ = run("functional_wire.py", spec)
    assert code == 0 and verdict(out) == "FUNCWIRE 0"


# ---------------------------------------------------------------------------
# (c) gnd: null   (d) nameless part  -> ERROR exit 2, never a traceback
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("script,tag", [("design_check.py", "GATE"), ("functional_wire.py", "FUNCWIRE"), ("functional_sim.py", "FUNCSIM")])
def test_gnd_null_is_error(tmp_path, script, tag):
    spec = write(tmp_path, "gndnull.json", {"parts": [{"name": "U1", "mpn": "RP2040"}], "nets": [], "gnd": None})
    code, out, err = run(script, spec)
    assert code == 2, (out, err)
    assert verdict(out).startswith(f"{tag} ERROR ") and "gnd" in verdict(out)
    assert "Traceback" not in err and "Traceback" not in "\n".join(out)


@pytest.mark.parametrize("script,tag", [("design_check.py", "GATE"), ("functional_wire.py", "FUNCWIRE"), ("functional_sim.py", "FUNCSIM")])
def test_nameless_part_is_error(tmp_path, script, tag):
    spec = write(tmp_path, "noname.json", {"parts": [{"mpn": "RP2040"}], "nets": [], "gnd": []})
    code, out, err = run(script, spec)
    assert code == 2, (out, err)
    assert verdict(out).startswith(f"{tag} ERROR ") and "name" in verdict(out)
    assert "Traceback" not in err


def test_functional_wire_error_leaves_spec_file_untouched(tmp_path):
    p = tmp_path / "noname.json"
    raw = json.dumps({"parts": [{"mpn": "RP2040"}], "nets": [], "gnd": None})
    p.write_text(raw)
    code, _, _ = run("functional_wire.py", str(p))
    assert code == 2 and p.read_text() == raw


def test_unreadable_spec_is_error_not_traceback(tmp_path):
    p = tmp_path / "bad.json"
    p.write_text("{not json")
    for script, tag in (("design_check.py", "GATE"), ("functional_wire.py", "FUNCWIRE"), ("functional_sim.py", "FUNCSIM")):
        code, out, err = run(script, str(p))
        assert code == 2 and verdict(out).startswith(f"{tag} ERROR "), (script, out)
        assert "Traceback" not in err
    code, out, _ = run("design_check.py", str(tmp_path / "missing.json"))
    assert code == 2 and verdict(out).startswith("GATE ERROR ")


def test_rules_db_missing_keys_is_error(tmp_path):
    spec = str(tmp_path / "real.json")
    shutil.copy(FIXTURE, spec)
    rules = write(tmp_path, "rules.json", {"ics": {}})   # no 'generic'
    code, out, err = run("design_check.py", spec, rules)
    assert code == 2 and verdict(out).startswith("GATE ERROR ") and "generic" in verdict(out)
    assert "Traceback" not in err
    code, out, _ = run("functional_wire.py", spec, rules)
    assert code == 2 and verdict(out).startswith("FUNCWIRE ERROR ")


# ---------------------------------------------------------------------------
# (e) functional_wire idempotency: run twice, second run adds 0
# ---------------------------------------------------------------------------
def test_functional_wire_twice_second_run_adds_nothing(tmp_path):
    spec = str(tmp_path / "wire.json")
    shutil.copy(FIXTURE, spec)
    code1, out1, _ = run("functional_wire.py", spec)
    assert code1 == 0
    n1 = int(verdict(out1).split()[-1])
    assert n1 > 0, out1
    after1 = json.load(open(spec))
    nets1 = [list(n) for n in after1["nets"]]

    code2, out2, _ = run("functional_wire.py", spec)
    assert code2 == 0
    assert verdict(out2) == "FUNCWIRE 0", out2
    after2 = json.load(open(spec))
    assert after2["nets"] == nets1
    assert len(after2["parts"]) == len(after1["parts"])

    # Among the nets functional_wire ADDED (the fixture's own rail nets are
    # pairwise and legitimately repeat a power pin), no pin is wired twice and
    # no pre-existing or ground pin was re-used: the mux select lines are each
    # driven by exactly ONE MCU pin (the old bug tied two MCU outputs to one mux
    # pin on the second run).
    original = json.load(open(FIXTURE))
    pre_pins = {pin for net in original["nets"] for pin in net} | set(original["gnd"])
    added = [net for net in after2["nets"] if net not in original["nets"]]
    assert len(added) == len(after2["nets"]) - len(original["nets"])
    seen = {}
    for i, net in enumerate(added):
        for pin in net:
            assert pin not in seen, f"{pin} appears in added nets {seen[pin]} and {i}"
            assert pin not in pre_pins, f"{pin} already carried a net / ground before wiring"
            seen[pin] = i


def test_functional_wire_makes_the_gate_pass_and_stays_passing(tmp_path):
    spec = str(tmp_path / "wire.json")
    shutil.copy(FIXTURE, spec)
    assert run("functional_wire.py", spec)[0] == 0
    code, out, _ = run("design_check.py", spec)
    assert code == 0 and verdict(out) == "GATE PASS", out
    assert run("functional_wire.py", spec)[1][-1] == "FUNCWIRE 0"
    code, out, _ = run("design_check.py", spec)
    assert code == 0 and verdict(out) == "GATE PASS", out


# ---------------------------------------------------------------------------
# shared MPN -> rule lookup: consistent across the three tools
# ---------------------------------------------------------------------------
RULES = {"ics": {"REF3025": {"class": "reference"}, "ADS1115IDGS": {"class": "adc"},
                 "RP2040": {"class": "mcu"}, "CD74HC4067": {"class": "mux"}}}


@pytest.mark.parametrize("mpn,cls", [
    ("REF3025", "reference"), ("ref3025 ", "reference"),          # exact, case/space
    ("REF3025AIDBZR", "reference"),                                 # family (key prefix)
    ("ADS1115", "adc"), ("ADS1115IDGST", "adc"),                    # truncated / family
    ("PICO-RP2040-MODULE", "mcu"), ("RP2040_PICO", "mcu"),          # token
    ("REF30251", "reference"),   # family-prefix tier: any key-prefixed MPN is that family
])
def test_match_rule_hits(mpn, cls):
    assert match_rule(mpn, RULES)["class"] == cls
    assert match_rule(mpn, RULES["ics"])["class"] == cls        # flat table too


@pytest.mark.parametrize("mpn", ["R", "C", "REF", "ADS1", "", None, 42, "XYZ9999"])
def test_match_rule_misses(mpn):
    # short reverse-substrings ("R" in "REF3025") used to match — they must not
    assert match_rule(mpn, RULES) is None


def test_renamed_reference_is_seen_by_gate_and_sim_alike(tmp_path):
    """REF3025 -> REF3025AIDBZR (orderable part number) must not drop out of the
    sim while passing the gate — the old exact-dict lookup did exactly that."""
    spec = str(tmp_path / "wire.json")
    shutil.copy(FIXTURE, spec)
    assert run("functional_wire.py", spec)[0] == 0
    d = json.load(open(spec))
    for p in d["parts"]:
        if p["name"] == "U3":
            p["mpn"] = "REF3025AIDBZR"
    json.dump(d, open(spec, "w"))
    code, out, _ = run("design_check.py", spec)
    assert code == 0 and verdict(out) == "GATE PASS"
    if NGSPICE:
        code, out, _ = run("functional_sim.py", spec)
        assert any(l.startswith("SIM reference-stability ") for l in out), out
        assert "reference" in next(l for l in out if l.startswith("# functional_sim"))


def test_validate_spec_shapes():
    assert validate_spec({"parts": []}) == ([], [], [])
    with pytest.raises(SpecError):
        validate_spec([])
    with pytest.raises(SpecError):
        validate_spec({"parts": [{"name": ""}]})
    with pytest.raises(SpecError):
        validate_spec({"parts": [], "nets": [["U1"]]})
    with pytest.raises(SpecError):
        validate_spec({"parts": [], "gnd": "U1.1"})


def test_help_flags_print_usage_and_exit_2():
    for script in ("design_check.py", "functional_wire.py", "functional_sim.py"):
        code, out, err = run(script, "--help")
        assert code == 2 and "usage:" in err and not out, script
        code, out, err = run(script)
        assert code == 2 and "usage:" in err


def test_plan_cli_help_is_not_a_prompt():
    p = subprocess.run([sys.executable, os.path.join(HERE, "plan_cli.py"), "--help"],
                       capture_output=True, text=True, timeout=60, cwd=HERE)
    assert p.returncode == 0
    assert p.stdout.startswith("usage:")
    assert "final_design" not in p.stdout.splitlines()[0]
