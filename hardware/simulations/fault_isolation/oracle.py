"""
Measurement oracle: MNA-based DC solver.

System: [G B; B' 0] × [V; I_src] = [J; E_src]
  G = conductance matrix (N×N)
  B = voltage-source incidence (N×M)
  V = node voltages (N)
  I_src = source currents (M)
  J = current injections (N, usually 0)
  E_src = source voltages (M)

Regulators modelled as controlled voltage sources (V_out relative to GND).
Active regulators found iteratively (max 4 passes).
"""
from __future__ import annotations
import numpy as np
import random
from typing import Optional
from board_model import Board, Component, ComponentType, FaultType

GND = "GND"


def _reg_effective_voltage(comp: Component) -> float:
    v = comp.value
    if comp.fault == FaultType.WRONG_VALUE:
        v *= 10.0 if random.random() > 0.5 else 0.1
    elif comp.fault == FaultType.DEGRADED:
        v *= 1.0 + random.uniform(-0.2, 0.2)
    return v


def solve_dc(board: Board) -> Optional[dict[str, float]]:
    """
    Return node voltages keyed by net name, or None if singular.
    """
    nets = board.nets
    n_idx = {n: i for i, n in enumerate(nets)}
    N = len(nets)
    gnd_i = n_idx.get(GND, -1)

    # External voltage sources (pos, neg, V)
    ext_vsrc: list[tuple[str, str, float]] = [
        (s.net_pos, s.net_neg, s.voltage) for s in board.sources
    ]

    active_regs: list[Component] = []
    node_v: Optional[np.ndarray] = None

    for _pass in range(4):
        # Regulator sources: V(vout) = vout_nominal  (relative to GND)
        reg_vsrc: list[tuple[str, str, float]] = [
            (r.net_b, GND, _reg_effective_voltage(r)) for r in active_regs
        ]
        all_vsrc = ext_vsrc + reg_vsrc
        M = len(all_vsrc)
        size = N + M
        A = np.zeros((size, size))
        b_vec = np.zeros(size)

        # -- Stamp conductance matrix --
        for comp in board.components:
            if comp.ctype == ComponentType.TESTPOINT:
                continue
            if comp.ctype in (ComponentType.VREG, ComponentType.VREF):
                # Faulted SHORT: stamp as low-R between vin and vout
                if comp.fault == FaultType.SHORT:
                    g = 1.0 / 1e-3
                    ia, ib = n_idx[comp.net_a], n_idx[comp.net_b]
                    A[ia, ia] += g; A[ib, ib] += g
                    A[ia, ib] -= g; A[ib, ia] -= g
                continue

            r = comp.effective_resistance()
            g = 1.0 / max(r, 1e-12)
            ia = n_idx[comp.net_a]
            ib = n_idx[comp.net_b]
            A[ia, ia] += g; A[ib, ib] += g
            A[ia, ib] -= g; A[ib, ia] -= g

        # -- Ground reference --
        if gnd_i >= 0:
            A[gnd_i, :] = 0.0
            A[gnd_i, gnd_i] = 1.0
            b_vec[gnd_i] = 0.0

        # -- Stamp voltage sources --
        for k, (pos, neg, v) in enumerate(all_vsrc):
            col = N + k
            ip = n_idx[pos]
            in_ = n_idx.get(neg, -1)
            A[ip, col] += 1.0
            A[col, ip] += 1.0
            if in_ >= 0 and in_ != gnd_i:
                A[in_, col] -= 1.0
                A[col, in_] -= 1.0
            b_vec[col] = v

        # -- Solve --
        try:
            x = np.linalg.solve(A, b_vec)
        except np.linalg.LinAlgError:
            return None

        node_v = x[:N]
        volts = {net: float(node_v[n_idx[net]]) for net in nets}

        # -- Activate regulators whose Vin is sufficient --
        new_regs: list[Component] = []
        for comp in board.regulators():
            if comp.fault in (FaultType.OPEN, FaultType.MISSING, FaultType.SHORT):
                continue
            vout_eff = _reg_effective_voltage(comp)
            vin = volts.get(comp.net_a, 0.0)
            if vin >= vout_eff + comp.v_dropout:
                new_regs.append(comp)

        if set(id(r) for r in new_regs) == set(id(r) for r in active_regs):
            break
        active_regs = new_regs

    if node_v is None:
        return None
    return {net: float(node_v[n_idx[net]]) for net in nets}


def measure_voltage(board: Board, net: str, ref: str = GND) -> float:
    volts = solve_dc(board)
    if volts is None:
        return float("nan")
    return volts.get(net, 0.0) - volts.get(ref, 0.0)


def measure_resistance(board: Board, net_a: str, net_b: str) -> float:
    """
    Two-terminal resistance between net_a and net_b (board powered down).
    Uses 1V / 1Ω injection method.
    """
    from board_model import VoltageSource, Component, ComponentType

    orig_sources = board.sources[:]
    board.sources = []  # powered-down

    vsrc_net = "__VSRC_MEAS__"
    board._nets.add(vsrc_net)
    vsrc = VoltageSource("__VSRC__", vsrc_net, net_b, 1.0)
    sense = Component("__SENSE__", ComponentType.RESISTOR, vsrc_net, net_a, 1.0)
    board.sources.append(vsrc)
    board.components.append(sense)

    volts = solve_dc(board)

    board.sources = orig_sources
    board.components = [c for c in board.components if c.name != "__SENSE__"]
    board._nets.discard(vsrc_net)

    if volts is None:
        return float("nan")

    v_vsrc = volts.get(vsrc_net, 0.0)
    v_a = volts.get(net_a, 0.0)
    v_b = volts.get(net_b, 0.0)
    i = (v_vsrc - v_a) / 1.0
    if abs(i) < 1e-15:
        return 1e12
    return abs((v_a - v_b) / i)


def check_continuity(board: Board, net_a: str, net_b: str,
                     threshold: float = 10.0) -> bool:
    return measure_resistance(board, net_a, net_b) < threshold
