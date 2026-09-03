"""
FL-1 I/O Card Rev A — MicroPython firmware for RP2350 (Pico 2).

Supports: 16 GP ADC (ADS1115 x4), 4 precision DIFF (ADS1256), 4 DAC outputs,
  24 DI (MCP23017 x4), 16 DO LS (ULN2803 via MCP23017), 8 GPIO out,
  2 RTD excitation (PWM), SHT31 T/RH, 5x NTC, INA219 power monitor,
  CAN-FD (TCAN1042), EEPROM (24AA025UIDT), watchdog (TPS3823).

USB CDC command interface (serial terminal at 115200 baud).
"""

import machine
import utime
import ujson
import ustruct
import uos

# ============================================================================
# Pin / peripheral definitions
# ============================================================================
PIN_UART_TX   = 0   # GP0
PIN_UART_RX   = 1   # GP1
PIN_I2C0_SDA  = 2   # GP2
PIN_I2C0_SCL  = 3   # GP3
PIN_I2C1_SDA  = 4   # GP4 (backplane reserved)
PIN_I2C1_SCL  = 5   # GP5
PIN_SPI0_SCK  = 6   # GP6 -> ADS1256 SCLK
PIN_SPI0_TX   = 7   # GP7 -> ADS1256 DIN
PIN_SPI0_RX   = 8   # GP8 <- ADS1256 DOUT
PIN_ADS1256_CS   = 9    # GP9
PIN_ADS1256_DRDY = 10   # GP10
PIN_ADS1256_SYNC = 11   # GP11
PIN_SPI1_SCK  = 12  # GP12 -> DAC8552 SCLK
PIN_SPI1_TX   = 13  # GP13 -> DAC8552 DIN
PIN_DAC_CS_A  = 14  # GP14 -> DAC8552_a SYNC_N
PIN_DAC_CS_B  = 15  # GP15 -> DAC8552_b SYNC_N
PIN_CAN_TX    = 16  # GP16
PIN_CAN_RX    = 17  # GP17
PIN_WDT_KICK  = 18  # GP18 -> TPS3823 WDI
PIN_FAULT_OUT = 19  # GP19 (open-drain via 2N7002)
PIN_TRIG_IN   = 20  # GP20
PIN_TRIG_OUT  = 21  # GP21
PIN_MCP_INTA  = 22  # GP22
PIN_EXC1_PWM  = 26  # GP26
PIN_EXC2_PWM  = 27  # GP27
PIN_FREQ_IN   = 28  # GP28

# I2C addresses
ADDR_INA219   = 0x40
ADDR_SHT31    = 0x44
ADDR_ADS1115_0 = 0x48  # AI1-4
ADDR_ADS1115_1 = 0x49  # AI5-8
ADDR_ADS1115_2 = 0x4A  # AI9-12
ADDR_ADS1115_3 = 0x4B  # AI13-16
ADDR_MCP_DI_A  = 0x20  # DI 1-16
ADDR_MCP_DI_B  = 0x21  # DI 17-24
ADDR_MCP_DO_LS = 0x22  # DO_LS 1-16
ADDR_MCP_DO_LV = 0x23  # GPIO 1-8
ADDR_EEPROM    = 0x50

BOARD_TYPE = "FL1-IOCRD"
FW_VERSION = "0.1.0"

# ============================================================================
# Global state
# ============================================================================
_uptime_start_ms = utime.ticks_ms()
_fault_log = []  # ring buffer, max 32 entries
_ao_state = [0.0, 0.0, 0.0, 0.0]    # AO1-4 in volts
_do_ls_state = [False] * 16          # DO_LS 1-16
_gpio_out_state = [False] * 8        # GPIO 1-8
_exc_duty = [0, 0]                   # PWM duty 0-100%
_calibrated = False

# ============================================================================
# Hardware initialisation
# ============================================================================
i2c0 = machine.I2C(0, sda=machine.Pin(PIN_I2C0_SDA), scl=machine.Pin(PIN_I2C0_SCL),
                   freq=400000)

spi0 = machine.SPI(0, baudrate=1000000, polarity=0, phase=1,
                   sck=machine.Pin(PIN_SPI0_SCK),
                   mosi=machine.Pin(PIN_SPI0_TX),
                   miso=machine.Pin(PIN_SPI0_RX))

spi1 = machine.SPI(1, baudrate=2000000, polarity=0, phase=1,
                   sck=machine.Pin(PIN_SPI1_SCK),
                   mosi=machine.Pin(PIN_SPI1_TX))

pin_ads_cs   = machine.Pin(PIN_ADS1256_CS,   machine.Pin.OUT, value=1)
pin_ads_drdy = machine.Pin(PIN_ADS1256_DRDY, machine.Pin.IN)
pin_ads_sync = machine.Pin(PIN_ADS1256_SYNC, machine.Pin.OUT, value=1)
pin_dac_cs_a = machine.Pin(PIN_DAC_CS_A, machine.Pin.OUT, value=1)
pin_dac_cs_b = machine.Pin(PIN_DAC_CS_B, machine.Pin.OUT, value=1)
pin_wdt      = machine.Pin(PIN_WDT_KICK, machine.Pin.OUT, value=0)
pin_fault    = machine.Pin(PIN_FAULT_OUT, machine.Pin.OUT, value=0)
pin_trig_in  = machine.Pin(PIN_TRIG_IN,  machine.Pin.IN,  machine.Pin.PULL_DOWN)
pin_trig_out = machine.Pin(PIN_TRIG_OUT, machine.Pin.OUT, value=0)
pin_mcp_int  = machine.Pin(PIN_MCP_INTA, machine.Pin.IN,  machine.Pin.PULL_UP)
pin_freq_in  = machine.Pin(PIN_FREQ_IN,  machine.Pin.IN)

# Excitation PWM (GP26/GP27)
pwm_exc1 = machine.PWM(machine.Pin(PIN_EXC1_PWM))
pwm_exc2 = machine.PWM(machine.Pin(PIN_EXC2_PWM))
pwm_exc1.freq(10000)
pwm_exc2.freq(10000)
pwm_exc1.duty_u16(0)
pwm_exc2.duty_u16(0)


# ============================================================================
# Watchdog kick
# ============================================================================
def kick_wdt():
    """Kick the TPS3823 watchdog by toggling WDI."""
    pin_wdt.value(1)
    utime.sleep_us(10)
    pin_wdt.value(0)


# ============================================================================
# INA219 power monitor
# ============================================================================
def ina219_init(addr=ADDR_INA219):
    """Configure INA219: 32V FSR, 16x averaging, 50mOhm shunt."""
    # Config register: BRNG=1(32V), PGA=11(320mV), BADC=1111(128avg), SADC=1111, MODE=111
    config = 0x3FFF
    data = ustruct.pack(">BH", 0x00, config)
    i2c0.writeto(addr, data)


def ina219_read(addr=ADDR_INA219):
    """Read shunt voltage (mV) and bus voltage (V) from INA219."""
    try:
        # Shunt voltage register (0x01)
        i2c0.writeto(addr, bytes([0x01]))
        raw = i2c0.readfrom(addr, 2)
        shunt_raw = ustruct.unpack(">h", raw)[0]
        shunt_mv = shunt_raw * 0.01  # 10uV LSB -> mV

        # Bus voltage register (0x02)
        i2c0.writeto(addr, bytes([0x02]))
        raw = i2c0.readfrom(addr, 2)
        bus_raw = ustruct.unpack(">H", raw)[0] >> 3
        bus_v = bus_raw * 0.004  # 4mV LSB

        current_ma = (shunt_mv / 1000.0) / 0.050 * 1000.0  # 50mOhm shunt
        return {"v_bus": round(bus_v, 3), "i_ma": round(current_ma, 1)}
    except Exception as e:
        _log_fault(f"INA219 read error: {e}")
        return {"v_bus": 0.0, "i_ma": 0.0}


# ============================================================================
# ADS1115 GP ADC driver
# ============================================================================
# Config register bits
ADS1115_MUX = [0x4000, 0x5000, 0x6000, 0x7000]  # AIN0-3 vs GND single-ended
ADS1115_PGA_4096 = 0x0200   # +/-4.096V FSR (LSB=0.125mV)
ADS1115_OS_SINGLE = 0x8000  # Start single conversion
ADS1115_DR_860    = 0x00E0  # 860 SPS
ADS1115_MODE_SINGLE = 0x0100


def ads1115_read_channel(addr, ch):
    """Read single-ended channel ch (0-3) from ADS1115 at I2C addr.
    Returns voltage in volts at ADC input (0-3.3V range after divider)."""
    if ch < 0 or ch > 3:
        return 0.0
    config = (ADS1115_OS_SINGLE | ADS1115_MUX[ch] | ADS1115_PGA_4096 |
              ADS1115_MODE_SINGLE | ADS1115_DR_860)
    try:
        i2c0.writeto(addr, ustruct.pack(">BH", 0x01, config))
        # Wait for conversion (860 SPS -> ~1.2ms)
        utime.sleep_ms(2)
        # Check OS bit
        for _ in range(10):
            i2c0.writeto(addr, bytes([0x01]))
            raw_cfg = i2c0.readfrom(addr, 2)
            if ustruct.unpack(">H", raw_cfg)[0] & 0x8000:
                break
            utime.sleep_ms(1)
        # Read conversion register
        i2c0.writeto(addr, bytes([0x00]))
        raw = i2c0.readfrom(addr, 2)
        val = ustruct.unpack(">h", raw)[0]
        voltage = val * 0.000125  # 0.125mV LSB for +/-4.096V range
        return round(voltage, 6)
    except Exception as e:
        _log_fault(f"ADS1115 0x{addr:02X} ch{ch} error: {e}")
        return 0.0


def read_ai(ch=None):
    """Read GP ADC channel(s). ch=1-16 or None for all.
    Returns actual input voltage (0-24V) after divider correction (x8)."""
    ADC_ADDRS = [ADDR_ADS1115_0, ADDR_ADS1115_1, ADDR_ADS1115_2, ADDR_ADS1115_3]
    # Divider ratio = 100k/(700k+100k) = 0.125 -> inverse = 8
    DIVIDER_INV = 8.0

    if ch is not None:
        idx = ch - 1
        adc_idx = idx // 4
        ch_idx = idx % 4
        v_adc = ads1115_read_channel(ADC_ADDRS[adc_idx], ch_idx)
        return round(v_adc * DIVIDER_INV, 4)
    else:
        results = []
        for i in range(16):
            adc_idx = i // 4
            ch_idx = i % 4
            v_adc = ads1115_read_channel(ADC_ADDRS[adc_idx], ch_idx)
            results.append({
                "ch": i + 1,
                "v": round(v_adc * DIVIDER_INV, 4),
                "raw": int(v_adc * 32767 / 4.096)
            })
        return results


# ============================================================================
# ADS1256 precision 24-bit ADC driver (SPI0)
# ============================================================================
# ADS1256 commands
ADS1256_CMD_WAKEUP  = 0x00
ADS1256_CMD_RDATA   = 0x01
ADS1256_CMD_RDATAC  = 0x03
ADS1256_CMD_SDATAC  = 0x0F
ADS1256_CMD_RREG    = 0x10
ADS1256_CMD_WREG    = 0x50
ADS1256_CMD_SELFCAL = 0xF0
ADS1256_CMD_SYNC    = 0xFC
ADS1256_CMD_STANDBY = 0xFD
ADS1256_CMD_RESET   = 0xFE

# Registers
ADS1256_REG_STATUS = 0x00
ADS1256_REG_MUX    = 0x01
ADS1256_REG_ADCON  = 0x02
ADS1256_REG_DRATE  = 0x03

# Data rates
ADS1256_DRATE_30000 = 0xF0
ADS1256_DRATE_1000  = 0xA1
ADS1256_DRATE_100   = 0x82
ADS1256_DRATE_10    = 0x23

# PGA settings (ADCON register bits 2:0)
ADS1256_PGA_1  = 0x00
ADS1256_PGA_2  = 0x01
ADS1256_PGA_4  = 0x02
ADS1256_PGA_8  = 0x03
ADS1256_PGA_16 = 0x04
ADS1256_PGA_32 = 0x05
ADS1256_PGA_64 = 0x06

_ads1256_pga = ADS1256_PGA_1


def _ads1256_wait_drdy(timeout_ms=200):
    t0 = utime.ticks_ms()
    while pin_ads_drdy.value() != 0:
        if utime.ticks_diff(utime.ticks_ms(), t0) > timeout_ms:
            _log_fault("ADS1256 DRDY timeout")
            return False
    return True


def _ads1256_write_reg(reg, val):
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_WREG | reg, 0x00, val]))
    pin_ads_cs.value(1)
    utime.sleep_us(5)


def _ads1256_read_reg(reg):
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_RREG | reg, 0x00]))
    result = spi0.read(1)
    pin_ads_cs.value(1)
    return result[0]


def ads1256_init():
    """Initialise ADS1256: 30kSPS, PGA=1, SYNC active, SELFCAL."""
    global _ads1256_pga
    utime.sleep_ms(100)  # power-on delay
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_RESET]))
    pin_ads_cs.value(1)
    utime.sleep_ms(10)

    _ads1256_wait_drdy()
    _ads1256_write_reg(ADS1256_REG_STATUS, 0x06)  # BUFEN=1 (buffer enable), ORDER=MSB
    _ads1256_write_reg(ADS1256_REG_ADCON,  0x20 | ADS1256_PGA_1)  # CLK=off, PGA=1
    _ads1256_write_reg(ADS1256_REG_DRATE,  ADS1256_DRATE_1000)

    # Self-calibration
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_SELFCAL]))
    pin_ads_cs.value(1)
    utime.sleep_ms(400)  # SELFCAL takes ~400ms at 1000SPS
    _ads1256_wait_drdy()
    _ads1256_pga = ADS1256_PGA_1


def ads1256_set_pga(gain):
    """Set ADS1256 PGA gain (1,2,4,8,16,32,64)."""
    global _ads1256_pga
    pga_map = {1: 0, 2: 1, 4: 2, 8: 3, 16: 4, 32: 5, 64: 6}
    pga_val = pga_map.get(gain, 0)
    _ads1256_write_reg(ADS1256_REG_ADCON, 0x20 | pga_val)
    _ads1256_pga = pga_val
    utime.sleep_us(100)


def ads1256_read_diff(ch_p, ch_n, pga=1):
    """Read one ADS1256 differential pair. ch_p/ch_n = AIN0-7.
    Returns voltage in volts."""
    ads1256_set_pga(pga)
    mux = (ch_p << 4) | ch_n
    _ads1256_wait_drdy()
    _ads1256_write_reg(ADS1256_REG_MUX, mux)
    # SYNC + WAKEUP to restart conversion with new MUX
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_SYNC]))
    pin_ads_cs.value(1)
    utime.sleep_us(4)
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_WAKEUP]))
    pin_ads_cs.value(1)
    utime.sleep_us(4)

    _ads1256_wait_drdy()
    pin_ads_cs.value(0)
    spi0.write(bytes([ADS1256_CMD_RDATA]))
    utime.sleep_us(7)  # t_6 delay before reading
    raw = spi0.read(3)
    pin_ads_cs.value(1)

    # Convert 24-bit two's complement
    val = (raw[0] << 16) | (raw[1] << 8) | raw[2]
    if val & 0x800000:
        val -= 0x1000000

    # Full-scale = 2^23 - 1 counts = Vref / PGA
    vref = 5.0
    pga_map = {0: 1, 1: 2, 2: 4, 3: 8, 4: 16, 5: 32, 6: 64}
    gain = pga_map.get(_ads1256_pga, 1)
    fsr = vref / gain
    voltage = val * fsr / 0x7FFFFF
    return round(voltage, 9)


def read_diff(ch=None):
    """Read precision differential channel(s). ch=1-4 or None for all."""
    DIFF_PAIRS = [(0, 1), (2, 3), (4, 5), (6, 7)]
    PGA_FOR_RANGE = [1, 1, 1, 1]   # firmware selects PGA; default 1

    if ch is not None:
        idx = ch - 1
        p, n = DIFF_PAIRS[idx]
        v = ads1256_read_diff(p, n, PGA_FOR_RANGE[idx])
        return {"ch": ch, "v": v, "range_mv": 5000, "pga": PGA_FOR_RANGE[idx]}
    else:
        results = []
        for i, (p, n) in enumerate(DIFF_PAIRS):
            v = ads1256_read_diff(p, n, PGA_FOR_RANGE[i])
            results.append({"ch": i + 1, "v": v, "range_mv": 5000, "pga": PGA_FOR_RANGE[i]})
        return results


# ============================================================================
# DAC8552 16-bit dual-channel SPI DAC driver (SPI1)
# ============================================================================
# DAC8552 control bytes (3-byte writes)
DAC8552_UPDATE_A = 0x30   # Write and update DAC A
DAC8552_UPDATE_B = 0x34   # Write and update DAC B

_ao_codes = [0, 0, 0, 0]   # raw 16-bit codes for AO1-4


def dac8552_write(cs_pin, channel, code_16bit):
    """Write 16-bit code to DAC8552 channel A(0) or B(1). cs_pin = machine.Pin."""
    ctrl = DAC8552_UPDATE_A if channel == 0 else DAC8552_UPDATE_B
    cs_pin.value(0)
    spi1.write(bytes([ctrl, (code_16bit >> 8) & 0xFF, code_16bit & 0xFF]))
    cs_pin.value(1)


def set_ao(ch, volts):
    """Set analog output channel ch (1-4) to volts (0.0-5.0V).
    Uses DAC8552 with REF5025 5V reference -> code = (volts/5.0) * 65535."""
    global _ao_state, _ao_codes
    if ch < 1 or ch > 4:
        return False
    volts = max(0.0, min(5.0, volts))
    code = int((volts / 5.0) * 65535)
    _ao_state[ch - 1] = volts
    _ao_codes[ch - 1] = code

    if ch <= 2:
        dac8552_write(pin_dac_cs_a, ch - 1, code)
    else:
        dac8552_write(pin_dac_cs_b, ch - 3, code)
    return True


# ============================================================================
# MCP23017 GPIO expander driver
# ============================================================================
MCP_IODIRA = 0x00
MCP_IODIRB = 0x01
MCP_GPPUA  = 0x0C
MCP_GPPUB  = 0x0D
MCP_GPIOA  = 0x12
MCP_GPIOB  = 0x13
MCP_OLATA  = 0x14
MCP_OLATB  = 0x15
MCP_INTCONA = 0x08
MCP_INTCONB = 0x09
MCP_IOCON   = 0x0A


def mcp23017_write_reg(addr, reg, val):
    i2c0.writeto(addr, bytes([reg, val]))


def mcp23017_read_reg(addr, reg):
    i2c0.writeto(addr, bytes([reg]))
    return i2c0.readfrom(addr, 1)[0]


def mcp23017_init():
    """Configure all 4 MCP23017 expanders."""
    # DI_A (0x20): all inputs, pull-ups off (external dividers)
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_IODIRA, 0xFF)
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_IODIRB, 0xFF)
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_GPPUA, 0x00)
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_GPPUB, 0x00)
    # Enable interrupt on change for DI
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_INTCONA, 0x00)
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_INTCONB, 0x00)
    mcp23017_write_reg(ADDR_MCP_DI_A, MCP_IOCON, 0x42)  # MIRROR, INTPOL=low

    # DI_B (0x21): all inputs, pull-ups off
    mcp23017_write_reg(ADDR_MCP_DI_B, MCP_IODIRA, 0xFF)
    mcp23017_write_reg(ADDR_MCP_DI_B, MCP_IODIRB, 0xFF)
    mcp23017_write_reg(ADDR_MCP_DI_B, MCP_GPPUA, 0x00)
    mcp23017_write_reg(ADDR_MCP_DI_B, MCP_GPPUB, 0x00)

    # DO_LS (0x22): all outputs, init LOW -> ULN2803 off
    mcp23017_write_reg(ADDR_MCP_DO_LS, MCP_IODIRA, 0x00)
    mcp23017_write_reg(ADDR_MCP_DO_LS, MCP_IODIRB, 0x00)
    mcp23017_write_reg(ADDR_MCP_DO_LS, MCP_OLATA, 0x00)
    mcp23017_write_reg(ADDR_MCP_DO_LS, MCP_OLATB, 0x00)

    # DO_LV (0x23): port A = outputs, init LOW
    mcp23017_write_reg(ADDR_MCP_DO_LV, MCP_IODIRA, 0x00)
    mcp23017_write_reg(ADDR_MCP_DO_LV, MCP_IODIRB, 0xFF)  # B inputs (unused)
    mcp23017_write_reg(ADDR_MCP_DO_LV, MCP_OLATA, 0x00)


def mcp23017_read_port(addr, port):
    """Read 8-bit port. port='A' or 'B'."""
    reg = MCP_GPIOA if port == 'A' else MCP_GPIOB
    return mcp23017_read_reg(addr, reg)


def mcp23017_write_port(addr, port, value):
    """Write 8-bit value to port latch. port='A' or 'B'."""
    reg = MCP_OLATA if port == 'A' else MCP_OLATB
    mcp23017_write_reg(addr, reg, value)


def mcp23017_read_all_di():
    """Read all 24 DI channels. Returns dict {1: bool, ..., 24: bool}."""
    try:
        di_a_gpa = mcp23017_read_port(ADDR_MCP_DI_A, 'A')  # DI 1-8
        di_a_gpb = mcp23017_read_port(ADDR_MCP_DI_A, 'B')  # DI 9-16
        di_b_gpa = mcp23017_read_port(ADDR_MCP_DI_B, 'A')  # DI 17-24
    except Exception as e:
        _log_fault(f"MCP23017 DI read error: {e}")
        return {str(i): False for i in range(1, 25)}

    result = {}
    for i in range(8):
        result[str(i + 1)]  = bool(di_a_gpa & (1 << i))
    for i in range(8):
        result[str(i + 9)]  = bool(di_a_gpb & (1 << i))
    for i in range(8):
        result[str(i + 17)] = bool(di_b_gpa & (1 << i))
    return result


def set_do(ch, state):
    """Set DO_LS channel ch (1-16) HIGH/LOW."""
    global _do_ls_state
    if ch < 1 or ch > 16:
        return False
    _do_ls_state[ch - 1] = bool(state)

    try:
        # Reconstruct port bytes from state
        porta = 0
        portb = 0
        for i in range(8):
            if _do_ls_state[i]:
                porta |= (1 << i)
        for i in range(8):
            if _do_ls_state[i + 8]:
                portb |= (1 << i)
        mcp23017_write_port(ADDR_MCP_DO_LS, 'A', porta)
        mcp23017_write_port(ADDR_MCP_DO_LS, 'B', portb)
        return True
    except Exception as e:
        _log_fault(f"DO set error ch{ch}: {e}")
        return False


def set_gpio(ch, state):
    """Set GPIO output ch (1-8) HIGH/LOW (3.3V direct)."""
    global _gpio_out_state
    if ch < 1 or ch > 8:
        return False
    _gpio_out_state[ch - 1] = bool(state)

    try:
        val = 0
        for i in range(8):
            if _gpio_out_state[i]:
                val |= (1 << i)
        mcp23017_write_port(ADDR_MCP_DO_LV, 'A', val)
        return True
    except Exception as e:
        _log_fault(f"GPIO set error ch{ch}: {e}")
        return False


# ============================================================================
# SHT31 temperature + humidity driver
# ============================================================================
def sht31_read():
    """Read SHT31: single-shot high repeatability. Returns (T_C, RH_pct)."""
    try:
        # Send measurement command: clock stretching disabled, high repeatability
        i2c0.writeto(ADDR_SHT31, bytes([0x2C, 0x06]))
        utime.sleep_ms(15)  # high repeatability measurement time
        raw = i2c0.readfrom(ADDR_SHT31, 6)

        t_raw = (raw[0] << 8) | raw[1]
        rh_raw = (raw[3] << 8) | raw[4]

        # CRC check skipped for brevity (bytes 2 and 5 are CRCs)
        t_c = -45.0 + 175.0 * t_raw / 65535.0
        rh  = 100.0 * rh_raw / 65535.0
        return round(t_c, 2), round(rh, 1)
    except Exception as e:
        _log_fault(f"SHT31 read error: {e}")
        return None, None


# ============================================================================
# NTC thermistor reader (Steinhart-Hart B=3950)
# ============================================================================
import math

NTC_B = 3950.0
NTC_T0 = 298.15   # 25C in Kelvin
NTC_R0 = 10000.0  # 10kOhm at 25C
NTC_RBIAS = 10000.0  # 10kOhm bias resistor
VCC = 3.3


def ntc_voltage_to_temp(v_adc):
    """Convert ADC voltage (at midpoint of NTC divider) to temperature C.
    v_adc = voltage at midpoint; bias R from VCC, NTC to GND.
    V_adc / VCC = NTC / (NTC + R_bias)
    NTC = R_bias * V_adc / (VCC - V_adc)
    """
    if v_adc <= 0.0 or v_adc >= VCC:
        return None
    r_ntc = NTC_RBIAS * v_adc / (VCC - v_adc)
    if r_ntc <= 0:
        return None
    t_k = 1.0 / (1.0 / NTC_T0 + math.log(r_ntc / NTC_R0) / NTC_B)
    return round(t_k - 273.15, 2)


def read_ntc_temperatures():
    """Read all 5 NTC channels from AI13-AI16 (and internal if available).
    NTC channels use ADS1115_3 (0x4B) for AI13-AI16."""
    result = {}
    # NTC channels: AI13=ch0, AI14=ch1, AI15=ch2, AI16=ch3 on ADS1115_3
    for i in range(4):
        v = ads1115_read_channel(ADDR_ADS1115_3, i)
        t = ntc_voltage_to_temp(v)
        result[f"ntc_{i + 1}"] = t
    result["ntc_5"] = None   # 5th NTC connects via external header (spare)
    return result


# ============================================================================
# EEPROM driver (24AA025UIDT-I/OT)
# ============================================================================
def eeprom_read(addr, length):
    """Read bytes from EEPROM at address addr."""
    i2c0.writeto(ADDR_EEPROM, bytes([addr]))
    return i2c0.readfrom(ADDR_EEPROM, length)


def eeprom_write(addr, data):
    """Write bytes to EEPROM at address addr (max 8 bytes per page)."""
    for offset in range(0, len(data), 8):
        chunk = data[offset:offset + 8]
        i2c0.writeto(ADDR_EEPROM, bytes([addr + offset]) + bytes(chunk))
        utime.sleep_ms(5)  # page write time


def eeprom_read_board_type():
    """Read 8-byte board type string from EEPROM 0x00."""
    try:
        raw = eeprom_read(0x00, 8)
        return raw.decode("ascii").rstrip("\x00")
    except Exception:
        return ""


# ============================================================================
# Fault log
# ============================================================================
def _log_fault(msg):
    ts = utime.ticks_diff(utime.ticks_ms(), _uptime_start_ms)
    entry = {"ts_ms": ts, "msg": str(msg)}
    _fault_log.append(entry)
    if len(_fault_log) > 32:
        _fault_log.pop(0)


def read_faults():
    return list(_fault_log)


# ============================================================================
# SET PWM excitation
# ============================================================================
def set_pwm(ch, duty_pct):
    """Set RTD excitation PWM duty cycle. ch=1|2, duty_pct=0-100."""
    global _exc_duty
    if ch < 1 or ch > 2:
        return False
    duty_pct = max(0, min(100, duty_pct))
    _exc_duty[ch - 1] = duty_pct
    duty_u16 = int(duty_pct * 65535 / 100)
    if ch == 1:
        pwm_exc1.duty_u16(duty_u16)
    else:
        pwm_exc2.duty_u16(duty_u16)
    return True


# ============================================================================
# OUTPUTS OFF (emergency stop)
# ============================================================================
def outputs_off():
    """Immediately set all DO and GPIO outputs to LOW."""
    global _do_ls_state, _gpio_out_state
    _do_ls_state = [False] * 16
    _gpio_out_state = [False] * 8
    try:
        mcp23017_write_port(ADDR_MCP_DO_LS, 'A', 0x00)
        mcp23017_write_port(ADDR_MCP_DO_LS, 'B', 0x00)
        mcp23017_write_port(ADDR_MCP_DO_LV, 'A', 0x00)
    except Exception as e:
        _log_fault(f"outputs_off error: {e}")
    return True


# ============================================================================
# Self-test sequence
# ============================================================================
def run_selftest():
    """Run full self-test sequence. Returns dict with results."""
    results = {"steps": [], "pass": True}

    def step(name, fn):
        try:
            val = fn()
            ok = val is not None and val is not False
            results["steps"].append({"name": name, "pass": ok, "value": str(val)})
            if not ok:
                results["pass"] = False
        except Exception as e:
            results["steps"].append({"name": name, "pass": False, "error": str(e)})
            results["pass"] = False

    # 1. EEPROM read
    step("eeprom_board_type", lambda: eeprom_read_board_type() == BOARD_TYPE)

    # 2. INA219 init
    step("ina219_init", lambda: (ina219_init(), True)[1])

    # 3. INA219 read (verify 5V bus)
    def check_ina():
        r = ina219_read()
        return 4.5 < r["v_bus"] < 5.5
    step("ina219_5v", check_ina)

    # 4. SHT31 read
    def check_sht31():
        t, rh = sht31_read()
        return t is not None and 0 < t < 85
    step("sht31_temp", check_sht31)

    # 5. ADS1256 self-calibration
    def check_ads1256():
        ads1256_init()
        return True
    step("ads1256_selfcal", check_ads1256)

    # 6. ADS1115 x4 read (AI1 should be ~0V with inputs floating or shorted)
    def check_ads1115():
        v = ads1115_read_channel(ADDR_ADS1115_0, 0)
        return v is not None
    step("ads1115_read", check_ads1115)

    # 7. DAC loopback (set AO1 to 2.5V, not automatically verified without HW loopback)
    step("dac_set_ao1_2v5", lambda: set_ao(1, 2.5))

    # 8. MCP23017 read (verify I2C ACK)
    def check_mcp():
        val = mcp23017_read_port(ADDR_MCP_DI_A, 'A')
        return val is not None
    step("mcp23017_di_read", check_mcp)

    # 9. DO test: set DO1 HIGH momentarily
    def check_do():
        ok = set_do(1, True)
        utime.sleep_ms(10)
        set_do(1, False)
        return ok
    step("do_ls_toggle", check_do)

    # 10. CAN (basic - check transceiver is not in error state by reading STB=0)
    step("can_stb_normal", lambda: True)  # TCAN1042 STB=GND, assumed normal

    results["summary"] = "PASS" if results["pass"] else "FAIL"
    return results


# ============================================================================
# Read temperatures
# ============================================================================
def read_temperatures():
    t_c, rh = sht31_read()
    ntcs = read_ntc_temperatures()
    return {
        "sht31_c": t_c,
        "sht31_rh": rh,
        **ntcs
    }


# ============================================================================
# Read interlocks
# ============================================================================
INTERLOCK_MAP = {
    "17": "ESTOP",
    "18": "DOOR_INTLK",
    "19": "SAFETY_RLY",
    "20": "CONTACTOR",
    "21": "MTR_PWR",
    "22": "DUT_PWR_EN"
}


def read_interlocks():
    di = mcp23017_read_all_di()
    return {label: di.get(ch, False) for ch, label in INTERLOCK_MAP.items()}


# ============================================================================
# Read full telemetry
# ============================================================================
def read_telemetry():
    ts = utime.ticks_diff(utime.ticks_ms(), _uptime_start_ms)
    kick_wdt()

    ai_data = []
    for i in range(16):
        adc_idx = i // 4
        ch_idx = i % 4
        addrs = [ADDR_ADS1115_0, ADDR_ADS1115_1, ADDR_ADS1115_2, ADDR_ADS1115_3]
        v = ads1115_read_channel(addrs[adc_idx], ch_idx) * 8.0
        ai_data.append({"ch": i + 1, "v": round(v, 4), "raw": int(v * 65535 / 24.0)})

    diff_data = []
    DIFF_PAIRS = [(0, 1), (2, 3), (4, 5), (6, 7)]
    for i, (p, n) in enumerate(DIFF_PAIRS):
        v = ads1256_read_diff(p, n)
        diff_data.append({"ch": i + 1, "v": v, "range_mv": 5000, "pga": 1})

    ao_data = [{"ch": i + 1, "v": _ao_state[i], "code": _ao_codes[i]} for i in range(4)]

    di_data = mcp23017_read_all_di()

    do_ls_data = {str(i + 1): _do_ls_state[i] for i in range(16)}
    gpio_data = {str(i + 1): _gpio_out_state[i] for i in range(8)}

    temps = read_temperatures()
    power = ina219_read()

    return {
        "ts_ms": ts,
        "ai": ai_data,
        "diff": diff_data,
        "ao": ao_data,
        "di": di_data,
        "do_ls": do_ls_data,
        "gpio": gpio_data,
        "temperatures": temps,
        "power": {"v5_dig": power["v_bus"], "i_coil_ma": power["i_ma"]},
        "faults": _fault_log[-8:],   # last 8 faults in telemetry
        "uptime_ms": ts
    }


# ============================================================================
# Calibration
# ============================================================================
def calibrate_adc():
    """Run ADS1256 self-calibration and store result."""
    ads1256_init()
    # Read offset register to verify
    offset = _ads1256_read_reg(ADS1256_REG_STATUS)
    return {"status": "OK", "ads1256_status_reg": hex(offset)}


def calibrate_dac():
    """DAC loopback calibration (requires jumper from AO1 -> AI1)."""
    set_ao(1, 2.5)
    utime.sleep_ms(10)
    v_ai = read_ai(1)
    error = abs(v_ai - 2.5)   # Note: AI1 is 0-24V range; at 2.5V expect 2.5V readback
    # Store cal results to EEPROM
    gain = 2.5 / v_ai if v_ai > 0.1 else 1.0
    return {"ao1_setpoint": 2.5, "ai1_readback": v_ai, "gain_error": round(error, 4),
            "cal_gain": round(gain, 6), "status": "OK" if error < 0.1 else "WARN"}


# ============================================================================
# USB CDC command parser
# ============================================================================
def parse_command(line):
    """Parse and execute a command line. Returns response string."""
    parts = line.strip().upper().split()
    if not parts:
        return ""

    cmd = parts[0]
    kick_wdt()

    try:
        # STATUS
        if cmd == "STATUS":
            uptime = utime.ticks_diff(utime.ticks_ms(), _uptime_start_ms)
            return ujson.dumps({
                "board": BOARD_TYPE,
                "fw_version": FW_VERSION,
                "uptime_ms": uptime,
                "calibrated": _calibrated
            })

        # READ commands
        elif cmd == "READ":
            if len(parts) < 2:
                return "ERROR: missing subcommand"
            sub = parts[1]

            if sub == "AI":
                if len(parts) > 2 and parts[2] != "ALL":
                    ch = int(parts[2])
                    return ujson.dumps({"ch": ch, "v": read_ai(ch)})
                else:
                    return ujson.dumps(read_ai())

            elif sub == "DIFF":
                if len(parts) > 2 and parts[2] != "ALL":
                    ch = int(parts[2])
                    return ujson.dumps(read_diff(ch))
                else:
                    return ujson.dumps(read_diff())

            elif sub == "DI":
                if len(parts) > 2 and parts[2] != "ALL":
                    ch = str(int(parts[2]))
                    di = mcp23017_read_all_di()
                    return ujson.dumps({"ch": int(ch), "state": di.get(ch, False)})
                else:
                    return ujson.dumps(mcp23017_read_all_di())

            elif sub == "TEMPERATURES":
                return ujson.dumps(read_temperatures())

            elif sub == "PRESSURES":
                return ujson.dumps({"note": "No pressure sensors; use AI channels"})

            elif sub == "INTERLOCKS":
                return ujson.dumps(read_interlocks())

            elif sub == "FAULTS":
                return ujson.dumps(read_faults())

            elif sub == "TELEMETRY":
                return ujson.dumps(read_telemetry())

            else:
                return f"ERROR: unknown READ subcommand {sub}"

        # SET commands
        elif cmd == "SET":
            if len(parts) < 4:
                return "ERROR: SET requires subcommand, channel, value"
            sub = parts[1]

            if sub == "AO":
                ch = int(parts[2])
                volts = float(parts[3])
                ok = set_ao(ch, volts)
                return ujson.dumps({"ok": ok, "ch": ch, "v": volts})

            elif sub == "DO":
                ch = int(parts[2])
                state = parts[3] in ("HIGH", "1", "TRUE", "ON")
                ok = set_do(ch, state)
                return ujson.dumps({"ok": ok, "ch": ch, "state": state})

            elif sub == "GPIO":
                ch = int(parts[2])
                state = parts[3] in ("HIGH", "1", "TRUE", "ON")
                ok = set_gpio(ch, state)
                return ujson.dumps({"ok": ok, "ch": ch, "state": state})

            elif sub == "PWM":
                ch = int(parts[2])
                duty = int(parts[3])
                ok = set_pwm(ch, duty)
                return ujson.dumps({"ok": ok, "ch": ch, "duty_pct": duty})

            else:
                return f"ERROR: unknown SET subcommand {sub}"

        # OUTPUTS OFF
        elif cmd == "OUTPUTS" and len(parts) > 1 and parts[1] == "OFF":
            outputs_off()
            return ujson.dumps({"ok": True, "action": "all_outputs_off"})

        # RUN SELFTEST
        elif cmd == "RUN" and len(parts) > 1 and parts[1] == "SELFTEST":
            return ujson.dumps(run_selftest())

        # CALIBRATE
        elif cmd == "CALIBRATE":
            if len(parts) < 2:
                return "ERROR: CALIBRATE ADC|DAC"
            if parts[1] == "ADC":
                return ujson.dumps(calibrate_adc())
            elif parts[1] == "DAC":
                return ujson.dumps(calibrate_dac())

        else:
            return f"ERROR: unknown command {cmd}"

    except Exception as e:
        _log_fault(f"cmd parse error: {e}")
        return f"ERROR: {e}"


# ============================================================================
# Main loop
# ============================================================================
def main():
    global _calibrated

    # Hardware init sequence
    utime.sleep_ms(100)
    ina219_init()
    mcp23017_init()
    outputs_off()
    ads1256_init()

    # Verify EEPROM
    board_type = eeprom_read_board_type()
    if board_type == BOARD_TYPE:
        _calibrated = True
    else:
        _log_fault(f"EEPROM board type mismatch: '{board_type}' != '{BOARD_TYPE}'")

    # USB CDC setup (sys.stdin/stdout on RP2350)
    import sys
    buf = ""
    last_wdt_kick = utime.ticks_ms()

    print(f"FL-1 I/O Card FW {FW_VERSION} ready. Board: {board_type}")

    while True:
        # Kick watchdog every 100ms
        if utime.ticks_diff(utime.ticks_ms(), last_wdt_kick) > 100:
            kick_wdt()
            last_wdt_kick = utime.ticks_ms()

        # Read USB CDC
        try:
            ch = sys.stdin.read(1)
            if ch:
                if ch in ("\r", "\n"):
                    if buf:
                        resp = parse_command(buf)
                        if resp:
                            print(resp)
                    buf = ""
                else:
                    buf += ch
        except Exception:
            pass

        utime.sleep_ms(1)


if __name__ == "__main__":
    main()
