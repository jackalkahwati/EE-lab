"""Create the subsystem assemblies and insert the ASM composites.

What it does (idempotent — safe to re-run; existing tabs are reused):
  1. Finds the Part Studio containing the ASM composites.
  2. Creates assemblies: Asm - X Axis / Y Axis / Z Probe / Fixture, and
     inserts the matching composite part into each.
  3. Creates Main Assembly and inserts the entire Part Studio once.

Usage:
    export ONSHAPE_ACCESS_KEY=...
    export ONSHAPE_SECRET_KEY=...
    python3 create_subsystem_assemblies.py "<onshape document URL>"
"""

from __future__ import annotations

import sys

from onshape_client import Client, OnshapeError, parse_document_url

COMPOSITE_TO_ASSEMBLY = {
    "ASM - X Axis": "Asm - X Axis",
    "ASM - Y Axis": "Asm - Y Axis",
    "ASM - Z Probe": "Asm - Z Probe",
    "ASM - Fixture": "Asm - Fixture",
}
MAIN_ASSEMBLY = "Main Assembly"


def main() -> int:
    if len(sys.argv) != 2:
        print(__doc__)
        return 2
    ids = parse_document_url(sys.argv[1])
    did, wid = ids["did"], ids["wid"]
    client = Client()

    elements = client.list_elements(did, wid)
    studios = [e for e in elements if e["elementType"] == "PARTSTUDIO"]
    existing_asms = {e["name"]: e["id"] for e in elements
                     if e["elementType"] == "ASSEMBLY"}

    # find the studio that holds the ASM composites
    studio_eid = None
    composites = {}
    for studio in studios:
        parts = client.list_parts(did, wid, studio["id"])
        found = {p["name"]: p["partId"] for p in parts
                 if p["name"] in COMPOSITE_TO_ASSEMBLY}
        if found:
            studio_eid = studio["id"]
            composites = found
            print("found {} composites in '{}'".format(
                len(found), studio["name"]))
            break
    if not studio_eid:
        raise OnshapeError(
            "no Part Studio contains the ASM composites — check names")
    missing = set(COMPOSITE_TO_ASSEMBLY) - set(composites)
    if missing:
        print("WARNING: composites not found, skipping: {}".format(
            ", ".join(sorted(missing))))

    # subsystem assemblies
    for comp_name, asm_name in COMPOSITE_TO_ASSEMBLY.items():
        if comp_name not in composites:
            continue
        if asm_name in existing_asms:
            asm_eid = existing_asms[asm_name]
            print("'{}' already exists, inserting into it".format(asm_name))
        else:
            asm_eid = client.create_assembly(did, wid, asm_name)["id"]
            print("created '{}'".format(asm_name))
        client.insert_instance(did, wid, asm_eid, studio_eid,
                               part_id=composites[comp_name])
        print("  inserted composite '{}'".format(comp_name))

    # main assembly: whole part studio in one instance set
    if MAIN_ASSEMBLY in existing_asms:
        main_eid = existing_asms[MAIN_ASSEMBLY]
        print("'{}' already exists, inserting into it".format(MAIN_ASSEMBLY))
    else:
        main_eid = client.create_assembly(did, wid, MAIN_ASSEMBLY)["id"]
        print("created '{}'".format(MAIN_ASSEMBLY))
    client.insert_instance(did, wid, main_eid, studio_eid,
                           whole_part_studio=True)
    print("  inserted entire Part Studio")

    print("\ndone — open the document; instances land in modeled position. "
          "Right-click an instance -> Fix to pin it (optional).")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except OnshapeError as exc:
        print("ERROR: {}".format(exc))
        sys.exit(1)
