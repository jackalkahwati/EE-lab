"""
FL1ELoadController — host-side Python library for FL-1 Electronic Load + Discharge Board.

Communicates with board firmware over USB CDC (serial JSON protocol).
Thread-safe via threading.Lock. Auto-detects port if not specified.
Auto-reconnects on serial disconnect (retries 3x).
"""

import glob
import json
import sys
import threading
import time
from typing import Any, Dict, List, Optional, Union


def _find_cdc_port() -> Optional[str]:
    """Auto-detect USB CDC port for Pico."""
    if sys.platform.startswith("win"):
        # Enumerate COM ports — caller should specify if multiple Picos attached
        import serial.tools.list_ports
        for p in serial.tools.list_ports.comports():
            if "2E8A" in (p.vid and f"{p.vid:04X}" or ""):  # Raspberry Pi VID
                return p.device
    else:
        for pattern in ["/dev/ttyACM*", "/dev/ttyUSB*", "/dev/cu.usbmodem*"]:
            ports = glob.glob(pattern)
            if ports:
                return sorted(ports)[0]
    return None


class FL1ELoadController:
    """
    Host controller for FL-1 Electronic Load + Discharge Board Rev A.

    Args:
        port: Serial port path (e.g. '/dev/ttyACM0', 'COM3'). If None, auto-detected.
        baud: Serial baud rate (default 115200; Pico USB CDC ignores this).
        timeout: Read timeout in seconds (default 2.0).
    """

    def __init__(self, port: Optional[str] = None, baud: int = 115200, timeout: float = 2.0) -> None:
        import serial  # type: ignore
        self._serial_cls = serial.Serial
        self._port    = port or _find_cdc_port()
        self._baud    = baud
        self._timeout = timeout
        self._lock    = threading.Lock()
        self._ser     = None
        self._connect()

    def _connect(self) -> None:
        import serial  # type: ignore
        if self._port is None:
            raise RuntimeError("No FL-1 USB CDC port found. Specify port= explicitly.")
        self._ser = serial.Serial(self._port, self._baud, timeout=self._timeout)
        # Flush any startup noise
        time.sleep(0.1)
        self._ser.reset_input_buffer()

    def _reconnect(self) -> None:
        for attempt in range(3):
            try:
                if self._ser and self._ser.is_open:
                    self._ser.close()
                time.sleep(0.5 * (attempt + 1))
                self._connect()
                return
            except Exception as e:
                if attempt == 2:
                    raise RuntimeError(f"FL-1 reconnect failed after 3 attempts: {e}") from e

    def _send(self, cmd: str) -> Dict[str, Any]:
        """Send command, return parsed JSON response. Thread-safe."""
        with self._lock:
            for attempt in range(3):
                try:
                    self._ser.write((cmd + "\n").encode())
                    line = self._ser.readline().decode().strip()
                    if not line:
                        raise TimeoutError(f"No response to: {cmd}")
                    return json.loads(line)
                except Exception as e:
                    if attempt < 2:
                        self._reconnect()
                    else:
                        raise RuntimeError(f"Command '{cmd}' failed: {e}") from e
        return {}

    def set_current(self, ch: int, ma: float) -> Dict[str, Any]:
        """Set constant-current setpoint for channel (1-4). Does not enable load."""
        return self._send(f"SET LOAD{ch} {ma:.1f}")

    def set_resistance(self, ch: int, ohm: float) -> Dict[str, Any]:
        """Set constant-resistance setpoint for channel (1-4). Does not enable load."""
        return self._send(f"SET RESIST{ch} {ohm:.4f}")

    def set_power(self, ch: int, mw: float) -> Dict[str, Any]:
        """Set constant-power setpoint for channel (1-4). Does not enable load."""
        return self._send(f"SET POWER{ch} {mw:.1f}")

    def enable(self, ch_or_all: Union[int, str]) -> Dict[str, Any]:
        """Enable load channel. ch_or_all can be 1-4 or 'all'."""
        if str(ch_or_all).lower() == "all":
            return self._send("ENABLE ALL")
        return self._send(f"ENABLE LOAD{ch_or_all}")

    def disable(self, ch_or_all: Union[int, str]) -> Dict[str, Any]:
        """Disable (open relay, set DAC=0) for channel or all channels."""
        if str(ch_or_all).lower() == "all":
            return self._send("DISABLE ALL")
        return self._send(f"DISABLE LOAD{ch_or_all}")

    def start_pulse(self, ch: int, duty: float, freq_hz: float, high_ma: float) -> Dict[str, Any]:
        """
        Start pulse load mode on channel.

        Args:
            ch: Channel number (1-4).
            duty: Duty cycle 0.0-1.0 (e.g. 0.5 = 50%).
            freq_hz: Pulse frequency in Hz.
            high_ma: High-state current in mA.
        """
        duty_pct = duty * 100.0
        return self._send(f"START PULSE {ch} {duty_pct:.1f} {freq_hz:.2f} {high_ma:.1f}")

    def start_transient(self, ch: int, low_ma: float, high_ma: float) -> Dict[str, Any]:
        """
        Start step-load transient mode on channel.

        Args:
            ch: Channel number (1-4).
            low_ma: Low-state current in mA.
            high_ma: High-state current in mA.
        """
        return self._send(f"START TRANSIENT {ch} {low_ma:.1f} {high_ma:.1f}")

    def run_discharge(self, ch: int, timeout: float = 30.0) -> Dict[str, Any]:
        """
        Start discharge mode and poll until complete (V < 0.1V) or timeout.

        Args:
            ch: Channel number (1-4).
            timeout: Max wait time in seconds (default 30).

        Returns:
            Final telemetry dict with discharge result.
        """
        self._send(f"RUN DISCHARGE {ch}")
        deadline = time.time() + timeout
        while time.time() < deadline:
            telem = self.read_telemetry()
            ch_data = telem["channels"][ch - 1]
            if ch_data["state"] == "IDLE" or ch_data["v"] < 0.1:
                return {"done": True, "final": ch_data}
            time.sleep(0.5)
        return {"done": False, "reason": "timeout"}

    def read_telemetry(self) -> Dict[str, Any]:
        """
        Read telemetry from all channels.

        Returns:
            Dict with keys: ts_ms, channels (list), coil_v, coil_ma, fan_pct, fan_rpm.
        """
        return self._send("READ TELEMETRY")

    def read_faults(self) -> List[Dict[str, Any]]:
        """Return list of fault events logged since power-up."""
        resp = self._send("READ FAULTS")
        return resp.get("faults", [])

    def run_selftest(self) -> Dict[str, Any]:
        """
        Run built-in self-test sequence.

        Returns:
            Dict with pass/fail per test (keys: ina219_all, mcp4728_lo/hi, eeprom,
            relay_ch1_click, therm_ch1-4, fan_pwm, overall).
        """
        resp = self._send("RUN SELFTEST")
        return resp.get("results", resp)

    def set_fan(self, pct: int) -> Dict[str, Any]:
        """
        Manually override fan speed (0-100%). Set to auto by not calling this.

        Args:
            pct: Fan speed 0-100.
        """
        return self._send(f"SET FAN {max(0, min(100, int(pct)))}")

    def status(self) -> Dict[str, Any]:
        """Return board identity dict (board type, rev, temps, fan, channel states)."""
        return self._send("STATUS")

    def capture(self, ch: int) -> List[Dict[str, Any]]:
        """
        Retrieve inrush capture buffer for channel (populated on CC/CR/CP mode entry).

        Returns:
            List of {v, i_ma} samples captured at ~860 SPS for first 100ms.
        """
        resp = self._send(f"CAPTURE {ch}")
        return resp.get("samples", [])

    def close(self) -> None:
        """Close serial connection."""
        with self._lock:
            if self._ser and self._ser.is_open:
                self._ser.close()

    def __enter__(self) -> "FL1ELoadController":
        return self

    def __exit__(self, *args: Any) -> None:
        self.close()
