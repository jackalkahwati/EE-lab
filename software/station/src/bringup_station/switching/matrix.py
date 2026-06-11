"""Relay matrix routing policy.

Maps (resource, probe) routes onto raw relay channels and enforces the rules
that protect the DUT and instruments (this is the software half of the probe
protection scheme; the protection PCBA is the hardware half):

- a probe carries at most one resource at a time
- a resource drives at most one probe at a time
- while DUT power is live (lock held by the sequencer), source resources
  (psu, eload) may not be routed or unrouted — no hot source connections.
  Measurement resources stay routable; the protection PCBA is in their path.
"""

from __future__ import annotations

from typing import Dict, Tuple

from ..hal.interfaces import RelayMatrix

#: Resources the v1 matrix exposes. Relay channel layout: 4 probes x 8
#: resources, relay_id = probe_index * 8 + resource_index.
RESOURCES = ("daq", "scope_ch1", "scope_ch2", "logic", "psu", "eload", "gnd", "spare")
NUM_PROBES = 4

SOURCE_RESOURCES = frozenset({"psu", "eload"})


class RoutingError(RuntimeError):
    pass


class MatrixRouter:
    def __init__(self, matrix: RelayMatrix) -> None:
        self._matrix = matrix
        self._routes: Dict[int, str] = {}      # probe -> resource
        self._locked = False

    @staticmethod
    def _relay_id(probe: int, resource: str) -> int:
        return probe * len(RESOURCES) + RESOURCES.index(resource)

    @property
    def routes(self) -> Dict[int, str]:
        return dict(self._routes)

    def lock_sources(self) -> None:
        """Forbid source route changes (held while DUT power is live)."""
        self._locked = True

    def unlock_sources(self) -> None:
        self._locked = False

    def connect(self, probe: int, resource: str) -> None:
        if self._locked and resource in SOURCE_RESOURCES:
            raise RoutingError(
                "source routes frozen while DUT power is live: {}".format(resource))
        if not 0 <= probe < NUM_PROBES:
            raise RoutingError("probe {} out of range".format(probe))
        if resource not in RESOURCES:
            raise RoutingError("unknown resource {!r}".format(resource))
        if probe in self._routes and self._routes[probe] != resource:
            raise RoutingError(
                "probe {} already routed to {}".format(probe, self._routes[probe]))
        if resource in self._routes.values() and self._routes.get(probe) != resource:
            raise RoutingError("resource {} already in use".format(resource))
        self._matrix.set_relay(self._relay_id(probe, resource), True)
        self._routes[probe] = resource

    def disconnect(self, probe: int) -> None:
        if self._locked and self._routes.get(probe) in SOURCE_RESOURCES:
            raise RoutingError(
                "source routes frozen while DUT power is live")
        resource = self._routes.pop(probe, None)
        if resource is not None:
            self._matrix.set_relay(self._relay_id(probe, resource), False)

    def open_all(self) -> None:
        """Emergency/cleanup path: always allowed, even when locked."""
        self._matrix.open_all()
        self._routes.clear()
        self._locked = False
