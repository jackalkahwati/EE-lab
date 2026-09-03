"""
Board model: graph-based net topology for MNA fault simulation.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Optional
import random


class ComponentType(Enum):
    RESISTOR = auto()
    CAPACITOR = auto()
    INDUCTOR = auto()
    DIODE = auto()
    FUSE = auto()
    VREG = auto()
    VREF = auto()
    IC = auto()
    TESTPOINT = auto()


class FaultType(Enum):
    NONE = auto()
    OPEN = auto()
    SHORT = auto()
    WRONG_VALUE = auto()
    DEGRADED = auto()
    WRONG_POLARITY = auto()
    MISSING = auto()
    BRIDGING = auto()


@dataclass
class Component:
    name: str
    ctype: ComponentType
    net_a: str
    net_b: str
    value: float            # R[Ω], C[F], L[H], Vout[V for regs], Vf[V for diodes]
    fault: FaultType = FaultType.NONE
    fault_magnitude: float = 1.0   # committed multiplier at injection (WRONG_VALUE/DEGRADED)
    v_dropout: float = 0.5
    tp_name: Optional[str] = None

    def nominal_resistance(self) -> float:
        """Resistance assuming no fault (used for path-finding)."""
        ct = self.ctype
        if ct == ComponentType.RESISTOR:
            return max(self.value, 1e-9)
        if ct == ComponentType.CAPACITOR:
            return 1e12
        if ct == ComponentType.INDUCTOR:
            return 1e-6
        if ct == ComponentType.DIODE:
            return 10.0   # simplified forward
        if ct == ComponentType.FUSE:
            return 0.01
        if ct in (ComponentType.VREG, ComponentType.VREF):
            return 1e12   # handled as voltage source
        if ct == ComponentType.IC:
            return max(self.value, 1.0)
        if ct == ComponentType.TESTPOINT:
            return 1e12
        return self.value

    def effective_resistance(self) -> float:
        """DC resistance with fault applied."""
        f = self.fault
        ct = self.ctype

        if f in (FaultType.OPEN, FaultType.MISSING):
            return 1e12
        if f == FaultType.SHORT:
            return 1e-3   # numerical stability

        if ct == ComponentType.RESISTOR:
            r = self.value
            if f == FaultType.WRONG_VALUE:
                r *= self.fault_magnitude
            elif f == FaultType.DEGRADED:
                r *= self.fault_magnitude
            return max(r, 1e-9)

        if ct == ComponentType.CAPACITOR:
            return 1e12

        if ct == ComponentType.INDUCTOR:
            return 1e-6

        if ct == ComponentType.DIODE:
            if f == FaultType.WRONG_POLARITY:
                return 1e12
            return 10.0

        if ct == ComponentType.FUSE:
            return 0.01

        if ct in (ComponentType.VREG, ComponentType.VREF):
            return 1e12   # handled as voltage source in MNA

        if ct == ComponentType.IC:
            r = self.value
            if f == FaultType.WRONG_VALUE:
                r *= self.fault_magnitude
            elif f == FaultType.DEGRADED:
                r *= self.fault_magnitude
            return max(r, 1.0)

        if ct == ComponentType.TESTPOINT:
            return 1e12

        return self.value


@dataclass
class VoltageSource:
    name: str
    net_pos: str
    net_neg: str
    voltage: float


@dataclass
class Board:
    name: str
    components: list[Component] = field(default_factory=list)
    sources: list[VoltageSource] = field(default_factory=list)
    _nets: set[str] = field(default_factory=set, repr=False)

    def _register(self, comp: Component):
        self._nets.add(comp.net_a)
        self._nets.add(comp.net_b)
        self.components.append(comp)

    def add_r(self, name, net_a, net_b, ohms) -> Component:
        c = Component(name, ComponentType.RESISTOR, net_a, net_b, ohms)
        self._register(c); return c

    def add_c(self, name, net_a, net_b, farads) -> Component:
        c = Component(name, ComponentType.CAPACITOR, net_a, net_b, farads)
        self._register(c); return c

    def add_l(self, name, net_a, net_b, henries) -> Component:
        c = Component(name, ComponentType.INDUCTOR, net_a, net_b, henries)
        self._register(c); return c

    def add_diode(self, name, anode, cathode, vf=0.7) -> Component:
        c = Component(name, ComponentType.DIODE, anode, cathode, vf)
        self._register(c); return c

    def add_fuse(self, name, net_a, net_b, rating_a=1.0) -> Component:
        c = Component(name, ComponentType.FUSE, net_a, net_b, rating_a)
        self._register(c); return c

    def add_vreg(self, name, vin_net, vout_net,
                 vout_nominal, dropout=0.5) -> Component:
        c = Component(name, ComponentType.VREG, vin_net, vout_net,
                      vout_nominal, v_dropout=dropout)
        self._register(c); return c

    def add_vref(self, name, vin_net, vout_net, vout) -> Component:
        c = Component(name, ComponentType.VREF, vin_net, vout_net, vout)
        self._register(c); return c

    def add_ic(self, name, vdd_net, gnd_net, load_ohms=1000.0) -> Component:
        c = Component(name, ComponentType.IC, vdd_net, gnd_net, load_ohms)
        self._register(c); return c

    def add_tp(self, name, net) -> Component:
        c = Component(name, ComponentType.TESTPOINT, net, net, 0.0, tp_name=name)
        self._register(c); return c

    def add_rail(self, net, voltage, gnd_net="GND"):
        src = VoltageSource(f"V_{net}", net, gnd_net, voltage)
        self.sources.append(src)
        self._nets.add(net); self._nets.add(gnd_net)

    @property
    def nets(self) -> list[str]:
        return sorted(self._nets)

    def testpoints(self) -> list[Component]:
        return [c for c in self.components if c.ctype == ComponentType.TESTPOINT]

    def regulators(self) -> list[Component]:
        return [c for c in self.components
                if c.ctype in (ComponentType.VREG, ComponentType.VREF)]

    def inject_fault(self, comp: Component, fault: FaultType):
        comp.fault = fault
        # Commit magnitude once so every effective_resistance() call is consistent
        if fault == FaultType.WRONG_VALUE:
            comp.fault_magnitude = 10.0 if random.random() > 0.5 else 0.1
        elif fault == FaultType.DEGRADED:
            comp.fault_magnitude = 1.0 + random.uniform(-0.5, 0.5)
        else:
            comp.fault_magnitude = 1.0

    def clear_faults(self):
        for c in self.components:
            c.fault = FaultType.NONE
            c.fault_magnitude = 1.0

    def inject_bridging_fault(self, net_a: str, net_b: str) -> Component:
        name = f"BRIDGE_{net_a}_{net_b}"
        c = Component(name, ComponentType.RESISTOR, net_a, net_b, 1e-3)
        self._register(c)
        return c

    def remove_bridging_faults(self):
        self.components = [c for c in self.components
                           if not c.name.startswith("BRIDGE_")]
        self._rebuild_nets()

    def _rebuild_nets(self):
        self._nets = set()
        for c in self.components:
            self._nets.add(c.net_a)
            self._nets.add(c.net_b)
        for s in self.sources:
            self._nets.add(s.net_pos)
            self._nets.add(s.net_neg)
