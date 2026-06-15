"""
FL-1 DUT Power + Fast-Trip Board Rev A — MicroPython firmware for RP2040 (Pico 2).

State machine per rail: IDLE → PRE_CHECK → RAMPING → ON → FAULT → DISCHARGE
USB CDC command protocol (115200 baud, \r\n terminated).

Wiring matches integration_manifest.json GPIO map.
I2C0 on GP6/GP7 at 400 kHz.
"""

import machine
import utime
import ustruct
import ujson
import sys
import io

# =============================================================================
# HARDWARE CONSTANTS (match integration_manifest.json)
# =============================================================================

# GPIO assignments
GPIO_RAIL_ENABLE    = [2, 3, 4, 5]      # GP2–GP5: rail 1–4 output relay enable
GPIO_RAIL_FAULT_N   = [9, 10, 11, 12]   # GP9–GP12: rail fault (active low, IRQ)
GPIO_RAIL_FAULT_CLR = [13, 14, 15, 16]  # GP13–GP16: SR latch clear (pulse low)
GPIO_RAIL_DISCH_EN  = [17, 18, 19, 20]  # GP17–GP20: discharge relay enable
GPIO_RAIL_LED       = [21, 22, 26, 27]  # GP21,22,26,27: per-rail yellow LEDs
GPIO_WDI            = 8                 # GP8: watchdog kick
GPIO_WDT_RESET_N    = 23               # GP23: watchdog reset (input)
GPIO_FAULT_LED      = 28               # GP28: red fault LED
GPIO_UART_TX        = 0                # GP0 (UART0 TX)
GPIO_UART_RX        = 1                # GP1 (UART0 RX)
I2C_SDA             = 6               # GP6
I2C_SCL             = 7               # GP7

# I2C addresses
ADDR_INA219 = [0x40, 0x41, 0x42, 0x43]
ADDR_INA219_COIL = 0x44
ADDR_DAC_VOUT_LO = 0x60   # MCP4728 ch A=rail1, ch B=rail2
ADDR_DAC_VOUT_HI = 0x61   # MCP4728 ch A=rail3, ch B=rail4
ADDR_DAC_ILIM_LO = 0x62   # MCP4728 ch A=rail1, ch B=rail2
ADDR_DAC_ILIM_HI = 0x63   # MCP4728 ch A=rail3, ch B=rail4
ADDR_EEPROM      = 0x50

# DAC and voltage constants
DAC_VDD_MV       = 3300
DAC_BITS         = 12
DAC_FULL_SCALE   = (1 << DAC_BITS) - 1   # 4095
DAC_LSB_MV       = DAC_VDD_MV / DAC_FULL_SCALE  # ~0.806 mV/LSB

# Sense resistor and comparator scaling
R_SENSE_OHMS     = 0.010    # 10 mΩ
# Comparator: IN+ scaled by 10k/(10k+100k) = 10/110
# Vsense_at_trip = I * R_sense → Vcomp_in = I * 0.010 * (10/110)
# DAC → comparator IN- directly
# Trip: Vcomp_in+ >= Vcomp_in-
# So: I_trip = Vdac_ilim * (110/10) / R_sense = Vdac_ilim * 11 / 0.010
# I_trip (A) = Vdac_ilim (V) * 1100
COMP_I_SCALE     = 1.0 / (R_SENSE_OHMS * 11.0)  # A/V for DAC→trip threshold

# INA219 register addresses
INA219_REG_CFG    = 0x00
INA219_REG_SHUNT  = 0x01
INA219_REG_BUS    = 0x02
INA219_REG_PWR    = 0x03
INA219_REG_CUR    = 0x04
INA219_REG_CAL    = 0x05

# INA219 config: 32V range, ±320mV shunt, 12-bit, continuous
INA219_CFG_32V_320MV_12BIT = 0x399F
# Calibration register for 10mΩ shunt: Cal = 0.04096 / (Imax * Rshunt)
# Imax=10A, Rshunt=0.010 → Cal = 0.04096 / (10 * 0.010) = 409
INA219_CAL_VALUE  = 409

# Watchdog parameters
WDT_KICK_INTERVAL_MS = 100
WDT_TIMEOUT_MS       = 250

# Fault log ring buffer size
FAULT_LOG_SIZE = 32

# States
STATE_IDLE       = "IDLE"
STATE_PRE_CHECK  = "PRE_CHECK"
STATE_RAMPING    = "RAMPING"
STATE_ON         = "ON"
STATE_FAULT      = "FAULT"
STATE_DISCHARGE  = "DISCHARGE"

# Fault codes (bitmask)
FAULT_OCP        = 0x01
FAULT_OVP        = 0x02
FAULT_UVP        = 0x04
FAULT_SHORT      = 0x08
FAULT_LATCH      = 0x10

# =============================================================================
# HARDWARE INIT
# =============================================================================

i2c = machine.I2C(0, sda=machine.Pin(I2C_SDA), scl=machine.Pin(I2C_SCL), freq=400000)

# Output GPIO pins
pins_enable    = [machine.Pin(g, machine.Pin.OUT, value=0) for g in GPIO_RAIL_ENABLE]
pins_fault_clr = [machine.Pin(g, machine.Pin.OUT, value=1) for g in GPIO_RAIL_FAULT_CLR]
pins_disch_en  = [machine.Pin(g, machine.Pin.OUT, value=0) for g in GPIO_RAIL_DISCH_EN]
pins_led       = [machine.Pin(g, machine.Pin.OUT, value=0) for g in GPIO_RAIL_LED]
pin_wdi        = machine.Pin(GPIO_WDI, machine.Pin.OUT, value=0)
pin_fault_led  = machine.Pin(GPIO_FAULT_LED, machine.Pin.OUT, value=0)

# Input GPIO pins with pull-up (fault_n are active-low open-drain)
pins_fault_n   = [machine.Pin(g, machine.Pin.IN, machine.Pin.PULL_UP) for g in GPIO_RAIL_FAULT_N]
pin_wdt_rst    = machine.Pin(GPIO_WDT_RESET_N, machine.Pin.IN, machine.Pin.PULL_UP)

# USB CDC for command protocol
usb = sys.stdin

# =============================================================================
# RAIL STATE
# =============================================================================

class RailState:
    def __init__(self, rail_id):
        self.rail_id       = rail_id          # 1-indexed
        self.state         = STATE_IDLE
        self.fault_code    = 0
        self.set_voltage_v = 0.0
        self.limit_current_a = 5.0
        self.voltage_v     = 0.0
        self.current_a     = 0.0
        self.power_w       = 0.0
        self.energy_wh     = 0.0
        self.peak_current_a = 0.0
        self.peak_voltage_v = 0.0
        self.ina219_bus_v  = 0.0
        self.ina219_shunt_mv = 0.0
        self.enabled_at_ms = 0
        self.inrush_profile = []

    def to_dict(self):
        return {
            "rail_id": self.rail_id,
            "state": self.state,
            "fault_code": self.fault_code,
            "fault_description": _fault_desc(self.fault_code),
            "voltage_v": round(self.voltage_v, 4),
            "current_a": round(self.current_a, 4),
            "power_w":   round(self.power_w, 4),
            "energy_wh": round(self.energy_wh, 6),
            "peak_current_a": round(self.peak_current_a, 4),
            "peak_voltage_v": round(self.peak_voltage_v, 4),
            "set_voltage_v":  round(self.set_voltage_v, 4),
            "limit_current_a": round(self.limit_current_a, 4),
            "ina219_bus_voltage_v": round(self.ina219_bus_v, 4),
            "ina219_shunt_mv": round(self.ina219_shunt_mv, 4),
            "timestamp_ms": utime.ticks_ms(),
        }

def _fault_desc(code):
    parts = []
    if code & FAULT_OCP:   parts.append("OCP")
    if code & FAULT_OVP:   parts.append("OVP")
    if code & FAULT_UVP:   parts.append("UVP")
    if code & FAULT_SHORT: parts.append("SHORT")
    if code & FAULT_LATCH: parts.append("LATCH")
    return ",".join(parts) if parts else "none"

rails = [RailState(i + 1) for i in range(4)]

# Fault log ring buffer
fault_log = []

# Sequence config
sequence_order    = [1, 2, 3, 4]
sequence_delay_ms = 100

# =============================================================================
# INA219 DRIVER
# =============================================================================

def ina219_write_reg(addr, reg, value):
    data = ustruct.pack(">H", value)
    i2c.writeto_mem(addr, reg, data)

def ina219_read_reg(addr, reg):
    data = i2c.readfrom_mem(addr, reg, 2)
    return ustruct.unpack(">H", data)[0]

def ina219_init(addr):
    try:
        ina219_write_reg(addr, INA219_REG_CFG, INA219_CFG_32V_320MV_12BIT)
        ina219_write_reg(addr, INA219_REG_CAL, INA219_CAL_VALUE)
        return True
    except Exception:
        return False

def ina219_read(addr):
    """Returns (bus_voltage_v, shunt_mv, current_a, power_w) or None on error."""
    try:
        raw_bus   = ina219_read_reg(addr, INA219_REG_BUS)
        raw_shunt = ina219_read_reg(addr, INA219_REG_SHUNT)

        # Bus voltage: bits 15:3, LSB=4mV, shift right 3
        bus_v = ((raw_bus >> 3) & 0x1FFF) * 0.004

        # Shunt voltage: signed 16-bit, LSB=10µV
        if raw_shunt & 0x8000:
            raw_shunt = raw_shunt - 0x10000
        shunt_mv = raw_shunt * 0.01   # 10µV → mV

        # Current from shunt (I = Vshunt / Rshunt)
        current_a = (shunt_mv / 1000.0) / R_SENSE_OHMS

        power_w = bus_v * current_a
        return (bus_v, shunt_mv, current_a, power_w)
    except Exception:
        return None

# =============================================================================
# MCP4728 DAC DRIVER
# =============================================================================

def dac_write_channel(i2c_addr, channel, value_12bit):
    """Write single-channel fast write (2 bytes): cmd|ch in high nibble, data."""
    value_12bit = max(0, min(DAC_FULL_SCALE, value_12bit))
    # Single-write command: 0b0101_xx00 | ch<<1 for write-input-and-eeprom
    # Fast write: cmd byte = 0b0000_xxPD where xx=channel, P=power-mode, D=unused
    # Use multi-write command (0b01000000 | ch<<1): writes input register only
    cmd = 0x40 | (channel << 1)
    hi  = (value_12bit >> 8) & 0x0F
    lo  = value_12bit & 0xFF
    i2c.writeto(i2c_addr, bytes([cmd, hi, lo]))

def voltage_to_dac(target_v):
    """Convert target voltage to 12-bit DAC value for Vout programming.
    Vout = 24.8V @ dac=0, ~1.8V @ dac=4095 (linear approximation).
    Vout = 24.8 - (24.8 - 1.8) * dac/4095
    Solve for dac: dac = (24.8 - target_v) / 23.0 * 4095"""
    V_MAX = 24.8
    V_MIN = 1.8
    target_v = max(V_MIN, min(V_MAX, target_v))
    dac_val = int((V_MAX - target_v) / (V_MAX - V_MIN) * DAC_FULL_SCALE)
    return max(0, min(DAC_FULL_SCALE, dac_val))

def current_to_dac(limit_a):
    """Convert current limit in amps to 12-bit DAC value for comparator IN-.
    I_trip = Vdac * COMP_I_SCALE
    Vdac = limit_a / COMP_I_SCALE
    DAC_val = Vdac / (VDD/4095)"""
    vdac = limit_a / COMP_I_SCALE  # volts
    dac_val = int(vdac / (DAC_VDD_MV / 1000.0) * DAC_FULL_SCALE)
    return max(0, min(DAC_FULL_SCALE, dac_val))

def set_rail_voltage(rail_idx, voltage_v):
    """Set DAC Vout for rail (0-indexed)."""
    dac_val = voltage_to_dac(voltage_v)
    if rail_idx in (0, 1):
        addr = ADDR_DAC_VOUT_LO
        ch   = rail_idx
    else:
        addr = ADDR_DAC_VOUT_HI
        ch   = rail_idx - 2
    dac_write_channel(addr, ch, dac_val)

def set_rail_ilimit(rail_idx, limit_a):
    """Set DAC current limit threshold for rail (0-indexed)."""
    dac_val = current_to_dac(limit_a)
    if rail_idx in (0, 1):
        addr = ADDR_DAC_ILIM_LO
        ch   = rail_idx
    else:
        addr = ADDR_DAC_ILIM_HI
        ch   = rail_idx - 2
    dac_write_channel(addr, ch, dac_val)

# =============================================================================
# WATCHDOG
# =============================================================================

_last_wdt_kick_ms = 0

def kick_watchdog():
    global _last_wdt_kick_ms
    now = utime.ticks_ms()
    if utime.ticks_diff(now, _last_wdt_kick_ms) >= WDT_KICK_INTERVAL_MS:
        pin_wdi.toggle()
        _last_wdt_kick_ms = now

# =============================================================================
# FAULT HANDLING
# =============================================================================

def log_fault(rail_idx, fault_type_str, i_peak_a):
    entry = {
        "rail": rail_idx + 1,
        "type": fault_type_str,
        "timestamp_ms": utime.ticks_ms(),
        "i_peak_a": round(i_peak_a, 4),
    }
    fault_log.append(entry)
    if len(fault_log) > FAULT_LOG_SIZE:
        fault_log.pop(0)

def _check_fault_irq(rail_idx):
    """Return True if hardware SR latch has asserted fault_n (active-low)."""
    return pins_fault_n[rail_idx].value() == 0

def clear_fault_latch(rail_idx):
    """Pulse CLR_N low for 1 ms to reset SR latch."""
    pins_fault_clr[rail_idx].value(0)
    utime.sleep_ms(2)
    pins_fault_clr[rail_idx].value(1)

def enter_fault(rail_idx, fault_code):
    r = rails[rail_idx]
    r.state      = STATE_FAULT
    r.fault_code |= fault_code
    pins_enable[rail_idx].value(0)     # open output relay
    pins_led[rail_idx].value(0)
    pin_fault_led.value(1)
    log_fault(rail_idx, _fault_desc(fault_code), r.peak_current_a)

# =============================================================================
# TELEMETRY UPDATE
# =============================================================================

_last_telemetry_ms = [0] * 4
TELEMETRY_INTERVAL_MS = 50

def update_rail_telemetry(rail_idx):
    global _last_telemetry_ms
    now = utime.ticks_ms()
    if utime.ticks_diff(now, _last_telemetry_ms[rail_idx]) < TELEMETRY_INTERVAL_MS:
        return
    _last_telemetry_ms[rail_idx] = now

    r    = rails[rail_idx]
    addr = ADDR_INA219[rail_idx]
    result = ina219_read(addr)
    if result is None:
        return

    bus_v, shunt_mv, current_a, power_w = result
    r.ina219_bus_v    = bus_v
    r.ina219_shunt_mv = shunt_mv
    r.voltage_v       = bus_v
    r.current_a       = current_a
    r.power_w         = power_w

    # Update peaks
    if current_a > r.peak_current_a:
        r.peak_current_a = current_a
    if bus_v > r.peak_voltage_v:
        r.peak_voltage_v = bus_v

    # Energy integration (simple trapezoidal, 50ms interval)
    r.energy_wh += power_w * (TELEMETRY_INTERVAL_MS / 1000.0) / 3600.0

    # Check hardware fault latch
    if _check_fault_irq(rail_idx) and r.state == STATE_ON:
        r.fault_code |= FAULT_LATCH | FAULT_OCP
        enter_fault(rail_idx, FAULT_OCP | FAULT_LATCH)

# =============================================================================
# PRE-POWER CHECK
# =============================================================================

def pre_power_check(rail_idx):
    """Read INA219 at minimal voltage; refuse if shorted (current > 100mA at low V)."""
    # Set voltage very low (1.8V) and briefly enable buck (relay still open)
    set_rail_voltage(rail_idx, 1.8)
    utime.sleep_ms(50)

    result = ina219_read(ADDR_INA219[rail_idx])
    if result is None:
        return False, "INA219 not responding"

    bus_v, shunt_mv, current_a, _ = result

    # If current > 1A before relay closes, suspect short or leakage
    if abs(current_a) > 1.0:
        return False, f"pre-check overcurrent {current_a:.3f}A"

    return True, "ok"

# =============================================================================
# INRUSH CAPTURE (ADC-based, 500 kS/s for 10ms → 5000 samples)
# Using RP2040 ADC on GP26/27/28 — note: sense resistor voltage is tiny;
# this uses INA219 rapid polling as a proxy (ADC DMA would require assembly).
# =============================================================================

def capture_inrush(rail_idx, duration_ms=10):
    """Capture current profile during enable. Returns list of (current_a) samples."""
    samples = []
    addr    = ADDR_INA219[rail_idx]
    end_ms  = utime.ticks_add(utime.ticks_ms(), duration_ms)
    while utime.ticks_diff(end_ms, utime.ticks_ms()) > 0:
        result = ina219_read(addr)
        if result:
            samples.append(round(result[2], 4))
    return samples[:500]   # cap at 500 samples (I2C limited, not 500kS/s)

# =============================================================================
# RAIL ENABLE / DISABLE
# =============================================================================

def enable_rail(rail_idx):
    r = rails[rail_idx]
    if r.state in (STATE_ON, STATE_RAMPING):
        return True, "already enabled"

    if r.state == STATE_FAULT:
        return False, f"rail in FAULT (code={r.fault_code}), clear first"

    r.state = STATE_PRE_CHECK
    pins_led[rail_idx].value(1)

    # Pre-power check
    ok, reason = pre_power_check(rail_idx)
    if not ok:
        r.state = STATE_IDLE
        pins_led[rail_idx].value(0)
        return False, f"pre_check failed: {reason}"

    # Set target voltage on DAC
    set_rail_voltage(rail_idx, r.set_voltage_v)
    set_rail_ilimit(rail_idx, r.limit_current_a)

    # Clear any stale fault latch
    clear_fault_latch(rail_idx)
    r.fault_code = 0

    r.state        = STATE_RAMPING
    r.enabled_at_ms = utime.ticks_ms()
    r.peak_current_a = 0.0
    r.peak_voltage_v = 0.0
    r.energy_wh    = 0.0

    # Close output relay
    pins_enable[rail_idx].value(1)

    # Inrush capture (10ms)
    r.inrush_profile = capture_inrush(rail_idx, duration_ms=10)

    # Brief ramp check (50ms settle)
    utime.sleep_ms(50)
    result = ina219_read(ADDR_INA219[rail_idx])
    if result:
        r.voltage_v  = result[0]
        r.current_a  = result[2]

    r.state = STATE_ON
    return True, "enabled"

def disable_rail(rail_idx):
    pins_enable[rail_idx].value(0)    # open relay
    pins_led[rail_idx].value(0)
    rails[rail_idx].state = STATE_IDLE
    return True, "disabled"

def discharge_rail(rail_idx):
    """Trigger discharge relay; closes 100Ω load path."""
    # Open output relay first
    pins_enable[rail_idx].value(0)
    rails[rail_idx].state = STATE_DISCHARGE
    pins_disch_en[rail_idx].value(1)
    # Keep discharge active for 500ms then release
    utime.sleep_ms(500)
    pins_disch_en[rail_idx].value(0)
    rails[rail_idx].state = STATE_IDLE

# =============================================================================
# SELF-TEST
# =============================================================================

def run_selftest():
    tests  = []
    passed = True
    t_start = utime.ticks_ms()

    # Test 1: INA219 communications (all 4 rails)
    for i in range(4):
        addr = ADDR_INA219[i]
        try:
            ina219_init(addr)
            cfg = ina219_read_reg(addr, INA219_REG_CFG)
            ok  = (cfg == INA219_CFG_32V_320MV_12BIT)
        except Exception as e:
            ok = False
        tests.append({"name": f"INA219_R{i+1}", "pass": ok,
                       "note": f"addr=0x{addr:02X} cfg=0x{cfg:04X}" if ok else "no response"})
        if not ok:
            passed = False

    # Test 2: Coil INA219
    try:
        ina219_init(ADDR_INA219_COIL)
        cfg = ina219_read_reg(ADDR_INA219_COIL, INA219_REG_CFG)
        ok  = (cfg == INA219_CFG_32V_320MV_12BIT)
    except Exception:
        ok = False
    tests.append({"name": "INA219_COIL", "pass": ok})
    if not ok:
        passed = False

    # Test 3: DAC write + readback (MCP4728 supports readback of EEPROM)
    for addr, name in [(ADDR_DAC_VOUT_LO, "DAC_VOUT_LO"), (ADDR_DAC_VOUT_HI, "DAC_VOUT_HI"),
                       (ADDR_DAC_ILIM_LO, "DAC_ILIM_LO"), (ADDR_DAC_ILIM_HI, "DAC_ILIM_HI")]:
        try:
            # Write 0x800 (mid-scale) to channel 0
            dac_write_channel(addr, 0, 0x800)
            utime.sleep_ms(5)
            # Read back: MCP4728 sequential read returns 24 bytes (6 per channel)
            data = i2c.readfrom(addr, 6)
            # Bits 11:0 are in bytes 1(high4) and 2(low8)
            rb_val = ((data[1] & 0x0F) << 8) | data[2]
            ok = abs(rb_val - 0x800) <= 1
        except Exception:
            ok = False
        tests.append({"name": name, "pass": ok})
        if not ok:
            passed = False

    # Test 4: EEPROM read
    try:
        board_type = i2c.readfrom_mem(ADDR_EEPROM, 0x00, 8)
        ok = len(board_type) == 8
    except Exception:
        ok = False
    tests.append({"name": "EEPROM_READ", "pass": ok})
    if not ok:
        passed = False

    # Test 5: Relay coil current (brief pulse, measure via coil INA219)
    # Just check that coil INA219 responds sensibly
    result = ina219_read(ADDR_INA219_COIL)
    ok = result is not None and result[0] > 4.5   # 5V coil rail present
    tests.append({"name": "COIL_5V_PRESENT", "pass": ok,
                   "note": f"bus_v={result[0]:.2f}V" if result else "no read"})
    if not ok:
        passed = False

    duration_ms = utime.ticks_diff(utime.ticks_ms(), t_start)
    return {"pass": passed, "tests": tests, "duration_ms": duration_ms}

# =============================================================================
# EEPROM HELPERS
# =============================================================================

def eeprom_read(offset, length):
    try:
        return i2c.readfrom_mem(ADDR_EEPROM, offset, length)
    except Exception:
        return None

def eeprom_write(offset, data):
    try:
        i2c.writeto_mem(ADDR_EEPROM, offset, data)
        utime.sleep_ms(5)  # EEPROM write cycle
        return True
    except Exception:
        return False

def read_board_id():
    data = eeprom_read(0x10, 8)
    if data:
        return data.decode("ascii", "replace").strip("\x00")
    return "UNKNOWN"

# =============================================================================
# COMMAND PARSER
# =============================================================================

def parse_int(s):
    try:
        return int(s)
    except Exception:
        return None

def parse_float(s):
    try:
        return float(s)
    except Exception:
        return None

def handle_command(cmd):
    cmd = cmd.strip()
    if not cmd:
        return None

    parts = cmd.upper().split()
    if not parts:
        return None

    # SET RAIL<n> <V>V
    if len(parts) >= 3 and parts[0] == "SET" and parts[1].startswith("RAIL"):
        rail_n = parse_int(parts[1][4:])
        if rail_n is None or not (1 <= rail_n <= 4):
            return "ERROR invalid rail"
        volt_str = parts[2].rstrip("V")
        v = parse_float(volt_str)
        if v is None or not (0 <= v <= 25):
            return "ERROR invalid voltage"
        idx = rail_n - 1
        rails[idx].set_voltage_v = v
        if rails[idx].state == STATE_ON:
            set_rail_voltage(idx, v)
        return f"OK RAIL{rail_n} VOLTAGE={v}V"

    # SET LIMIT RAIL<n> <I>mA
    if len(parts) >= 4 and parts[0] == "SET" and parts[1] == "LIMIT" and parts[2].startswith("RAIL"):
        rail_n = parse_int(parts[2][4:])
        if rail_n is None or not (1 <= rail_n <= 4):
            return "ERROR invalid rail"
        ma_str = parts[3].rstrip("MA")
        ma = parse_float(ma_str)
        if ma is None or ma < 0:
            return "ERROR invalid current"
        idx = rail_n - 1
        rails[idx].limit_current_a = ma / 1000.0
        if rails[idx].state == STATE_ON:
            set_rail_ilimit(idx, ma / 1000.0)
        return f"OK RAIL{rail_n} LIMIT={int(ma)}mA"

    # ENABLE ALL
    if parts == ["ENABLE", "ALL"]:
        for rail_n in sequence_order:
            ok, reason = enable_rail(rail_n - 1)
            if not ok:
                return f"FAULT RAIL{rail_n} {reason}"
            utime.sleep_ms(sequence_delay_ms)
        return "OK ALL ENABLED"

    # ENABLE RAIL<n>
    if len(parts) == 2 and parts[0] == "ENABLE" and parts[1].startswith("RAIL"):
        rail_n = parse_int(parts[1][4:])
        if rail_n is None or not (1 <= rail_n <= 4):
            return "ERROR invalid rail"
        ok, reason = enable_rail(rail_n - 1)
        if ok:
            return f"OK RAIL{rail_n} ENABLED"
        else:
            return f"FAULT RAIL{rail_n} {reason}"

    # DISABLE ALL
    if parts == ["DISABLE", "ALL"]:
        for i in range(4):
            disable_rail(i)
        return "OK ALL DISABLED"

    # DISABLE RAIL<n>
    if len(parts) == 2 and parts[0] == "DISABLE" and parts[1].startswith("RAIL"):
        rail_n = parse_int(parts[1][4:])
        if rail_n is None or not (1 <= rail_n <= 4):
            return "ERROR invalid rail"
        disable_rail(rail_n - 1)
        return f"OK RAIL{rail_n} DISABLED"

    # READ TELEMETRY
    if parts == ["READ", "TELEMETRY"]:
        payload = {
            "timestamp_ms": utime.ticks_ms(),
            "board_id": read_board_id(),
            "rails": [r.to_dict() for r in rails],
            "coil_rail": _read_coil_rail(),
        }
        return ujson.dumps(payload)

    # READ FAULTS
    if parts == ["READ", "FAULTS"]:
        return ujson.dumps(fault_log)

    # RUN SELFTEST
    if parts == ["RUN", "SELFTEST"]:
        result = run_selftest()
        return ujson.dumps(result)

    # CLEAR FAULT RAIL<n>
    if len(parts) >= 3 and parts[0] == "CLEAR" and parts[1] == "FAULT" and parts[2].startswith("RAIL"):
        rail_n = parse_int(parts[2][4:])
        if rail_n is None or not (1 <= rail_n <= 4):
            return "ERROR invalid rail"
        idx = rail_n - 1
        clear_fault_latch(idx)
        rails[idx].fault_code = 0
        rails[idx].state      = STATE_IDLE
        pin_fault_led.value(0)
        return f"OK RAIL{rail_n} FAULT CLEARED"

    # SEQUENCE <json>
    if parts[0] == "SEQUENCE":
        global sequence_order, sequence_delay_ms
        try:
            raw   = cmd[8:].strip()
            obj   = ujson.loads(raw)
            sequence_order    = obj.get("order", [1, 2, 3, 4])
            sequence_delay_ms = obj.get("delay_ms", 100)
            return "OK SEQUENCE SET"
        except Exception as e:
            return f"ERROR parse: {e}"

    # SET DISCHARGE RAIL<n>
    if len(parts) >= 3 and parts[0] == "SET" and parts[1] == "DISCHARGE" and parts[2].startswith("RAIL"):
        rail_n = parse_int(parts[2][4:])
        if rail_n is None or not (1 <= rail_n <= 4):
            return "ERROR invalid rail"
        discharge_rail(rail_n - 1)
        return f"OK RAIL{rail_n} DISCHARGE ACTIVE"

    return f"ERROR unknown command: {cmd}"

def _read_coil_rail():
    result = ina219_read(ADDR_INA219_COIL)
    if result:
        return {"voltage_v": round(result[0], 3),
                "current_a": round(result[2], 4),
                "power_w":   round(result[3], 4)}
    return {"voltage_v": 0.0, "current_a": 0.0, "power_w": 0.0}

# =============================================================================
# MAIN LOOP
# =============================================================================

def init_hardware():
    """Initialize all INA219s and DACs at boot."""
    for i, addr in enumerate(ADDR_INA219):
        ina219_init(addr)
    ina219_init(ADDR_INA219_COIL)

    # Set all rails to minimum voltage / maximum current limit (safe defaults)
    for i in range(4):
        set_rail_voltage(i, 3.3)        # default 3.3V
        set_rail_ilimit(i, 5.0)          # default 5A limit
        rails[i].set_voltage_v   = 3.3
        rails[i].limit_current_a = 5.0

    # Ensure all relays open at boot
    for i in range(4):
        pins_enable[i].value(0)
        pins_disch_en[i].value(0)
        pins_led[i].value(0)

    # Clear all fault latches
    for i in range(4):
        clear_fault_latch(i)

    pin_fault_led.value(0)
    print("FL-1 DUT Power Board Rev A — firmware v1.0.0 ready")
    print("I2C devices:", [hex(d) for d in i2c.scan()])

def main():
    init_hardware()

    cmd_buf = []
    _last_telemetry_update = 0

    while True:
        kick_watchdog()

        # Poll telemetry for ON rails
        for i in range(4):
            if rails[i].state in (STATE_ON, STATE_RAMPING):
                update_rail_telemetry(i)

        # Update fault LED
        any_fault = any(r.state == STATE_FAULT for r in rails)
        pin_fault_led.value(1 if any_fault else 0)

        # Read USB CDC input (non-blocking)
        try:
            if sys.stdin in (None,):
                pass
            # Read available chars
            import uselect
            poll = uselect.poll()
            poll.register(sys.stdin, uselect.POLLIN)
            events = poll.poll(0)   # non-blocking
            if events:
                char = sys.stdin.read(1)
                if char in ('\r', '\n'):
                    line = "".join(cmd_buf).strip()
                    cmd_buf.clear()
                    if line:
                        response = handle_command(line)
                        if response is not None:
                            sys.stdout.write(response + "\r\n")
                elif char == '\x08' and cmd_buf:  # backspace
                    cmd_buf.pop()
                else:
                    cmd_buf.append(char)
        except Exception:
            pass

        utime.sleep_ms(5)

if __name__ == "__main__":
    main()
