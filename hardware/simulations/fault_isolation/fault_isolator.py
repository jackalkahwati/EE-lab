"""
Fault isolator: evidence accumulation with BFS path finding.

Two adjacency graphs:
  vol_adj  — voltage path-finding: includes regulators (they actively drive nets)
  res_adj  — resistance path-finding: excludes regulators/caps (powered-down board)

Key principle: path-finding always uses NOMINAL resistances so OPEN/MISSING
components (which disappear from the faulted graph) are still reachable and
can receive suspicion votes.

Scoring:
  score = (fail_votes − PASS_PENALTY × pass_votes) / total_votes
  Top-scored component = fault hypothesis.
"""
from __future__ import annotations
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Optional
import math

import math
from board_model import Board, Component, ComponentType, FaultType
from oracle import solve_dc, measure_resistance, measure_impedance


VOLTAGE_TOL    = 0.10   # 10% relative tolerance
RESISTANCE_TOL = 3.0    # pass band: [1/TOL … TOL] × nominal
IMPEDANCE_TOL  = 2.5    # same ratio band for AC impedance
PASS_PENALTY   = 0.25   # pass-path vote deduction

# Bayesian prior: multiply final score by component-type failure rate weight.
# Values are relative (fuses fail more than precision refs).
COMPONENT_PRIOR: dict[ComponentType, float] = {
    ComponentType.FUSE:     2.5,   # designed to fail
    ComponentType.DIODE:    1.5,   # junction degradation
    ComponentType.VREG:     1.4,   # thermal stress
    ComponentType.VREF:     0.8,   # precision, rarely fails
    ComponentType.RESISTOR: 0.9,
    ComponentType.CAPACITOR: 1.2,  # electrolytic aging
    ComponentType.INDUCTOR:  0.5,  # very reliable
    ComponentType.IC:        1.0,
}


# ---------------------------------------------------------------------------
# Adjacency graph builders
# ---------------------------------------------------------------------------

def _is_bridge(c: Component) -> bool:
    return c.name.startswith("BRIDGE_")


def _build_vol_adj(board: Board) -> dict[str, list[tuple[Component, str]]]:
    """
    Nominal adjacency for voltage path-finding.
    Includes regulators (they impose net voltages) but not capacitors or bridges.
    Bridges are fault artifacts, not nominal board connections.
    """
    adj: dict[str, list[tuple[Component, str]]] = defaultdict(list)
    for c in board.components:
        if _is_bridge(c):
            continue
        if c.ctype in (ComponentType.CAPACITOR, ComponentType.TESTPOINT):
            continue
        r = c.nominal_resistance()
        if c.ctype not in (ComponentType.VREG, ComponentType.VREF) and r > 1e9:
            continue
        adj[c.net_a].append((c, c.net_b))
        adj[c.net_b].append((c, c.net_a))
    return adj


def _build_res_adj(board: Board) -> dict[str, list[tuple[Component, str]]]:
    """
    Nominal adjacency for powered-down resistance measurement.
    Excludes regulators, refs, capacitors, and bridge components.
    """
    adj: dict[str, list[tuple[Component, str]]] = defaultdict(list)
    for c in board.components:
        if _is_bridge(c):
            continue
        if c.ctype in (ComponentType.CAPACITOR, ComponentType.TESTPOINT,
                       ComponentType.VREG, ComponentType.VREF):
            continue
        r = c.nominal_resistance()
        if r > 1e9:
            continue
        adj[c.net_a].append((c, c.net_b))
        adj[c.net_b].append((c, c.net_a))
    return adj


def _build_faulted_adj(board: Board) -> dict[str, list[tuple[Component, str]]]:
    """Faulted adjacency (effective resistances). Used for bridge detection."""
    adj: dict[str, list[tuple[Component, str]]] = defaultdict(list)
    for c in board.components:
        if c.ctype in (ComponentType.CAPACITOR, ComponentType.TESTPOINT):
            continue
        r = c.effective_resistance()
        if r > 1e9:
            continue
        adj[c.net_a].append((c, c.net_b))
        adj[c.net_b].append((c, c.net_a))
    return adj


def _bfs(adj: dict, starts: set[str], target: str) -> list[Component]:
    """Multi-source BFS. Returns components on shortest path to target."""
    if target in starts:
        return []
    visited: dict[str, tuple[Optional[Component], Optional[str]]] = {
        s: (None, None) for s in starts
    }
    q: deque[str] = deque(starts)
    while q:
        curr = q.popleft()
        if curr == target:
            break
        for comp, nxt in adj.get(curr, []):
            if nxt not in visited:
                visited[nxt] = (comp, curr)
                q.append(nxt)
    if target not in visited:
        return []
    path: list[Component] = []
    curr = target
    while visited[curr][0] is not None:
        comp, prev = visited[curr]
        path.append(comp)
        curr = prev
    return path


def _voltage_path(board: Board, vadj: dict, net: str) -> list[Component]:
    """Path from nearest voltage source (or reg output) to net."""
    sources = {s.net_pos for s in board.sources}
    for c in board.regulators():
        sources.add(c.net_b)  # reg output is an implicit source
    sources.discard(net)
    return _bfs(vadj, sources, net)


# ---------------------------------------------------------------------------
# Result types
# ---------------------------------------------------------------------------

@dataclass
class FaultHypothesis:
    component: Component
    score: float
    failed_votes: float
    pass_votes: float
    total_votes: float

    def __repr__(self):
        return (f"FaultHypothesis({self.component.name!r}, "
                f"score={self.score:.3f}, "
                f"fail={self.failed_votes:.0f}/{self.total_votes:.0f})")


@dataclass
class IsolationResult:
    injected_component: Optional[Component]
    top_hypothesis: Optional[FaultHypothesis]
    all_hypotheses: list[FaultHypothesis] = field(default_factory=list)
    measurements_taken: int = 0
    correct: bool = False

    def confidence(self) -> float:
        if len(self.all_hypotheses) < 2:
            return self.all_hypotheses[0].score if self.all_hypotheses else 0.0
        t = self.all_hypotheses[0].score
        s = self.all_hypotheses[1].score
        return min(1.0, (t - s) / max(abs(s) + 1e-9, 0.01))


# ---------------------------------------------------------------------------
# Main isolation
# ---------------------------------------------------------------------------

def isolate_fault(board: Board, healthy_voltages: dict[str, float],
                  healthy_impedances: Optional[dict] = None,
                  injected: Optional[Component] = None) -> IsolationResult:
    """
    Run fault isolation on a board that already has a fault injected.
    healthy_voltages: result of solve_dc on the healthy (unfaulted) board.
    healthy_impedances: {(net_a, net_b, freq_hz): |Z|} from healthy board.
                        Pass to enable AC impedance sweep (Phase 3).
    injected: the component whose fault was injected (for correctness scoring).
    """
    fail_v: dict[str, float] = defaultdict(float)
    pass_v: dict[str, float] = defaultdict(float)
    tot_v:  dict[str, float] = defaultdict(float)

    def vote(path: list[Component], failed: bool):
        for c in path:
            tot_v[c.name] += 1.0
            if failed:
                fail_v[c.name] += 1.0
            else:
                pass_v[c.name] += 1.0

    vadj  = _build_vol_adj(board)     # for voltage measurement paths
    radj  = _build_res_adj(board)     # for resistance measurement paths (powered down)
    fadj  = _build_faulted_adj(board) # for bridge detection (faulted board)

    faulted_v = solve_dc(board) or {}
    meas_count = 0

    # ---- Phase 1: node voltage checks ----
    interesting = [n for n, v in healthy_voltages.items()
                   if abs(v) > 0.05 and n != "GND"]
    for net in interesting:
        v_h = healthy_voltages[net]
        v_f = faulted_v.get(net, float("nan"))
        meas_count += 1

        if math.isnan(v_f):
            failed = True
        else:
            rel_err = abs(v_f - v_h) / max(abs(v_h), 0.01)
            failed = rel_err > VOLTAGE_TOL

        path = _voltage_path(board, vadj, net)
        vote(path, failed)

    # ---- Phase 2: resistance checks between all TP pairs ----
    tps = board.testpoints()
    for i in range(len(tps)):
        for j in range(i + 1, len(tps)):
            na, nb = tps[i].net_a, tps[j].net_a
            if na == nb:
                continue

            nom_path = _bfs(radj, {na}, nb)
            if nom_path:
                r_nom = sum(c.nominal_resistance() for c in nom_path
                            if c.ctype not in (ComponentType.CAPACITOR,))
                r_nom = max(r_nom, 1e-3)
            else:
                r_nom = 1e12  # no path in powered-down nominal board

            r_faulted = measure_resistance(board, na, nb)
            meas_count += 1

            if math.isnan(r_faulted):
                failed = True
                ratio = float("inf")
            else:
                ratio = r_faulted / max(r_nom, 1e-12)
                failed = ratio > RESISTANCE_TOL or ratio < 1.0 / RESISTANCE_TOL

            if not failed:
                vote(nom_path, False)
                continue

            if ratio < 1.0 / RESISTANCE_TOL:
                # Anomalously LOW resistance → possible bridge or short.
                # Find shortest path in faulted adj and vote for extra components
                # that don't appear in the nominal path.
                fpath = _bfs(fadj, {na}, nb)
                nom_names = {c.name for c in nom_path}
                new_comps = [c for c in fpath if c.name not in nom_names]
                if new_comps:
                    vote(new_comps, True)
                else:
                    vote(fpath if fpath else nom_path, True)
            else:
                # Anomalously HIGH resistance → open fault on the normal path.
                vote(nom_path, True)

    # ---- Phase 3: impedance sweep (1 kHz, 10 kHz, 100 kHz) ----
    # Compares |Z_faulted| against pre-measured healthy board impedances.
    # healthy_impedances[(na, nb, freq)] = |Z| on the unfaulted board.
    # This correctly captures parallel cap/inductor paths that path-sum misses.
    AC_FREQS = [1e3, 10e3, 100e3]
    if healthy_impedances:
        for freq in AC_FREQS:
            for i in range(len(tps)):
                for j in range(i + 1, len(tps)):
                    na, nb = tps[i].net_a, tps[j].net_a
                    if na == nb:
                        continue

                    z_healthy = healthy_impedances.get((na, nb, freq), float("nan"))
                    if math.isnan(z_healthy):
                        continue  # no healthy baseline → skip

                    nom_path = _bfs(radj, {na}, nb)
                    z_faulted = measure_impedance(board, na, nb, freq)
                    meas_count += 1

                    if math.isnan(z_faulted):
                        failed = True
                        ratio = float("inf")
                    else:
                        ratio = z_faulted / max(z_healthy, 1e-9)
                        failed = ratio > IMPEDANCE_TOL or ratio < 1.0 / IMPEDANCE_TOL

                    if not failed:
                        vote(nom_path, False)
                        continue

                    if ratio < 1.0 / IMPEDANCE_TOL:
                        fpath = _bfs(fadj, {na}, nb)
                        nom_names = {c.name for c in nom_path}
                        new_comps = [c for c in fpath if c.name not in nom_names]
                        vote(new_comps if new_comps else (fpath or nom_path), True)
                    else:
                        vote(nom_path, True)

    # ---- Score hypotheses with Bayesian prior ----
    hyps: list[FaultHypothesis] = []
    for comp in board.components:
        if comp.ctype == ComponentType.TESTPOINT:
            continue
        tot = tot_v.get(comp.name, 0.0)
        if tot < 0.5:
            continue
        fv = fail_v.get(comp.name, 0.0)
        pv = pass_v.get(comp.name, 0.0)
        evidence_score = (fv - PASS_PENALTY * pv) / tot
        prior = COMPONENT_PRIOR.get(comp.ctype, 1.0)
        score = evidence_score * prior
        hyps.append(FaultHypothesis(comp, score, fv, pv, tot))

    hyps.sort(key=lambda h: (-h.score, -h.failed_votes))
    top = hyps[0] if hyps else None
    correct = (injected is not None and top is not None
               and top.component.name == injected.name)

    return IsolationResult(
        injected_component=injected,
        top_hypothesis=top,
        all_hypotheses=hyps,
        measurements_taken=meas_count,
        correct=correct,
    )
