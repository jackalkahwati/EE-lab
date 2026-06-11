"""FastAPI control API.

The product has no built-in screen; this API is what the web UI (and any
automation) talks to. Runs against the simulated machine by default:

    uvicorn bringup_station.api.server:app --port 8800

Endpoints are synchronous for now; long-running plan execution moves to a job
queue in roadmap S5.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

from fastapi import Body, FastAPI, HTTPException

from ..boardio.testpoints import Board, TestPoint
from ..manifest.compile import ManifestError, compile_manifest
from ..manifest.schema import DesignManifest
from ..sequencer.plan import TestPlan
from ..sim import MachineContext, make_sim_machine
from ..vision.registration import fit_transform


def build_app(ctx: Optional[MachineContext] = None) -> FastAPI:
    ctx = ctx or make_sim_machine()
    app = FastAPI(title="Bring-Up Station", version="0.1.0")
    app.state.ctx = ctx
    reports: List[Dict[str, Any]] = []

    @app.get("/healthz")
    def healthz() -> Dict[str, str]:
        return {"status": "ok"}

    @app.get("/status")
    def status() -> Dict[str, Any]:
        x, y, z = ctx.gantry.position
        return {
            "homed": ctx.gantry.homed,
            "position": {"x": x, "y": y, "z": z},
            "safety": ctx.safety.state.value,
            "routes": ctx.router.routes,
            "power_on": ctx.power.any_on,
            "panel_connected": list(ctx.panel.connected()),
        }

    @app.post("/home")
    def home() -> Dict[str, Any]:
        try:
            ctx.gantry.home()
        except Exception as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        return {"homed": True}

    @app.post("/move")
    def move(body: Dict[str, float] = Body(...)) -> Dict[str, Any]:
        try:
            ctx.gantry.move_xy(float(body["x"]), float(body["y"]))
        except KeyError as exc:
            raise HTTPException(status_code=422, detail="missing {}".format(exc))
        except Exception as exc:
            raise HTTPException(status_code=409, detail=str(exc))
        x, y, z = ctx.gantry.position
        return {"position": {"x": x, "y": y, "z": z}}

    @app.post("/plans/run")
    def run_plan(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """Body: {"plan": <plan dict>, "board": {"name", "testpoints": [...]},
        "fiducials": optional [{"board": [x, y], "machine": [x, y]}, ...]}"""
        try:
            plan = TestPlan.from_dict(body["plan"])
            board = Board(name=body["board"]["name"])
            for item in body["board"]["testpoints"]:
                tp = TestPoint(name=item["name"], net=item.get("net", ""),
                               x_mm=float(item["x_mm"]), y_mm=float(item["y_mm"]))
                board.testpoints[tp.name] = tp
            transform = None
            fiducials = body.get("fiducials") or []
            if fiducials:
                transform = fit_transform(
                    [tuple(f["board"]) for f in fiducials],
                    [tuple(f["machine"]) for f in fiducials])
        except (KeyError, ValueError, TypeError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        report = ctx.engine.run(plan, board, transform).to_dict()
        report["id"] = len(reports)
        reports.append(report)
        return report

    @app.post("/manifests/run")
    def run_manifest(body: Dict[str, Any] = Body(...)) -> Dict[str, Any]:
        """Body: {"manifest": <DesignManifest dict>, "fiducials": optional
        [{"board": [x, y], "machine": [x, y]}, ...]}. Compiles the manifest
        into a bring-up plan (pre-power gate -> sequenced power -> firmware ->
        rails -> clocks -> thermal) and runs it."""
        try:
            manifest = DesignManifest.from_dict(body["manifest"])
            board, plan = compile_manifest(manifest)
            transform = None
            fiducials = body.get("fiducials") or []
            if fiducials:
                transform = fit_transform(
                    [tuple(f["board"]) for f in fiducials],
                    [tuple(f["machine"]) for f in fiducials])
        except (KeyError, ValueError, TypeError, ManifestError) as exc:
            raise HTTPException(status_code=422, detail=str(exc))
        report = ctx.engine.run(plan, board, transform).to_dict()
        report["id"] = len(reports)
        reports.append(report)
        return report

    @app.get("/reports")
    def list_reports() -> List[Dict[str, Any]]:
        return [{"id": r["id"], "plan": r["plan"], "board": r["board"],
                 "passed": r["passed"]} for r in reports]

    @app.get("/reports/{report_id}")
    def get_report(report_id: int) -> Dict[str, Any]:
        if not 0 <= report_id < len(reports):
            raise HTTPException(status_code=404, detail="no such report")
        return reports[report_id]

    return app


app = build_app()
