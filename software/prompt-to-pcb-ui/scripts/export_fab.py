"""Stage 4 fab-output generator — runs after DRC passes. Produces the
fabrication package from the validated board and zips it:

  gerbers/*.g*          copper, mask, silk, edge (kicad-cli pcb export gerbers)
  gerbers/*.drl         drill files                (kicad-cli pcb export drill)
  pick_and_place.csv    P&P / centroid             (kicad-cli pcb export pos)
  board.step            3D model                   (kicad-cli pcb export step)
  bom.csv               from the atopile build, if present

Usage:  python3 export_fab.py <board.kicad_pcb> <out_dir> [bom_csv]
Prints  FAB_ZIP:<path>  on success and a per-artifact line for the UI log.
Exits 0 if the core gerbers were produced (STEP/BOM are best-effort).
"""
import os
import shutil
import subprocess
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import toolchain  # noqa: E402

KCLI = toolchain.kicad_cli()

BOARD = sys.argv[1]
OUT = sys.argv[2]
BOM_CSV = sys.argv[3] if len(sys.argv) > 3 else None


def run(args, label):
    try:
        p = subprocess.run([KCLI] + args, capture_output=True, text=True, timeout=300)
        ok = p.returncode == 0
        print("fab: {} {}".format(label, "OK" if ok else "FAILED"))
        if not ok and p.stderr.strip():
            print("fab:   {}".format(p.stderr.strip().splitlines()[-1]))
        return ok
    except Exception as e:
        print("fab: {} FAILED ({})".format(label, e))
        return False


def main():
    gdir = os.path.join(OUT, "gerbers")
    os.makedirs(gdir, exist_ok=True)

    core = run(["pcb", "export", "gerbers", "-o", gdir + os.sep, BOARD], "gerbers")
    run(["pcb", "export", "drill", "-o", gdir + os.sep, BOARD], "drill")
    run(["pcb", "export", "pos", "--format", "csv", "--units", "mm",
         "-o", os.path.join(OUT, "pick_and_place.csv"), BOARD], "pick-and-place")
    # STEP is heavy and tolerant of missing 3D models — best-effort.
    run(["pcb", "export", "step", "--no-dnp", "--subst-models",
         "-o", os.path.join(OUT, "board.step"), BOARD], "step")

    if BOM_CSV and os.path.exists(BOM_CSV):
        shutil.copyfile(BOM_CSV, os.path.join(OUT, "bom.csv"))
        print("fab: bom.csv OK")
    else:
        print("fab: bom.csv skipped (atopile BOM not found)")

    # zip the whole package
    zip_path = os.path.join(OUT, "fab-package.zip")
    files = []
    for root, _dirs, names in os.walk(OUT):
        for n in names:
            if n == "fab-package.zip":
                continue
            files.append(os.path.join(root, n))
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for f in files:
            z.write(f, os.path.relpath(f, OUT))
    print("fab: packaged {} files -> {}".format(len(files), os.path.basename(zip_path)))
    print("FAB_ZIP:{}".format(zip_path))
    sys.exit(0 if core else 1)


if __name__ == "__main__":
    main()
