# RFQ — FirstLight FL-1, EVT Build (Qty 1 + Spares)

Date: 2026-06-11 · Program: FirstLight FL-1 autonomous PCB bring-up station
· Phase: EVT (engineering validation) · Buyer contact: Jack Al-Kahwati

## 1. Scope

Quotation requested for the fabricated parts in `fl1-evt-fab-rfq.csv`
(57 line items: CNC machined, sheet metal, cut extrusion, cut acrylic, and
printed parts). The COTS list (`fl1-evt-cots-buy.csv`, 61 lines) is included
for reference and may be quoted by distributors as a kit; instruments will
be purchased directly.

Quantities: **EVT qty 1** plus noted spares. Please also quote price breaks
at qty 5 and qty 25 (DVT/pilot forecast) on machined and sheet items.

## 2. Reference data

| File | Content |
|---|---|
| `cad/electronics-bringup-station/Part_Studio_1_v5.step` | Full machine STEP (AP203), part names match RFQ descriptions |
| `fl1-evt-fab-rfq.csv` | Fab line items: PN, qty, material, process, envelope, finish |
| `fl1-evt-cots-buy.csv` | COTS buy list: vendor, PN, qty |
| `docs/images/fl1-*.png` | Orientation renders |

Quote is **to 3D model + this spec** (2D drawings follow at DVT). Part
geometry is extracted from the STEP by the part names listed in the
`ref_parts` column.

## 3. General specifications

- Tolerances (unless noted): **ISO 2768-mK**. Machined datum faces flat
  within 0.05 mm. Rail-mounting surfaces (Instrument Deck, Probe Mount Arm,
  motor plates, saddles): flat within 0.02 mm over the rail span, tapped
  hole patterns true position 0.1 mm.
- Press-fit bores (dowel/guide-pin): H7. Dowels supplied as COTS.
- Threads: metric coarse, tapped through unless depth noted in model.
- Deburr all edges; break sharp corners 0.2-0.5 mm.
- Finishes per CSV `finish` column: clear anodize Type II (machined 6061),
  matte black powder coat interior sheet metal, black oxide alloy steel,
  passivation for stainless, smoked tint on PMMA glazing.
- Cosmetic Class A surfaces: Side Shells, Top Slab, Plinth Fascia, glass —
  no tool marks on exterior faces; EVT shells may be CNC from solid (molded
  at production; quote accordingly).
- Material certs on request for load-path parts; no ITAR content.

## 4. Known quantity caveats (buyer will confirm at PO)

- Pogo probe line items count tip/body/bushing CAD bodies separately —
  procurement quantity is **4 complete spring-probe assemblies + 4 spares**.
- Instruments (PicoScope, DMM6500, DP832, SDL1030X, Joulescope, Saleae,
  MCC, LabJack, Galil, control PC) are buyer-furnished — listed for kit
  completeness only.
- `EE-FAB-MISC` lines are distinct one-off machined parts disambiguated by
  envelope dimensions; treat each line as its own part.

## 5. Quote requested

1. Unit price per line at qty 1 / 5 / 25, tooling/setup separated.
2. Lead time per line; flag anything over 3 weeks.
3. Suggested cost-downs welcome (material substitutions, process changes) —
   quote baseline first, alternates separately.
4. Validity: 60 days. Incoterms: FOB origin. Payment: net 30.

## 6. Confidentiality

This package is confidential to the quoting party. The design is
pre-release; do not share outside your organization. NDA available on
request before transmittal of the STEP file.
