# Evidence pack — TXB0102 multi-rail chip-down (M6 domain-aware rails)

*scope: run · generated 2026-07-08T08:42:38.965Z · reproducible
from `public/runs/chipdown-txb0102-v1`*

## 1. Executive summary
TXB0102 multi-rail chip-down (M6 domain-aware rails): highest PROVEN state is 'package_ready'; 2 blocked claim(s); physical evidence ledger EMPTY

**State ladder:** [x] designed · [x] routed · [x] drc_erc_clean · [ ] externally_analyzed · [x] package_ready · [ ] quote_approved · [ ] physically_built · [ ] physically_validated · [ ] production_ready

## 2-4. Intent
- Prompt: Level shifter
- Board class: M6 Multi-Rail Chip-Down: TXB0102DCU

## 5-7. Artifacts
- PCB artifacts: B.Cu.svg, Edge.Cuts.svg, F.Cu.svg, F.SilkS.svg, In1.Cu.svg, In2.Cu.svg, render-bottom.png, render-top.png
- BOM: public/runs/chipdown-txb0102-v1/data/bom.json
- Manufacturing package: assembly-readiness.json, assembly-readiness.md, bom.csv, bom.json, pick_and_place.csv, sourcing-report.json

## 8-11. Engineering evidence
- DRC hard violations: 0 ·
  unconnected: 0 · ERC: passed
- Router evidence: routed_in_sandbox (all nets)
- flroute fixture coverage: {"full_suite":"21/21","realboard":"3/3"}
- External EDA: "not generated"

## 13. Missing models/tools/stackup
- stackup: none in repo — controlled impedance blocked
- ibis: none in repo — SI claims blocked
- openEMS: not installed — RF solver analyses unavailable

## 16. Physical evidence ledger
- Items: 0 ·
  order status: not_ordered ·
  accepted physical evidence: 0

## 17. Human approvals
- none

## 18. Blocked claims (never hidden)
- physical validation (no accepted physical evidence)
- production readiness (no yield/manufacturing evidence)

## 19-21. Review + manual steps
- none
- manual: human review of the manufacturing package
- manual: quote approval (human decision)
- manual: quote submission is MANUAL — never automatic
- manual: physical evidence upload + review after build

## 22-23. State + next
- Readiness: **routed_in_sandbox**
- Next: request board_review_approval; generate quote packet (human-gated)

---
this pack reports what artifacts prove; designed != routed != validated != production-ready; blocked claims are load-bearing
