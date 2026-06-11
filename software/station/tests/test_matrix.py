import pytest

from bringup_station.hal.mocks import MockRelayMatrix
from bringup_station.switching.matrix import MatrixRouter, RoutingError


def make_router():
    return MatrixRouter(MockRelayMatrix())


def test_basic_routing_and_disconnect():
    r = make_router()
    r.connect(0, "daq")
    assert r.routes == {0: "daq"}
    r.disconnect(0)
    assert r.routes == {}


def test_probe_carries_one_resource():
    r = make_router()
    r.connect(0, "daq")
    with pytest.raises(RoutingError):
        r.connect(0, "scope_ch1")


def test_resource_drives_one_probe():
    r = make_router()
    r.connect(0, "daq")
    with pytest.raises(RoutingError):
        r.connect(1, "daq")


def test_sources_frozen_while_power_live():
    r = make_router()
    r.lock_sources()
    with pytest.raises(RoutingError):
        r.connect(0, "psu")
    # measurement routes stay allowed (protection board is in their path)
    r.connect(0, "daq")
    r.disconnect(0)


def test_open_all_always_allowed():
    r = make_router()
    r.connect(0, "psu")
    r.lock_sources()
    r.open_all()
    assert r.routes == {}
