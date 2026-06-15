"""
FL1IoController — host-side Python library for FL-1 I/O Card Rev A.

Communicates via USB CDC serial port to the RP2350 firmware.
Thread-safe, auto-reconnect, full type hints.

Usage:
    from host_library import FL1IoController
    io = FL1IoController("/dev/ttyACM0")
    io.connect()
    print(io.read_ai(1))       # single GP ADC channel
    print(io.read_telemetry()) # full telemetry dict
    io.set_ao(1, 2.5)          # set AO1 to 2.5V
    io.outputs_off()           # emergency all-off
"""

from __future__ import annotations

import json
import serial
import threading
import time
import logging
from typing import Dict, List, Optional, Union

logger = logging.getLogger(__name__)

BOARD_TYPE = "FL1-IOCRD"


class FL1IoController:
    """Thread-safe serial controller for FL-1 I/O Card Rev A."""

    def __init__(
        self,
        port: str,
        baudrate: int = 115200,
        timeout: float = 2.0,
        auto_reconnect: bool = True,
    ) -> None:
        self._port = port
        self._baudrate = baudrate
        self._timeout = timeout
        self._auto_reconnect = auto_reconnect
        self._ser: Optional[serial.Serial] = None
        self._lock = threading.Lock()
        self._connected = False

    # ------------------------------------------------------------------
    # Connection management
    # ------------------------------------------------------------------
    def connect(self) -> bool:
        """Open serial connection to the board."""
        with self._lock:
            try:
                self._ser = serial.Serial(
                    self._port,
                    self._baudrate,
                    timeout=self._timeout,
                )
                self._connected = True
                logger.info("Connected to FL-1 I/O Card on %s", self._port)
                return True
            except serial.SerialException as e:
                logger.error("Connect failed: %s", e)
                self._connected = False
                return False

    def disconnect(self) -> None:
        """Close serial connection."""
        with self._lock:
            if self._ser and self._ser.is_open:
                self._ser.close()
            self._connected = False

    def _reconnect(self) -> bool:
        """Attempt to reconnect."""
        logger.warning("Attempting reconnect to %s", self._port)
        time.sleep(1.0)
        return self.connect()

    def _send_command(self, cmd: str) -> Optional[dict]:
        """Send command and return parsed JSON response."""
        with self._lock:
            if not self._connected or self._ser is None:
                if self._auto_reconnect:
                    if not self._reconnect():
                        return None
                else:
                    return None
            try:
                self._ser.reset_input_buffer()
                self._ser.write((cmd + "\r\n").encode("ascii"))
                line = self._ser.readline().decode("ascii", errors="replace").strip()
                if not line:
                    return None
                if line.startswith("ERROR"):
                    logger.error("Board error for cmd '%s': %s", cmd, line)
                    return None
                return json.loads(line)
            except (serial.SerialException, json.JSONDecodeError, OSError) as e:
                logger.error("Command '%s' failed: %s", cmd, e)
                self._connected = False
                return None

    # ------------------------------------------------------------------
    # Analog inputs
    # ------------------------------------------------------------------
    def read_ai(self, ch: Optional[int] = None) -> Union[float, List[dict], None]:
        """Read GP ADC channel(s). ch=1-16 for single, None for all.
        Single: returns float (volts, 0-24V range).
        All: returns list of {"ch": int, "v": float, "raw": int}."""
        if ch is not None:
            resp = self._send_command(f"READ AI {ch}")
            if resp is None:
                return None
            return resp.get("v")
        else:
            return self._send_command("READ AI ALL")

    # ------------------------------------------------------------------
    # Precision differential ADC
    # ------------------------------------------------------------------
    def read_diff(self, ch: Optional[int] = None) -> Optional[Union[dict, List[dict]]]:
        """Read precision differential channel(s). ch=1-4 or None for all.
        Returns {"ch", "v", "range_mv", "pga"} or list thereof."""
        if ch is not None:
            return self._send_command(f"READ DIFF {ch}")
        else:
            return self._send_command("READ DIFF ALL")

    # ------------------------------------------------------------------
    # Analog outputs
    # ------------------------------------------------------------------
    def set_ao(self, ch: int, volts: float) -> bool:
        """Set analog output ch (1-4) to volts (0.0-5.0V). Returns True on success."""
        if ch < 1 or ch > 4:
            raise ValueError(f"AO channel must be 1-4, got {ch}")
        volts = max(0.0, min(5.0, volts))
        resp = self._send_command(f"SET AO {ch} {volts:.4f}")
        return bool(resp and resp.get("ok"))

    # ------------------------------------------------------------------
    # Digital inputs
    # ------------------------------------------------------------------
    def read_di(self, ch: Optional[int] = None) -> Union[bool, Dict[str, bool], None]:
        """Read digital input(s). ch=1-24 for single, None for all.
        Single: returns bool. All: returns dict {str(ch): bool}."""
        if ch is not None:
            resp = self._send_command(f"READ DI {ch}")
            if resp is None:
                return None
            return bool(resp.get("state"))
        else:
            return self._send_command("READ DI ALL")

    # ------------------------------------------------------------------
    # Digital outputs (low-side)
    # ------------------------------------------------------------------
    def set_do(self, ch: int, state: bool) -> bool:
        """Set DO_LS channel ch (1-16) HIGH/LOW. Returns True on success."""
        if ch < 1 or ch > 16:
            raise ValueError(f"DO channel must be 1-16, got {ch}")
        s = "HIGH" if state else "LOW"
        resp = self._send_command(f"SET DO {ch} {s}")
        return bool(resp and resp.get("ok"))

    # ------------------------------------------------------------------
    # GPIO direct outputs
    # ------------------------------------------------------------------
    def set_gpio(self, ch: int, state: bool) -> bool:
        """Set GPIO output ch (1-8) HIGH/LOW (3.3V). Returns True on success."""
        if ch < 1 or ch > 8:
            raise ValueError(f"GPIO channel must be 1-8, got {ch}")
        s = "HIGH" if state else "LOW"
        resp = self._send_command(f"SET GPIO {ch} {s}")
        return bool(resp and resp.get("ok"))

    # ------------------------------------------------------------------
    # PWM excitation
    # ------------------------------------------------------------------
    def set_pwm(self, ch: int, duty_pct: int) -> bool:
        """Set RTD excitation PWM duty cycle. ch=1|2, duty_pct=0-100."""
        if ch not in (1, 2):
            raise ValueError(f"PWM channel must be 1 or 2, got {ch}")
        duty_pct = max(0, min(100, int(duty_pct)))
        resp = self._send_command(f"SET PWM {ch} {duty_pct}")
        return bool(resp and resp.get("ok"))

    # ------------------------------------------------------------------
    # Environmental
    # ------------------------------------------------------------------
    def read_temperatures(self) -> Optional[dict]:
        """Read all temperatures: SHT31 + 5x NTC.
        Returns {"sht31_c": float, "sht31_rh": float, "ntc_1": float, ...}."""
        return self._send_command("READ TEMPERATURES")

    # ------------------------------------------------------------------
    # Safety interlocks
    # ------------------------------------------------------------------
    def read_interlocks(self) -> Optional[Dict[str, bool]]:
        """Read DI17-22 mapped to safety interlock labels.
        Returns {"ESTOP": bool, "DOOR_INTLK": bool, ...}."""
        return self._send_command("READ INTERLOCKS")

    # ------------------------------------------------------------------
    # Emergency stop
    # ------------------------------------------------------------------
    def outputs_off(self) -> bool:
        """Immediately set ALL DO_LS and GPIO outputs to LOW (emergency stop)."""
        resp = self._send_command("OUTPUTS OFF")
        return bool(resp and resp.get("ok"))

    # ------------------------------------------------------------------
    # Self-test
    # ------------------------------------------------------------------
    def run_selftest(self) -> Optional[dict]:
        """Run full board self-test sequence.
        Returns {"steps": [...], "pass": bool, "summary": str}."""
        return self._send_command("RUN SELFTEST")

    # ------------------------------------------------------------------
    # Calibration
    # ------------------------------------------------------------------
    def calibrate_adc(self) -> Optional[dict]:
        """Run ADS1256 self-calibration. Returns {"status": "OK", ...}."""
        return self._send_command("CALIBRATE ADC")

    def calibrate_dac(self) -> Optional[dict]:
        """Run DAC loopback calibration (requires AO1->AI1 jumper).
        Returns {"ao1_setpoint": float, "ai1_readback": float, ...}."""
        return self._send_command("CALIBRATE DAC")

    # ------------------------------------------------------------------
    # Full telemetry
    # ------------------------------------------------------------------
    def read_telemetry(self) -> Optional[dict]:
        """Read full board telemetry in one JSON response.
        Returns dict matching telemetry_schema.json (see docs/)."""
        return self._send_command("READ TELEMETRY")

    # ------------------------------------------------------------------
    # Status
    # ------------------------------------------------------------------
    def status(self) -> Optional[dict]:
        """Read board identity, FW version, uptime."""
        return self._send_command("STATUS")

    # ------------------------------------------------------------------
    # Context manager support
    # ------------------------------------------------------------------
    def __enter__(self) -> "FL1IoController":
        self.connect()
        return self

    def __exit__(self, *args) -> None:
        self.disconnect()
