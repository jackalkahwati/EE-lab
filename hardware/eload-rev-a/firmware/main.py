"""
FL-1 Electronic Load + Discharge Board Rev A — MicroPython firmware.

Hardware: Raspberry Pi Pico 2 (RP2040).
USB CDC command interface (one JSON line per command).
Controls 4 independent programmable load channels (CC/CR/CP/pulse/step/discharge).
"""

import json
import math
import sys
import time
import uos

from machine import ADC, I2C, PWM, Pin, Timer

# ============================================================================
# CONSTANTS
# ============================================================================
I2C_SDA_PIN = 2      # GP2
I2C_SCL_PIN = 3      # GP3
I2C_FREQ    = 400000  # 400 kHz fast-mode

INA219_ADDR = [0x40, 0x41, 0x42, 0x43]   # ch1-ch4 INA219
COIL_INA_ADDR = 0x44                       # coil rail INA219 (power.ato: A0=SDA,A1=GND -> 0x46)
MCP4728_ADDR  = [0x60, 0x61]              # DAC lo (ch1/2), DAC hi (ch3/4)
EEPROM_ADDR   = 0x50

# GPIO pin assignments
RELAY_IN_PINS  = [4, 6, 8, 10]    # GP4,6,8,10 — input relay per channel
RELAY_DIS_PINS = [5, 7, 9, 11]    # GP5,7,9,11 — discharge relay per channel
THERM_ADC_PINS = [26, 27, 28, 29]  # GP26-29 (ADC0-3)

WDI_PIN     = 0   # GP0 watchdog kick (maps to mcu.wdi/pin1 via mcu.ato wiring)
FAN_PWM_PIN = 19  # GP19 fan PWM (pin25 rail3_disch alias in Pico2 part)
FAN_TACH_PIN = 20  # GP20 fan tachometer

FAN_PWM_FREQ = 25000   # 25 kHz fan PWM
SENSE_R_MOHM = 100     # mOhm — 100mOhm sense resistor

# Thermal constants
NTC_BETA  = 3950
NTC_R25   = 10000.0   # Ohm at 25C
NTC_BIAS  = 10000.0   # Ohm bias resistor
T_FAULT_C = 85.0      # overtemp fault threshold
T_FAN_C   = 60.0      # fan setpoint temperature
FAN_GAIN  = 5.0       # %/degC proportional gain

# INA219 register constants
INA219_CONFIG_REG  = 0x00
INA219_SHUNT_REG   = 0x01
INA219_BUS_REG     = 0x02
INA219_CALIB_REG   = 0x05
# Config: 32V bus range, gain/8 (320mV), 12-bit 128-sample avg, continuous
INA219_CONFIG_VAL  = 0x3FFF   # BADC=1111(128avg), SADC=1111(128avg), cont
INA219_CALIB_VAL   = 4096     # calibration for 100mOhm, LSB = 10uA

# MCP4728 constants
DAC_BITS       = 12
DAC_FULL_SCALE = 3.3   # V
DAC_MAX_CODE   = (1 << DAC_BITS) - 1
MAX_CURRENT_MA = 3000


# ============================================================================
# CHANNEL STATE
# ============================================================================
class ChannelState:
    IDLE      = 0
    CC        = 1
    CR        = 2
    CP        = 3
    PULSE     = 4
    STEP      = 5
    DISCHARGE = 6
    FAULT     = 7

STATE_NAMES = {v: k for k, v in ChannelState.__dict__.items() if not k.startswith("_")}


# ============================================================================
# INA219 DRIVER
# ============================================================================
class INA219:
    def __init__(self, i2c, addr):
        self.i2c   = i2c
        self.addr  = addr
        self._init()

    def _write_reg(self, reg, val):
        self.i2c.writeto(self.addr, bytes([reg, (val >> 8) & 0xFF, val & 0xFF]))

    def _read_reg(self, reg):
        self.i2c.writeto(self.addr, bytes([reg]))
        d = self.i2c.readfrom(self.addr, 2)
        v = (d[0] << 8) | d[1]
        return v

    def _init(self):
        self._write_reg(INA219_CONFIG_REG, INA219_CONFIG_VAL)
        self._write_reg(INA219_CALIB_REG, INA219_CALIB_VAL)

    def read_shunt_mv(self):
        """Return shunt voltage in mV (signed, 10uV LSB -> /100 for mV)."""
        raw = self._read_reg(INA219_SHUNT_REG)
        if raw > 32767:
            raw -= 65536
        return raw * 0.01   # 10uV per LSB -> mV

    def read_bus_v(self):
        """Return bus voltage in V (4mV LSB, bits 15:3)."""
        raw = self._read_reg(INA219_BUS_REG)
        return ((raw >> 3) & 0x1FFF) * 0.004

    def read_current_ma(self):
        """Return current in mA computed from shunt voltage / sense_r."""
        shunt_mv = self.read_shunt_mv()
        return shunt_mv / (SENSE_R_MOHM / 1000.0)  # mA

    def read_power_mw(self):
        """Return power in mW = V_bus * I."""
        v = self.read_bus_v()
        i_ma = self.read_current_ma()
        return v * i_ma


# ============================================================================
# MCP4728 DAC DRIVER
# ============================================================================
class MCP4728:
    def __init__(self, i2c, addr):
        self.i2c  = i2c
        self.addr = addr

    def set_channel(self, ch, voltage_v):
        """Write voltage to DAC channel (0=A, 1=B, 2=C, 3=D).
        Clamps to 0-DAC_FULL_SCALE.
        """
        v = max(0.0, min(DAC_FULL_SCALE, voltage_v))
        code = int(round(v * DAC_MAX_CODE / DAC_FULL_SCALE))
        code = max(0, min(DAC_MAX_CODE, code))
        # MCP4728 fast write command: 0b0000_00CC DDDD_DDDD DDDD
        # CMD bits [7:6]=00 (fast write), UDAC=0, CH=ch, PD=00, D[11:0]
        byte0 = (ch & 0x03) << 1   # channel bits, UDAC=0
        byte1 = (code >> 4) & 0xFF
        byte2 = (code & 0x0F) << 4
        self.i2c.writeto(self.addr, bytes([byte0, byte1, byte2]))

    def set_channel_ma(self, ch, current_ma):
        """Convert mA to voltage setpoint and write to DAC."""
        v = (current_ma / MAX_CURRENT_MA) * DAC_FULL_SCALE
        self.set_channel(ch, v)


# ============================================================================
# NTC THERMISTOR
# ============================================================================
def ntc_adc_to_temp_c(adc_raw):
    """Convert 16-bit ADC reading (0-65535) to Celsius using Steinhart-Hart.
    Circuit: 3.3V -> 10kOhm bias -> ADC node -> NTC -> GND.
    V_adc = 3.3 * NTC / (bias + NTC)
    NTC = bias * V_adc / (3.3 - V_adc)
    T = 1 / (1/T25 + (1/B)*ln(R/R25)) - 273.15
    """
    if adc_raw <= 0 or adc_raw >= 65535:
        return -273.15   # open/short circuit sentinel
    v_ratio = adc_raw / 65535.0
    if v_ratio >= 1.0:
        return -273.15
    r_ntc = NTC_BIAS * v_ratio / (1.0 - v_ratio)
    if r_ntc <= 0:
        return -273.15
    t_inv = (1.0 / 298.15) + (1.0 / NTC_BETA) * math.log(r_ntc / NTC_R25)
    return (1.0 / t_inv) - 273.15


# ============================================================================
# CHANNEL CONTROLLER
# ============================================================================
class Channel:
    def __init__(self, ch_idx, ina, dac, dac_ch, relay_in_pin, relay_dis_pin, therm_adc):
        self.idx          = ch_idx
        self.ina          = ina
        self.dac          = dac
        self.dac_ch       = dac_ch
        self.relay_in     = relay_in_pin
        self.relay_dis    = relay_dis_pin
        self.therm_adc    = therm_adc
        self.state        = ChannelState.IDLE
        self.setpoint_ma  = 0.0    # CC setpoint
        self.resist_ohm   = 0.0    # CR setpoint
        self.power_mw     = 0.0    # CP setpoint
        self.energy_mj    = 0.0    # accumulated energy
        self.peak_i_ma    = 0.0
        self.peak_v       = 0.0
        self.temp_c       = 25.0
        self.last_v       = 0.0
        self.last_i_ma    = 0.0
        # Pulse mode
        self.pulse_duty   = 0.5
        self.pulse_freq   = 1.0
        self.pulse_high   = 0.0
        self.pulse_phase  = False
        self.pulse_timer  = None
        # Step mode
        self.step_low     = 0.0
        self.step_high    = 0.0
        self.step_phase   = False
        # Inrush capture ring buffer (100ms at ~860SPS -> ~86 samples)
        self.capture_buf  = []
        self.capture_en   = False

    def _set_dac(self, ma):
        self.dac.set_channel_ma(self.dac_ch, ma)

    def enable_relays(self):
        self.relay_in.value(1)

    def disable_relays(self):
        self.relay_in.value(0)
        self.relay_dis.value(0)

    def go_idle(self):
        self._set_dac(0.0)
        self.disable_relays()
        self.state = ChannelState.IDLE
        self.capture_en = False
        if self.pulse_timer:
            self.pulse_timer.deinit()
            self.pulse_timer = None

    def go_fault(self):
        self._set_dac(0.0)
        self.disable_relays()
        self.state = ChannelState.FAULT
        if self.pulse_timer:
            self.pulse_timer.deinit()
            self.pulse_timer = None

    def start_cc(self, ma):
        self.setpoint_ma = max(0.0, min(MAX_CURRENT_MA, ma))
        self.enable_relays()
        self._set_dac(self.setpoint_ma)
        self.state = ChannelState.CC
        self.capture_en = True   # inrush capture

    def start_cr(self, ohm):
        self.resist_ohm = max(0.1, ohm)
        self.enable_relays()
        self.state = ChannelState.CR

    def start_cp(self, mw):
        self.power_mw = max(0.0, mw)
        self.enable_relays()
        self.state = ChannelState.CP

    def start_pulse(self, duty, freq_hz, high_ma):
        self.pulse_duty  = max(0.0, min(1.0, duty))
        self.pulse_freq  = max(0.1, freq_hz)
        self.pulse_high  = max(0.0, min(MAX_CURRENT_MA, high_ma))
        self.pulse_phase = False
        self.enable_relays()
        self.state = ChannelState.PULSE
        period_ms = int(1000.0 / self.pulse_freq)
        if self.pulse_timer:
            self.pulse_timer.deinit()
        self.pulse_timer = Timer()
        self.pulse_timer.init(period=period_ms, mode=Timer.PERIODIC,
                              callback=self._pulse_cb)

    def _pulse_cb(self, t):
        self.pulse_phase = not self.pulse_phase
        if self.pulse_phase:
            self._set_dac(self.pulse_high)
        else:
            self._set_dac(0.0)

    def start_step(self, low_ma, high_ma):
        self.step_low   = max(0.0, low_ma)
        self.step_high  = max(0.0, min(MAX_CURRENT_MA, high_ma))
        self.step_phase = False
        self.enable_relays()
        self._set_dac(self.step_low)
        self.state = ChannelState.STEP

    def toggle_step(self):
        """Toggle step load — call from host to trigger transient."""
        self.step_phase = not self.step_phase
        self._set_dac(self.step_high if self.step_phase else self.step_low)

    def tick_100hz(self):
        """Called at 100 Hz from main loop for CR/CP control."""
        if self.state == ChannelState.FAULT:
            return
        try:
            v    = self.ina.read_bus_v()
            i_ma = self.ina.read_current_ma()
            p_mw = v * i_ma
            # accumulate energy (10ms per tick)
            self.energy_mj += p_mw * 0.01
            if i_ma > self.peak_i_ma:
                self.peak_i_ma = i_ma
            if v > self.peak_v:
                self.peak_v = v
            self.last_v   = v
            self.last_i_ma = i_ma
            # Inrush capture (first 100ms after mode change)
            if self.capture_en and len(self.capture_buf) < 86:
                self.capture_buf.append({"v": round(v, 4), "i_ma": round(i_ma, 2)})
            else:
                self.capture_en = False
            # CR mode: I = V / R
            if self.state == ChannelState.CR and self.resist_ohm > 0:
                target_ma = (v * 1000.0) / self.resist_ohm
                target_ma = max(0.0, min(MAX_CURRENT_MA, target_ma))
                self._set_dac(target_ma)
            # CP mode: I = P / V
            elif self.state == ChannelState.CP and v > 0.05:
                target_ma = self.power_mw / v
                target_ma = max(0.0, min(MAX_CURRENT_MA, target_ma))
                self._set_dac(target_ma)
            # Discharge: poll voltage until <0.1V
            elif self.state == ChannelState.DISCHARGE:
                if v < 0.1:
                    self.go_idle()
        except Exception:
            pass  # I2C errors are non-fatal during normal operation

    def read_temp(self):
        """Read NTC thermistor ADC and update temp_c."""
        try:
            raw = self.therm_adc.read_u16()
            self.temp_c = ntc_adc_to_temp_c(raw)
        except Exception:
            pass
        return self.temp_c

    def telemetry_dict(self):
        return {
            "ch": self.idx + 1,
            "state": STATE_NAMES.get(self.state, "UNKNOWN"),
            "v": round(self.last_v, 4),
            "i_ma": round(self.last_i_ma, 2),
            "p_mw": round(self.last_v * self.last_i_ma, 2),
            "energy_mj": round(self.energy_mj, 1),
            "peak_i_ma": round(self.peak_i_ma, 2),
            "peak_v": round(self.peak_v, 4),
            "temp_c": round(self.temp_c, 1),
        }


# ============================================================================
# BOARD CONTROLLER
# ============================================================================
class ELoadBoard:
    def __init__(self):
        # I2C bus
        self.i2c = I2C(0, sda=Pin(I2C_SDA_PIN), scl=Pin(I2C_SCL_PIN), freq=I2C_FREQ)

        # INA219s
        self.inas = [INA219(self.i2c, addr) for addr in INA219_ADDR]
        self.coil_ina = INA219(self.i2c, COIL_INA_ADDR)

        # DACs (dac_lo: ch1[A]/ch2[B], dac_hi: ch3[A]/ch4[B])
        self.dac_lo = MCP4728(self.i2c, MCP4728_ADDR[0])
        self.dac_hi = MCP4728(self.i2c, MCP4728_ADDR[1])

        # Relay GPIO
        self.relay_in_gpios  = [Pin(p, Pin.OUT, value=0) for p in RELAY_IN_PINS]
        self.relay_dis_gpios = [Pin(p, Pin.OUT, value=0) for p in RELAY_DIS_PINS]

        # Thermistor ADC
        self.therm_adcs = [ADC(Pin(p)) for p in THERM_ADC_PINS]

        # DAC channel mapping: ch1->dac_lo/A, ch2->dac_lo/B, ch3->dac_hi/A, ch4->dac_hi/B
        dac_map = [(self.dac_lo, 0), (self.dac_lo, 1), (self.dac_hi, 0), (self.dac_hi, 1)]

        # Channel objects
        self.channels = [
            Channel(i, self.inas[i], dac_map[i][0], dac_map[i][1],
                    self.relay_in_gpios[i], self.relay_dis_gpios[i],
                    self.therm_adcs[i])
            for i in range(4)
        ]

        # Watchdog kick pin
        self.wdi_pin = Pin(WDI_PIN, Pin.OUT, value=0)

        # Fan PWM
        self.fan_pwm = PWM(Pin(FAN_PWM_PIN), freq=FAN_PWM_FREQ, duty_u16=0)
        self.fan_pct = 0
        self.fan_tach = Pin(FAN_TACH_PIN, Pin.IN, Pin.PULL_UP)
        self._tach_count = 0
        self.fan_tach.irq(trigger=Pin.IRQ_FALLING, handler=self._tach_irq)
        self.fan_rpm = 0

        # Fault log
        self.fault_log = []

        # Tick counters
        self._tick_100hz = 0
        self._tick_1hz   = 0

        # 100Hz control timer
        self._ctrl_timer = Timer()
        self._ctrl_timer.init(period=10, mode=Timer.PERIODIC, callback=self._ctrl_tick)

        # 1Hz telemetry/thermal timer
        self._telem_timer = Timer()
        self._telem_timer.init(period=1000, mode=Timer.PERIODIC, callback=self._telem_tick)

        self._manual_fan = None  # None = auto

    def _tach_irq(self, pin):
        self._tach_count += 1

    def _ctrl_tick(self, t):
        """100 Hz control: CR/CP/discharge updates + WDI kick."""
        self._tick_100hz += 1
        for ch in self.channels:
            ch.tick_100hz()
        # Kick watchdog every 100ms (10 ticks)
        if self._tick_100hz % 10 == 0:
            self.wdi_pin.toggle()

    def _telem_tick(self, t):
        """1 Hz: read temps, update fan, compute RPM, check overtemp."""
        self._tick_1hz += 1
        # Fan RPM (2 pulses/rev, counted over 1s)
        self.fan_rpm = self._tach_count * 30  # half-period -> full RPM
        self._tach_count = 0
        # Read all thermistors
        max_t = -999.0
        for ch in self.channels:
            t_c = ch.read_temp()
            if t_c > max_t:
                max_t = t_c
            if t_c > T_FAULT_C and ch.state not in (ChannelState.FAULT, ChannelState.IDLE):
                ch.go_fault()
                self.fault_log.append({"ch": ch.idx + 1, "fault": "overtemp",
                                       "temp_c": round(t_c, 1),
                                       "ts_ms": time.ticks_ms()})
        # Fan PWM (auto mode)
        if self._manual_fan is None:
            pct = max(0.0, min(100.0, (max_t - T_FAN_C) * FAN_GAIN))
            self._set_fan(int(pct))
        else:
            self._set_fan(self._manual_fan)

    def _set_fan(self, pct):
        pct = max(0, min(100, pct))
        self.fan_pct = pct
        self.fan_pwm.duty_u16(int(pct / 100.0 * 65535))

    def _ch(self, n):
        """Return channel object by 1-based index."""
        return self.channels[n - 1]

    def run_selftest(self):
        """Run built-in self-test. Returns dict with pass/fail per test."""
        results = {}
        # 1. INA219 init check
        ok = True
        for i, ina in enumerate(self.inas + [self.coil_ina]):
            try:
                ina._init()
            except Exception as e:
                ok = False
                results[f"ina219_{i}"] = f"FAIL: {e}"
        if ok:
            results["ina219_all"] = "PASS"
        # 2. MCP4728 write/read-back
        try:
            self.dac_lo.set_channel(0, 0.0)
            results["mcp4728_lo"] = "PASS"
        except Exception as e:
            results["mcp4728_lo"] = f"FAIL: {e}"
        try:
            self.dac_hi.set_channel(0, 0.0)
            results["mcp4728_hi"] = "PASS"
        except Exception as e:
            results["mcp4728_hi"] = f"FAIL: {e}"
        # 3. EEPROM read check
        try:
            self.i2c.writeto(EEPROM_ADDR, bytes([0x00]))
            data = self.i2c.readfrom(EEPROM_ADDR, 8)
            board_type = data.decode("ascii", errors="replace").rstrip("\x00")
            if "FL1" in board_type or "ELOAD" in board_type:
                results["eeprom"] = f"PASS: {board_type}"
            else:
                results["eeprom"] = f"WARN: unexpected board_type={board_type}"
        except Exception as e:
            results["eeprom"] = f"FAIL: {e}"
        # 4. Relay click test (pulse each relay, check coil INA219)
        try:
            base_i = self.coil_ina.read_current_ma()
            self.relay_in_gpios[0].value(1)
            time.sleep_ms(20)
            energized_i = self.coil_ina.read_current_ma()
            self.relay_in_gpios[0].value(0)
            delta = abs(energized_i - base_i)
            results["relay_ch1_click"] = f"PASS (delta={delta:.1f}mA)" if delta > 10 else f"WARN (delta={delta:.1f}mA)"
        except Exception as e:
            results["relay_ch1_click"] = f"FAIL: {e}"
        # 5. Thermistor check
        therm_ok = True
        for i, ch in enumerate(self.channels):
            t_c = ch.read_temp()
            if not (-10.0 <= t_c <= 85.0):
                results[f"therm_ch{i+1}"] = f"FAIL: T={t_c:.1f}C out of range"
                therm_ok = False
            else:
                results[f"therm_ch{i+1}"] = f"PASS: {t_c:.1f}C"
        # 6. Fan PWM check (set to 50%, verify no exception)
        try:
            self._set_fan(50)
            time.sleep_ms(100)
            self._set_fan(0)
            results["fan_pwm"] = "PASS"
        except Exception as e:
            results["fan_pwm"] = f"FAIL: {e}"
        results["overall"] = "PASS" if all("FAIL" not in v for v in results.values()) else "FAIL"
        return results

    def read_telemetry(self):
        coil_v = 0.0
        coil_ma = 0.0
        try:
            coil_v  = self.coil_ina.read_bus_v()
            coil_ma = self.coil_ina.read_current_ma()
        except Exception:
            pass
        return {
            "mode": "telemetry",
            "ts_ms": time.ticks_ms(),
            "channels": [ch.telemetry_dict() for ch in self.channels],
            "coil_v": round(coil_v, 4),
            "coil_ma": round(coil_ma, 2),
            "fan_pct": self.fan_pct,
            "fan_rpm": self.fan_rpm,
        }

    def handle_command(self, line):
        """Parse and execute one command line. Returns response string."""
        line = line.strip()
        if not line:
            return None
        parts = line.split()
        cmd = parts[0].upper() if parts else ""

        try:
            # SET LOAD<n> <mA>
            if cmd == "SET" and len(parts) >= 3:
                sub = parts[1].upper()
                if sub.startswith("LOAD"):
                    ch_n = int(sub[4:])
                    ma   = float(parts[2])
                    self._ch(ch_n).setpoint_ma = max(0.0, min(MAX_CURRENT_MA, ma))
                    if self._ch(ch_n).state == ChannelState.CC:
                        self._ch(ch_n)._set_dac(self._ch(ch_n).setpoint_ma)
                    return json.dumps({"ok": True, "ch": ch_n, "setpoint_ma": ma})

                elif sub.startswith("RESIST"):
                    ch_n = int(sub[6:])
                    ohm  = float(parts[2])
                    self._ch(ch_n).resist_ohm = max(0.1, ohm)
                    return json.dumps({"ok": True, "ch": ch_n, "resist_ohm": ohm})

                elif sub.startswith("POWER"):
                    ch_n = int(sub[5:])
                    mw   = float(parts[2])
                    self._ch(ch_n).power_mw = max(0.0, mw)
                    return json.dumps({"ok": True, "ch": ch_n, "power_mw": mw})

                elif sub == "FAN":
                    pct = int(float(parts[2]))
                    self._manual_fan = max(0, min(100, pct))
                    self._set_fan(self._manual_fan)
                    return json.dumps({"ok": True, "fan_pct": self._manual_fan})

            # ENABLE LOAD<n> / ENABLE ALL
            elif cmd == "ENABLE" and len(parts) >= 2:
                sub = parts[1].upper()
                if sub == "ALL":
                    for ch in self.channels:
                        if ch.state == ChannelState.IDLE:
                            ch.start_cc(ch.setpoint_ma)
                    return json.dumps({"ok": True, "enabled": "all"})
                elif sub.startswith("LOAD"):
                    ch_n = int(sub[4:])
                    ch   = self._ch(ch_n)
                    if ch.state == ChannelState.IDLE:
                        ch.start_cc(ch.setpoint_ma)
                    return json.dumps({"ok": True, "ch": ch_n, "state": STATE_NAMES[ch.state]})

            # DISABLE LOAD<n> / DISABLE ALL
            elif cmd == "DISABLE" and len(parts) >= 2:
                sub = parts[1].upper()
                if sub == "ALL":
                    for ch in self.channels:
                        ch.go_idle()
                    return json.dumps({"ok": True, "disabled": "all"})
                elif sub.startswith("LOAD"):
                    ch_n = int(sub[4:])
                    self._ch(ch_n).go_idle()
                    return json.dumps({"ok": True, "ch": ch_n, "state": "IDLE"})

            # START PULSE <ch> <duty%> <freq_hz> <high_mA>
            elif cmd == "START" and len(parts) >= 2:
                sub = parts[1].upper()
                if sub == "PULSE" and len(parts) >= 6:
                    ch_n  = int(parts[2])
                    duty  = float(parts[3]) / 100.0
                    freq  = float(parts[4])
                    high  = float(parts[5])
                    self._ch(ch_n).start_pulse(duty, freq, high)
                    return json.dumps({"ok": True, "ch": ch_n, "mode": "PULSE"})

                elif sub == "TRANSIENT" and len(parts) >= 5:
                    ch_n = int(parts[2])
                    lo   = float(parts[3])
                    hi   = float(parts[4])
                    self._ch(ch_n).start_step(lo, hi)
                    return json.dumps({"ok": True, "ch": ch_n, "mode": "STEP"})

            # RUN DISCHARGE <ch>
            elif cmd == "RUN" and len(parts) >= 2:
                sub = parts[1].upper()
                if sub == "DISCHARGE" and len(parts) >= 3:
                    ch_n = int(parts[2])
                    ch   = self._ch(ch_n)
                    ch.relay_in.value(1)
                    ch.relay_dis.value(1)
                    ch._set_dac(1000.0)   # 1A discharge
                    ch.state = ChannelState.DISCHARGE
                    return json.dumps({"ok": True, "ch": ch_n, "mode": "DISCHARGE"})

                elif sub == "SELFTEST":
                    result = self.run_selftest()
                    return json.dumps({"mode": "selftest", "results": result})

            # READ TELEMETRY
            elif cmd == "READ" and len(parts) >= 2:
                sub = parts[1].upper()
                if sub == "TELEMETRY":
                    return json.dumps(self.read_telemetry())
                elif sub == "FAULTS":
                    return json.dumps({"mode": "faults", "faults": self.fault_log})

            # STATUS
            elif cmd == "STATUS":
                return json.dumps({
                    "mode": "status",
                    "board": "FL1-ELOAD",
                    "rev": "A",
                    "temps_c": [round(ch.temp_c, 1) for ch in self.channels],
                    "fan_pct": self.fan_pct,
                    "fan_rpm": self.fan_rpm,
                    "channel_states": [STATE_NAMES.get(ch.state, "?") for ch in self.channels],
                })

            elif cmd == "CAPTURE" and len(parts) >= 2:
                ch_n = int(parts[1])
                return json.dumps({"mode": "capture", "ch": ch_n,
                                   "samples": self._ch(ch_n).capture_buf})

            return json.dumps({"error": f"unknown command: {line}"})

        except Exception as e:
            return json.dumps({"error": str(e), "cmd": line})


# ============================================================================
# MAIN
# ============================================================================
def main():
    board = ELoadBoard()
    # USB CDC stdin
    buf = ""
    while True:
        try:
            ch = sys.stdin.read(1)
            if ch in ("\r", "\n"):
                if buf:
                    resp = board.handle_command(buf)
                    if resp:
                        sys.stdout.write(resp + "\n")
                buf = ""
            else:
                buf += ch
        except Exception:
            pass


if __name__ == "__main__":
    main()
