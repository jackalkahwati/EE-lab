# Quote workflow example (synthetic)

Board: Power Entry Header (real run artifacts, DRC clean)

History:
- quote_packet_ready — quote packet generated
- quote_approval_requested
- approved_for_quote

Packet contents: board_files, gerbers_drill, bom, pick_and_place, step, stackup_assumptions, drc_erc, router_evidence, review_required_labels, blocked_claims, special_fab_requirements, human_approval_snapshot

Note: state is approved_for_quote via an explicit procurement decision.
No quote was submitted; submission would require a human manual entry.
A received quote would NOT be physical evidence.
