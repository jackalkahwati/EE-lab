"""
Fault isolator: evidence accumulation with k-shortest-paths voting.

Improvements over v1:
  - k-shortest-paths (up to k=4, shortest+2 hops) instead of single BFS path
  - Path-count-weighted voting: components on more paths get proportionally more weight
  - Precision-based scoring: fail/(pass+1) × prior rewards exclusive fails over volume
  - Voltage tolerance tightened to 5% (catches WRONG_VALUE / DEGRADED better)

Two adjacency graphs:
  vol_adj  — voltage path-finding: includes regulators (active during power-on)
  res_adj  — resistance path-finding: excludes regs/caps (powered-down board)
"""
from __future__ import annotations
from collections import defaultdict, deque
from dataclasses import dataclass, field
from typing import Optional
import math

from board_model import Board, Component, ComponentType, FaultType
from oracle import solve_dc, measure_resistance, measure_impedance


VOLTAGE_TOL    = 0.05   # 5% relative tolerance (was 10% — tighter catches WRONG_VALUE)
RESISTANCE_TOL = 3.0
IMPEDANCE_TOL  = 2.5
K_PATHS        = 4      # max paths to find per measurement pair
MAX_EXTRA_HOPS = 2      # explore up to shortest+2 hops

# Bayesian prior by component type (failure rate relative weight)
COMPONENT_PRIOR: dict[ComponentType, float] = {
    ComponentType.FUSE:     2.5,
    ComponentType.DIODE:    1.5,
    ComponentType.VREG:     1.4,
    ComponentType.VREF:     0.8,
    ComponentType.RESISTOR: 0.9,
    ComponentType.CAPACITOR: 1.2,
    ComponentType.INDUCTOR:  0.5,
    ComponentType.IC:        1.0,
}


# ---------------------------------------------------------------------------
# Adjacency graph builders
# ---------------------------------------------------------------------------

def _is_bridge(c: Component) -> bool:
    return c.name.startswith("BRIDGE_")


_GND = "GND"


def _build_vol_adj(board: Board) -> dict[str, list[tuple[Component, str]]]:
    """
    Nominal adjacency for voltage path-finding.
    Two constraints enforce physical power-flow direction:
      1. Regulators DIRECTED: vin → vout only (no backward path through regs).
      2. GND is a current SINK: no outbound edges from GND.
         Prevents spurious paths: 5V → R_load → GND → D_x → target
         which would attribute GND-anchored components to a fault on a
         completely unrelated net.
    Bridges excluded (fault artifacts, not nominal board connections).
    """
    adj: dict[str, list[tuple[Component, str]]] = defaultdict(list)
    for c in board.components:
        if _is_bridge(c) or c.ctype in (ComponentType.CAPACITOR,
                                         ComponentType.TESTPOINT):
            continue
        if c.ctype in (ComponentType.VREG, ComponentType.VREF):
            adj[c.net_a].append((c, c.net_b))  # vin → vout only
            continue
        r = c.nominal_resistance()
        if r > 1e9:
            continue
        # Add edges, but never FROM GND (GND is a sink, not a source)
        if c.net_a != _GND:
            adj[c.net_a].append((c, c.net_b))
        if c.net_b != _GND:
            adj[c.net_b].append((c, c.net_a))
    return adj


def _build_res_adj(board: Board) -> dict[str, list[tuple[Component, str]]]:
    adj: dict[str, list[tuple[Component, str]]] = defaultdict(list)
    for c in board.components:
        if (_is_bridge(c) or c.ctype in (ComponentType.CAPACITOR,
                                          ComponentType.TESTPOINT,
                                          ComponentType.VREG,
                                          ComponentType.VREF)):
            continue
        r = c.nominal_resistance()
        if r > 1e9:
            continue
        adj[c.net_a].append((c, c.net_b))
        adj[c.net_b].append((c, c.net_a))
    return adj


def _build_faulted_adj(board: Board) -> dict[str, list[tuple[Component, str]]]:
    adj: dict[str, list[tuple[Component, str]]] = defaultdict(list)
    for c in board.components:
        if c.ctype in (ComponentType.CAPACITOR, ComponentType.TESTPOINT):
            continue
        if c.effective_resistance() > 1e9:
            continue
        adj[c.net_a].append((c, c.net_b))
        adj[c.net_b].append((c, c.net_a))
    return adj


# ---------------------------------------------------------------------------
# Path finding
# ---------------------------------------------------------------------------

def _bfs(adj: dict, starts: set[str], target: str) -> list[Component]:
    """Single shortest path via BFS."""
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


def _k_paths(adj: dict, starts: set[str], target: str) -> list[list[Component]]:
    """
    Find up to K_PATHS acyclic paths from any start to target.
    Explores up to shortest_path_length + MAX_EXTRA_HOPS edges.
    Returns list of paths, sorted shortest first.
    """
    shortest = _bfs(adj, starts, target)
    if not shortest:
        return []
    max_depth = len(shortest) + MAX_EXTRA_HOPS
    found: list[list[Component]] = []

    def dfs(curr: str, path: list[Component], visited: set[str]):
        if len(found) >= K_PATHS:
            return
        if curr == target:
            found.append(path[:])
            return
        if len(path) >= max_depth:
            return
        for comp, nxt in adj.get(curr, []):
            if nxt not in visited:
                visited.add(nxt)
                path.append(comp)
                dfs(nxt, path, visited)
                path.pop()
                visited.remove(nxt)

    for s in starts:
        if len(found) < K_PATHS:
            dfs(s, [], {s})

    found.sort(key=len)
    return found


def _voltage_k_paths(board: Board, vadj: dict, net: str) -> list[list[Component]]:
    """
    Find k paths from external voltage sources to the measured net.
    Uses only board.sources as roots (not regulator outputs) so paths always
    flow downstream through regulators — prevents spurious backward paths.
    """
    sources = {s.net_pos for s in board.sources}
    sources.discard(net)
    return _k_paths(vadj, sources, net)


# ---------------------------------------------------------------------------
# Weighted voting
# ---------------------------------------------------------------------------

def _vote_paths(paths: list[list[Component]], failed: bool,
                fail_v: dict, pass_v: dict, tot_v: dict):
    """
    Vote for each component weighted by the fraction of paths it appears on.
    A component on every path gets weight 1.0; one on half the paths gets 0.5.
    This rewards components that are consistently on failing paths over those
    that appear incidentally.
    """
    if not paths:
        return
    comp_count: dict[str, int] = defaultdict(int)
    comp_obj: dict[str, Component] = {}
    for path in paths:
        seen = set()
        for c in path:
            if c.name not in seen:
                comp_count[c.name] += 1
                comp_obj[c.name] = c
                seen.add(c.name)
    n = len(paths)
    for name, cnt in comp_count.items():
        w = cnt / n
        tot_v[name] += w
        if failed:
            fail_v[name] += w
        else:
            pass_v[name] += w


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
                f"fail={self.failed_votes:.2f} pass={self.pass_votes:.2f})")


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
    Run fault isolation on a board with a fault already injected.

    healthy_voltages:   solve_dc result from the healthy (unfaulted) board.
    healthy_impedances: {(net_a, net_b, freq_hz): |Z|} from healthy board.
                        Pass to enable the AC impedance sweep (Phase 3).
    injected:           the component whose fault was injected (for scoring).
    """
    fail_v: dict[str, float] = defaultdict(float)
    pass_v: dict[str, float] = defaultdict(float)
    tot_v:  dict[str, float] = defaultdict(float)

    vadj = _build_vol_adj(board)
    radj = _build_res_adj(board)
    fadj = _build_faulted_adj(board)

    faulted_v = solve_dc(board) or {}
    meas_count = 0

    # ---- Phase 1: node voltage checks (k-paths from sources) ----
    for net, v_h in healthy_voltages.items():
        if abs(v_h) < 0.05 or net == "GND":
            continue
        v_f = faulted_v.get(net, float("nan"))
        meas_count += 1

        if math.isnan(v_f):
            failed = True
        else:
            failed = abs(v_f - v_h) / max(abs(v_h), 0.01) > VOLTAGE_TOL

        paths = _voltage_k_paths(board, vadj, net)
        _vote_paths(paths, failed, fail_v, pass_v, tot_v)

    # ---- Phase 2: resistance checks between all TP pairs (k-paths) ----
    tps = board.testpoints()
    for i in range(len(tps)):
        for j in range(i + 1, len(tps)):
            na, nb = tps[i].net_a, tps[j].net_a
            if na == nb:
                continue

            nom_paths = _k_paths(radj, {na}, nb)
            r_nom: float
            if nom_paths:
                r_nom = sum(c.nominal_resistance() for c in nom_paths[0]
                            if c.ctype != ComponentType.CAPACITOR)
                r_nom = max(r_nom, 1e-3)
            else:
                r_nom = 1e12

            r_faulted = measure_resistance(board, na, nb)
            meas_count += 1

            if math.isnan(r_faulted):
                failed, ratio = True, float("inf")
            else:
                ratio = r_faulted / max(r_nom, 1e-12)
                failed = ratio > RESISTANCE_TOL or ratio < 1.0 / RESISTANCE_TOL

            if not failed:
                _vote_paths(nom_paths, False, fail_v, pass_v, tot_v)
                continue

            if ratio < 1.0 / RESISTANCE_TOL:
                # Anomalously low: bridge/short.  Vote for extra components
                # visible in the faulted graph but absent from nominal paths.
                fpath = _bfs(fadj, {na}, nb)
                nom_names = {c.name for p in nom_paths for c in p}
                new_comps = [c for c in fpath if c.name not in nom_names]
                if new_comps:
                    _vote_paths([new_comps], True, fail_v, pass_v, tot_v)
                else:
                    _vote_paths([fpath] if fpath else nom_paths or [[]], True,
                                fail_v, pass_v, tot_v)
            else:
                _vote_paths(nom_paths, True, fail_v, pass_v, tot_v)

    # ---- Phase 3: AC impedance sweep (1 kHz, 10 kHz, 100 kHz) ----
    AC_FREQS = [1e3, 10e3, 100e3]
    if healthy_impedances:
        for freq in AC_FREQS:
            for i in range(len(tps)):
                for j in range(i + 1, len(tps)):
                    na, nb = tps[i].net_a, tps[j].net_a
                    if na == nb:
                        continue

                    z_h = healthy_impedances.get((na, nb, freq), float("nan"))
                    if math.isnan(z_h):
                        continue

                    nom_paths = _k_paths(radj, {na}, nb)
                    z_f = measure_impedance(board, na, nb, freq)
                    meas_count += 1

                    if math.isnan(z_f):
                        failed, ratio = True, float("inf")
                    else:
                        ratio = z_f / max(z_h, 1e-9)
                        failed = ratio > IMPEDANCE_TOL or ratio < 1.0 / IMPEDANCE_TOL

                    if not failed:
                        _vote_paths(nom_paths, False, fail_v, pass_v, tot_v)
                        continue

                    if ratio < 1.0 / IMPEDANCE_TOL:
                        fpath = _bfs(fadj, {na}, nb)
                        nom_names = {c.name for p in nom_paths for c in p}
                        new_comps = [c for c in fpath if c.name not in nom_names]
                        target_paths = [new_comps] if new_comps else (
                            [fpath] if fpath else nom_paths)
                        _vote_paths(target_paths, True, fail_v, pass_v, tot_v)
                    else:
                        _vote_paths(nom_paths, True, fail_v, pass_v, tot_v)

    # ---- Score: precision × prior ----
    # fail/(pass+1) rewards components exclusive to failing paths.
    # Multiply by prior (component-type failure rate) for tie-breaking.
    hyps: list[FaultHypothesis] = []
    for comp in board.components:
        if comp.ctype == ComponentType.TESTPOINT:
            continue
        fv = fail_v.get(comp.name, 0.0)
        pv = pass_v.get(comp.name, 0.0)
        tot = tot_v.get(comp.name, 0.0)
        if tot < 0.1:
            continue
        precision = fv / (pv + 1.0)
        prior = COMPONENT_PRIOR.get(comp.ctype, 1.0)
        score = precision * prior
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
