# M7-M12 pre-hardening draft work — QUARANTINED

Built after M6 but BEFORE the M3A/M3B infrastructure hardening sprint.
NOT accepted as roadmap-complete. To be REPLAYED through the hardened
router-regression and external-EDA evidence layers before acceptance.

Contents (all tests were green at quarantine time, against pre-hardening
infrastructure):
- planner/advanced_fab.py + test_m8.py       (M8 draft: fab class gates)
- planner/power_stage.py, rf_rules.py, highspeed_rules.py,
  reliability_classes.py + test_m9_m12.py    (M9-M12 draft gates)
- planner/test_m7.py + scripts/gen_m7.py     (M7 draft: BGA verified part)
- scripts/gen_m8.py, gen_m9_m12.py

NOTE: one piece of M7 work is NOT here because it was legitimately committed
with M6 (shared file): the BGA ball-name pin sort in
hardware/planner/chipdown_synthesis.py. It is a parser correctness fix, not
an M7 capability acceptance.
