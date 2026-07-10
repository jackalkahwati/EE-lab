# First Light — Follow-up for Irina (VP)

**To:** Irina, VP  
**From:** Jack Al-Kahwati, First Light  
**Re:** Strategic direction, pricing, path to scale  
**Date:** July 2026

---

## 1. Stage (clear answer)

| Dimension | Status |
|-----------|--------|
| **Revenue** | Pre-revenue; bootstrapped |
| **Compose (software)** | Internally dogfooded on all FL-1 and customer-path boards; launching paid enterprise pilots Q3 2026 |
| **FL-1 (hardware)** | EVT complete; mechanical DFM-ready; founding units at $49,500; reservations open ($2,500 refundable deposit) |
| **Prior capital** | No outside capital on First Light; prior companies raised ~$3M |

**What exists today:** A working closed-loop stack — design interview → block-composed KiCad PCB → auto-route/DRC → BOM/fab package → firmware → FL-1 test plan. We use it daily to build our own instrument boards (relay matrix, DUT monitor, cal reference, backplane, IoT/telemetry boards).

**What is roadmap (honest):** Higher layer count, high-speed interfaces, and full spacecraft avionics classes — not claimed as shipped today.

---

## 2. North Star (one primary motion)

**Primary business:** Enterprise Compose — AI-native board synthesis for defense, space, and advanced hardware labs.

**Wedge:** FL-1 autonomous bring-up station — capex replacement for fragmented lab instruments, tightly integrated with Compose test plans.

**Attach:** Fab routing margin on boards designed and ordered through the platform.

We are **not** pursuing PLG at $49/month for production customers. Free tier remains for evaluation; production is sales-led.

---

## 3. What Compose designs today

Compose turns a natural-language block spec into a placed, routable KiCad board:

- **IoT / telemetry:** MCU + LoRa/GNSS/cellular + sensors (I2C, sourced from DigiKey + datasheets)
- **FL-1 instrument family:** Relay/probe matrix, DUT power monitor, calibration reference chain, instrument bus, board-ID EEPROM
- **Industrial blocks:** CAN transceiver, stepper driver, DC current monitor, motor PWM outputs
- **Outputs per run:** `.kicad_pcb`, BOM, fab package, firmware scaffold, `.devices.json` manifest, FL-1 test plan

Typical designs today: **4-layer**, block-composed embedded and instrument PCBs. Compound specs work (e.g. "IMU + temperature sensor + LoRa tracker").

---

## 4. Pricing (value-based, enterprise)

### Platform licenses (annual)

| Tier | Price | Buyer | Includes |
|------|-------|-------|----------|
| **Pilot** | $15,000 (90 days; credits toward Year 1) | Eval / single program | 5 board programs, onboarding |
| **Team** | $48,000/yr ($4,000/mo) | Startup lab, small prime team | 3 seats, 24 board programs/yr, support |
| **Enterprise** | $120,000–$150,000/yr | OEM, prime, gov lab | 10+ seats, 60+ programs, SLA, SSO |
| **Defense / ITAR** | $150,000–$350,000/yr | Space Force, classified programs | Dedicated env, compliance attestation |

*Not published on website. All production access via sales conversation and private offer.*

### Board program credits (usage)

| Complexity | Examples | Credits | Overage |
|------------|----------|---------|---------|
| Simple | MCU + power + 1–2 blocks | 1 | $2,000 |
| Standard | Multi-block IoT, FL-1 bus, relay matrix | 2–3 | $5,000 |
| Instrument | DUT monitor, cal ref, sourced ICs | 3–5 | $8,000 |
| Revision | Re-spin from prior program | 0.5 | $1,000 |

### Attach revenue

- **Fab routing:** 10% of PCB fab + assembly orders through Compose
- **FL-1 bundle:** $49,500 founding unit includes 12 months Team ($48k value)

### What we removed from GTM

- **$49/month Pro** for production use — kept only as optional hobby/student tier if needed; not marketed to enterprise ICP

---

## 5. ICP (initial focus)

**Primary:** Defense and space electronics labs — 5–50 board spins/year, $80k+ bench instrument capex (characterization labs run $150k–$300k), schedule pressure, ITAR/export sensitivity.

**Secondary:** Advanced hardware startups (robotics, autonomy, satcom payloads) and OEM innovation labs.

**Not initial ICP:** Consumer electronics at Apple/Toyota scale (future expansion; dilutes Year 1 focus).

**Economic buyer:** CFO, VP Ops, program manager — not the EE who uses the tool daily.

**Adoption note:** Engineers may resist ("NIH"); we sell time-to-market and capex reduction to budget holders, then enable EEs with pilot success.

---

## 6. Alternative cost (ROI anchor)

Per **one board program** (traditional vs First Light) — see attached ROI calculator.

**Traditional (in-house, moderate-complexity embedded/instrument board):**

- 1 senior EE × 2.5 months loaded @ $20k/mo → **$50,000**
- Test/fixture + contractor layout/firmware NRE → **$15,000**
- 2 fab spins @ $3,000 → **$6,000**
- Bench instruments ($80k capex, 5-yr amortized, spread across annual programs) → **~$1,300**
- **≈ $72,000 per program** (≈ $868k/yr at 12 programs)

**First Light (Enterprise, Year 1):**

- Enterprise Compose → **$120,000/yr**
- 60 board programs included
- FL-1 (one-time) → **$49,500**
- **≈ $172,500 Year 1** for the full annual run rate

At 12 programs/yr: **~$695k Year 1 savings, ~5× ROI, ~2.4-month payback**. Break-even vs traditional: **~2.5 programs/yr**. Value accelerates with every additional spin. (Defense-grade high-speed/RF programs run $150k–$200k+ each — use that framing only with primes who run that board class.)

**Benchmarks behind these assumptions** (verifiable, 2025–26):

- Fully loaded senior EE: $190k–$280k/yr (BLS ECEC benefits load ~30% on $150k–$200k base)
- Outsourced full board design program at firm rates: $25k–$60k (design-services published rates, ~250 hrs)
- Professional EDA seats: Altium Designer $3.5k–$7.5k/seat/yr (median org contract ~$18k, Vendr); high-end Cadence/Siemens enterprise seats $20k–$50k+
- Dev-tools enterprise SaaS median ACV: ~$85k (range $50k–$150k) — our Enterprise tier sits on-benchmark

---

## 7. Three business lines (chosen weighting)

| Line | Year 1 weight | Rationale |
|------|---------------|-----------|
| **Enterprise Compose SaaS** | 60% | Highest margin; funds everything; smallest ops footprint |
| **FL-1 hardware** | 25% | Capex + labor wedge; replaces $40k–$80k of bench instruments plus the engineer-hours to run them; pulls Compose into the lab |
| **Fab attach + services** | 15% | Scales with customer volume; margin without owning factory |

We are **not** open-sourcing Compose or selling FL-1 IP broadly (Bambu Lab model). We may offer **manufacture-as-a-service** for select partners (Tempo-style) while keeping the closed loop proprietary.

---

## 8. Moat / defensibility

1. **Closed-loop data:** Design + fab + bring-up + revision outcomes — not just schematic generation
2. **FL-1 validation corpus:** Test plans tied to composed boards; physical proof, not simulation-only
3. **Block library + sourcing pipeline:** Real parts, verified footprints, firmware manifests
4. **Compliance stack:** ITAR-aware workflows, SOC 2 path, customer IP isolation (no training on customer designs)
5. **Supply chain integration:** Design → quote → order in one flow
6. **Relationship density:** Defense/space logos and grant-funded credibility

---

## 9. Path to $100M (illustrative model)

**Year 1–2 (2026–2027):** Land logos

| Metric | Target |
|--------|--------|
| Team customers | 10 × $48k = $480k |
| Enterprise customers | 5 × $120k = $600k |
| FL-1 units | 15 × $49.5k = $743k |
| Fab attach | $200k |
| **Year 2 ARR + hardware** | **~$2.0M** |

**Year 3–4 (2028–2029):** Expand seats + defense tier

| Metric | Target |
|--------|--------|
| Team | 25 × $48k = $1.2M |
| Enterprise | 20 × $135k = $2.7M |
| Defense | 8 × $250k = $2.0M |
| FL-1 | 40 × $45k = $1.8M |
| Fab attach | $1.5M |
| **Year 4 run-rate** | **~$9.2M** |

**Year 5–7 (2030–2032):** Category leader in defense/space board programs

| Metric | Target |
|--------|--------|
| Enterprise + Defense ACV | 120 accounts × $200k avg = $24M |
| FL-1 + services | $15M |
| Fab attach | $8M |
| Manufacture-as-a-service (select) | $53M |
| **Year 7 run-rate** | **~$100M** |

*Full spreadsheet attached: `compose-financial-model.csv`*

---

## 10. Use of $4.5M raise

| Allocation | Amount | Milestone |
|------------|--------|-----------|
| Enterprise GTM (2 AEs + 1 solutions engineer) | $1.2M | 15 paying logos in 18 months |
| FL-1 production (first 25 units, CM tooling) | $1.5M | Ship founding customers |
| Compose product (block library, compliance, enterprise features) | $1.0M | Defense-tier ready |
| Grants / compliance / legal (ITAR, SOC 2) | $0.5M | Enterprise procurement unlock |
| Reserve | $0.3M | |

**Alternative:** Software-first path — 8 Enterprise customers ($960k ACV) + FL-1 preorders could fund first production batch with less dilution. Raise accelerates logo velocity and production scale.

---

## 11. Grants and strategic tailwinds

- US onshore electronics manufacturing and defense innovation priorities align with our stack
- Already submitted 15+ grant applications in 2026 (defense/space track)
- Compose + FL-1 fit SBIR/STTR, DIU-adjacent, and lab modernization narratives
- Grant funding targeted for FL-1 production and compliance, equity-free

---

## 12. Next steps

1. Partner meeting — happy to demo live Compose run (design interview → board → BOM → test plan)
2. Provide 2–3 reference conversations from defense/space pipeline (under NDA as needed)
3. Adjust deck pricing page to sales-led motion (done in parallel)

Thank you for the conversation — the enterprise pricing and buyer framing was exactly the push we needed.

**Attachments:**

- `compose-roi-calculator.csv` — per-customer ROI model (editable assumptions)
- `compose-financial-model.csv` — 7-year revenue path to $100M

— Jack
