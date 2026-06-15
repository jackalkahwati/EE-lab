"""
FL-1 DUT Power Board — Python host command library.

Usage:
    from host_library import FL1PowerController
    pwr = FL1PowerController("/dev/ttyACM0")
    pwr.set_voltage(1, 3.3)
    pwr.set_limit(1, 500)    # 500 mA
    pwr.enable(1)
    tel = pwr.read_telemetry()
    print(tel["rails"][0]["voltage_v"])
    pwr.disable(1)
    pwr.close()
"""

import serial
import json
import time
import threading
from typing import Optional, List, Dict, Any


class FL1PowerError(Exception):
    """Raised on protocol or hardware errors from the DUT power board."""
    pass


class FL1PowerController:
    """Host-side controller for the FL-1 DUT Power + Fast-Trip Board Rev A.

    All commands are synchronous and block until the board responds or timeout.
    Thread-safe: uses an internal lock around serial access.
    """

    DEFAULT_BAUD    = 115200
    DEFAULT_TIMEOUT = 3.0     # seconds
    LINE_ENDING     = "\r\n"

    def __init__(self, port: str, baud: int = DEFAULT_BAUD, timeout: float = DEFAULT_TIMEOUT):
        """Open serial connection to the DUT power board.

        Args:
            port:    Serial port path, e.g. "/dev/ttyACM0" or "COM3"
            baud:    Baud rate (must match firmware, default 115200)
            timeout: Read timeout in seconds
        """
        self._port    = port
        self._timeout = timeout
        self._lock    = threading.Lock()
        self._ser     = serial.Serial(
            port=port,
            baudrate=baud,
            bytesize=serial.EIGHTBITS,
            parity=serial.PARITY_NONE,
            stopbits=serial.STOPBITS_ONE,
            timeout=timeout,
            write_timeout=timeout,
        )
        time.sleep(0.1)   # allow USB CDC to settle
        self._ser.reset_input_buffer()

    def close(self):
        """Close the serial connection."""
        if self._ser and self._ser.is_open:
            self._ser.close()

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    # -------------------------------------------------------------------------
    # Low-level transport
    # -------------------------------------------------------------------------

    def _send(self, cmd: str) -> str:
        """Send a command string and return the response line."""
        with self._lock:
            self._ser.reset_input_buffer()
            self._ser.write((cmd + self.LINE_ENDING).encode("ascii"))
            self._ser.flush()
            line = self._ser.readline().decode("ascii", errors="replace").strip()
            return line

    def _send_json(self, cmd: str) -> Any:
        """Send a command that returns JSON; parse and return the dict/list."""
        raw = self._send(cmd)
        if not raw:
            raise FL1PowerError(f"No response to: {cmd}")
        if raw.startswith("ERROR"):
            raise FL1PowerError(f"Board error: {raw}")
        try:
            return json.loads(raw)
        except json.JSONDecodeError as e:
            raise FL1PowerError(f"JSON parse failed: {e}\nRaw: {raw!r}")

    def _send_ok(self, cmd: str) -> str:
        """Send a command that returns OK/FAULT/ERROR; raise on error."""
        resp = self._send(cmd)
        if resp.startswith("ERROR"):
            raise FL1PowerError(f"Board error: {resp}")
        if resp.startswith("FAULT"):
            raise FL1PowerError(f"Board fault: {resp}")
        return resp

    # -------------------------------------------------------------------------
    # Voltage + current limit programming
    # -------------------------------------------------------------------------

    def set_voltage(self, rail: int, voltage_v: float) -> str:
        """Set output voltage for a rail.

        Args:
            rail:      Rail number 1–4
            voltage_v: Target voltage in volts (0–25 V)

        Returns:
            Board acknowledgement string
        """
        self._validate_rail(rail)
        if not (0.0 <= voltage_v <= 25.0):
            raise ValueError(f"voltage {voltage_v} out of range [0, 25] V")
        return self._send_ok(f"SET RAIL{rail} {voltage_v:.4f}V")

    def set_limit(self, rail: int, limit_ma: float) -> str:
        """Set overcurrent trip threshold for a rail.

        Args:
            rail:     Rail number 1–4
            limit_ma: Current limit in milliamps (0–10000 mA)

        Returns:
            Board acknowledgement string
        """
        self._validate_rail(rail)
        if not (0.0 <= limit_ma <= 10000.0):
            raise ValueError(f"limit {limit_ma} mA out of range [0, 10000]")
        return self._send_ok(f"SET LIMIT RAIL{rail} {int(limit_ma)}mA")

    # -------------------------------------------------------------------------
    # Enable / disable
    # -------------------------------------------------------------------------

    def enable(self, rail: int) -> str:
        """Enable output relay for a rail (runs PRE_CHECK first).

        Args:
            rail: Rail number 1–4 or "ALL"

        Returns:
            Board acknowledgement string

        Raises:
            FL1PowerError: if pre-check fails or rail is in FAULT
        """
        if rail == "ALL":
            return self._send_ok("ENABLE ALL")
        self._validate_rail(rail)
        return self._send_ok(f"ENABLE RAIL{rail}")

    def enable_all(self) -> str:
        """Enable all 4 rails in configured sequence."""
        return self._send_ok("ENABLE ALL")

    def disable(self, rail) -> str:
        """Disable output relay for a rail.

        Args:
            rail: Rail number 1–4 or "ALL"
        """
        if rail == "ALL":
            return self._send_ok("DISABLE ALL")
        self._validate_rail(rail)
        return self._send_ok(f"DISABLE RAIL{rail}")

    def disable_all(self) -> str:
        """Disable all 4 rails simultaneously."""
        return self._send_ok("DISABLE ALL")

    # -------------------------------------------------------------------------
    # Fault handling
    # -------------------------------------------------------------------------

    def clear_fault(self, rail: int) -> str:
        """Clear SR latch fault for a rail (resets fast-trip MOSFET).

        Args:
            rail: Rail number 1–4

        Returns:
            Board acknowledgement string
        """
        self._validate_rail(rail)
        return self._send_ok(f"CLEAR FAULT RAIL{rail}")

    # -------------------------------------------------------------------------
    # Discharge
    # -------------------------------------------------------------------------

    def set_discharge(self, rail: int) -> str:
        """Trigger discharge relay for a rail (100Ω load path, ~500ms).

        Args:
            rail: Rail number 1–4

        Returns:
            Board acknowledgement string
        """
        self._validate_rail(rail)
        return self._send_ok(f"SET DISCHARGE RAIL{rail}")

    # -------------------------------------------------------------------------
    # Telemetry
    # -------------------------------------------------------------------------

    def read_telemetry(self) -> Dict[str, Any]:
        """Read full board telemetry as a parsed dict.

        Returns:
            Dict matching telemetry_schema.json:
            {
                "timestamp_ms": int,
                "board_id": str,
                "rails": [
                    {
                        "rail_id": 1,
                        "state": "ON",
                        "voltage_v": 3.300,
                        "current_a": 0.250,
                        "power_w": 0.825,
                        "energy_wh": 0.000229,
                        "peak_current_a": 0.500,
                        "peak_voltage_v": 3.310,
                        "fault_code": 0,
                        ...
                    }, ...
                ],
                "coil_rail": {"voltage_v": 5.01, "current_a": 0.12, "power_w": 0.60}
            }
        """
        return self._send_json("READ TELEMETRY")

    def read_rail(self, rail: int) -> Dict[str, Any]:
        """Read telemetry for a single rail.

        Returns:
            Single rail dict from telemetry response
        """
        self._validate_rail(rail)
        tel = self.read_telemetry()
        return tel["rails"][rail - 1]

    def read_faults(self) -> List[Dict[str, Any]]:
        """Read fault log ring buffer (last 32 entries).

        Returns:
            List of fault dicts:
            [{"rail": 1, "type": "OCP", "timestamp_ms": 12345, "i_peak_a": 5.2}, ...]
        """
        return self._send_json("READ FAULTS")

    # -------------------------------------------------------------------------
    # Self-test
    # -------------------------------------------------------------------------

    def run_selftest(self) -> Dict[str, Any]:
        """Run full board self-test.

        Returns:
            Dict with "pass" (bool), "tests" (list), "duration_ms" (int)

        Raises:
            FL1PowerError: if board returns an error response
        """
        resp = self._send_json("RUN SELFTEST")
        return resp

    # -------------------------------------------------------------------------
    # Sequencing
    # -------------------------------------------------------------------------

    def set_sequence(self, order: List[int], delay_ms: int = 100) -> str:
        """Set the power-up sequence order and inter-rail delay.

        Args:
            order:    List of rail numbers in enable order, e.g. [1, 2, 3, 4]
            delay_ms: Milliseconds between enabling each rail

        Returns:
            Board acknowledgement string
        """
        payload = json.dumps({"order": order, "delay_ms": delay_ms})
        return self._send_ok(f"SEQUENCE {payload}")

    # -------------------------------------------------------------------------
    # Convenience helpers
    # -------------------------------------------------------------------------

    def configure_rail(self, rail: int, voltage_v: float, limit_ma: float) -> None:
        """Configure voltage and current limit for a rail (does not enable).

        Args:
            rail:      Rail number 1–4
            voltage_v: Target voltage in volts
            limit_ma:  Current limit in milliamps
        """
        self.set_voltage(rail, voltage_v)
        self.set_limit(rail, limit_ma)

    def power_up_all(
        self,
        configs: Optional[List[Dict]] = None,
        sequence: Optional[List[int]] = None,
        delay_ms: int = 100,
    ) -> Dict[str, Any]:
        """Configure and enable all rails in sequence.

        Args:
            configs:  List of {"rail": n, "voltage_v": v, "limit_ma": i} dicts.
                      If None, uses current rail setpoints.
            sequence: Enable order (default [1,2,3,4])
            delay_ms: Inter-rail delay in milliseconds

        Returns:
            Final telemetry dict after all rails are on
        """
        if configs:
            for cfg in configs:
                self.configure_rail(cfg["rail"], cfg["voltage_v"], cfg.get("limit_ma", 5000))
        if sequence:
            self.set_sequence(sequence, delay_ms)
        self.enable_all()
        time.sleep(0.2)   # settle
        return self.read_telemetry()

    def power_down_all(self) -> None:
        """Disable all rails."""
        self.disable_all()

    def get_voltage(self, rail: int) -> float:
        """Return calibrated output voltage for a rail in volts."""
        return self.read_rail(rail)["voltage_v"]

    def get_current(self, rail: int) -> float:
        """Return calibrated output current for a rail in amps."""
        return self.read_rail(rail)["current_a"]

    def get_power(self, rail: int) -> float:
        """Return instantaneous power for a rail in watts."""
        return self.read_rail(rail)["power_w"]

    def get_state(self, rail: int) -> str:
        """Return state machine state for a rail."""
        return self.read_rail(rail)["state"]

    def is_faulted(self, rail: int) -> bool:
        """Return True if a rail is in FAULT state."""
        return self.get_state(rail) == "FAULT"

    def wait_for_stable(self, rail: int, timeout_s: float = 2.0,
                        tolerance_v: float = 0.1) -> bool:
        """Wait until a rail's voltage is within tolerance of its setpoint.

        Args:
            rail:        Rail number 1–4
            timeout_s:   Maximum wait time in seconds
            tolerance_v: Acceptable voltage deviation in volts

        Returns:
            True if stable within timeout, False if timed out or faulted
        """
        self._validate_rail(rail)
        r      = self.read_rail(rail)
        target = r["set_voltage_v"]
        t_end  = time.time() + timeout_s

        while time.time() < t_end:
            r = self.read_rail(rail)
            if r["state"] == "FAULT":
                return False
            if abs(r["voltage_v"] - target) <= tolerance_v:
                return True
            time.sleep(0.05)
        return False

    # -------------------------------------------------------------------------
    # Internal
    # -------------------------------------------------------------------------

    @staticmethod
    def _validate_rail(rail):
        if not isinstance(rail, int) or not (1 <= rail <= 4):
            raise ValueError(f"rail must be 1–4, got {rail!r}")

    @staticmethod
    def find_port() -> Optional[str]:
        """Scan for FL-1 power board USB CDC port by VID:PID 2E8A:0005.

        Returns:
            Port path string or None if not found
        """
        try:
            import serial.tools.list_ports
            for p in serial.tools.list_ports.comports():
                if p.vid == 0x2E8A and p.pid == 0x0005:
                    return p.device
        except Exception:
            pass
        return None
