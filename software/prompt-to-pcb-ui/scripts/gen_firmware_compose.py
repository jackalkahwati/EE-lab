"""Stage 5 firmware generator for COMPOSED boards (Layer 2). Emits a no_std
Rust board-support + HAL crate derived ENTIRELY from the routed board's netlist:
the MCU pin map and the peripheral set come from the same nets that built the
board, so the BSP matches the hardware by construction.

What it generates (bounded — driver layer, not application logic):
  - bsp.rs       MCU GPIO assignment for every interface signal on the board
  - radio.rs     SX127x/RFM95 LoRa driver over embedded-hal SPI  (if a radio net)
  - imu.rs       MPU-6050 IMU driver over embedded-hal I2C        (if an I2C net)
  - motors.rs    N-channel ESC/PWM output map + arm/throttle HAL  (if motor nets)
  - selftest.rs  bring-up: probe each peripheral's ID register, disarm motors
The hard gate (run separately) is `cargo build --target thumbv6m-none-eabi`.

Usage:  <kicad-python3> gen_firmware_compose.py <board.kicad_pcb> <out_dir>
Prints  FIRMWARE: peripherals <...>, pins <SIG=GPn ...>
"""
import json
import os
import re
import sys

import pcbnew

BOARD = sys.argv[1]
OUT = sys.argv[2]

# Raspberry Pi Pico physical pin -> GPIO number (control pins only).
PICO_PIN_TO_GP = {
    1: 0, 2: 1, 4: 2, 5: 3, 6: 4, 7: 5, 9: 6, 10: 7, 11: 8, 12: 9,
    14: 10, 15: 11, 16: 12, 17: 13, 19: 14, 20: 15, 21: 16, 22: 17,
    24: 18, 25: 19, 26: 20, 27: 21, 29: 22, 31: 26, 32: 27, 34: 28,
}

# interface net name -> canonical BSP signal constant
SIGNALS = [
    "SPI_SCK", "SPI_MOSI", "SPI_MISO", "LORA_NSS", "LORA_RST", "LORA_DIO0",
    "I2C_SDA", "I2C_SCL", "IMU_INT", "MOTOR1", "MOTOR2", "MOTOR3", "MOTOR4",
    "GPS_TX", "GPS_RX", "CELL_TX", "CELL_RX", "CELL_PWRKEY", "CELL_RST",
]


def load():
    b = pcbnew.LoadBoard(BOARD)
    pins = {}          # signal -> gpio
    nets_on_board = set()
    for fp in b.GetFootprints():
        for p in fp.Pads():
            nn = str(p.GetNetname()).strip()
            if nn:
                nets_on_board.add(nn)
        nm = str(fp.GetFPID().GetLibItemName())
        if "Pico" in nm or "RP2040" in nm:
            for p in fp.Pads():
                try:
                    pin = int(re.sub(r"[^0-9]", "", p.GetNumber()) or 0)
                except ValueError:
                    continue
                sig = str(p.GetNetname()).strip()
                if sig in SIGNALS and pin in PICO_PIN_TO_GP:
                    pins[sig] = PICO_PIN_TO_GP[pin]

    motors = sorted(n for n in nets_on_board if re.fullmatch(r"MOTOR\d+", n))

    # Prefer the composer's device manifest: it knows what each part IS, so an
    # I2C temp sensor gets a temp-sensor driver instead of being guessed as an
    # IMU (both share the I2C bus). Fall back to net-based guessing if absent.
    manifest = os.path.splitext(BOARD)[0] + ".devices.json"
    # Map each composed device type to a firmware peripheral driver. I2C
    # environmental / generic sensors (BME280 etc.) get the I2C sensor driver so
    # the board ships a real bring-up + control step instead of no driver at all.
    type_to_periph = {"radio": "radio", "imu": "imu", "gnss": "gnss",
                      "cellular": "cellular", "i2c_tempsensor": "tempsensor",
                      "i2c_envsensor": "tempsensor", "i2c_sensor": "tempsensor"}
    if os.path.exists(manifest):
        try:
            devs = json.load(open(manifest))
        except Exception:
            devs = []
        peripherals = []
        for d in devs:
            p = type_to_periph.get(d.get("type"))
            if p and p not in peripherals:
                peripherals.append(p)
    else:
        peripherals = []
        if "LORA_NSS" in nets_on_board or "SPI_SCK" in nets_on_board:
            peripherals.append("radio")
        if "I2C_SDA" in nets_on_board:
            peripherals.append("imu")
        if "GPS_TX" in nets_on_board:
            peripherals.append("gnss")
        if "CELL_TX" in nets_on_board:
            peripherals.append("cellular")
    if motors and "motors" not in peripherals:
        peripherals.append("motors")
    return pins, peripherals, motors


# ---- emitters ----------------------------------------------------------------
def emit_bsp(pins):
    out = ["//! Board-support: MCU GPIO map for every interface signal, extracted",
           "//! from the routed board (Raspberry Pi Pico). Generated — do not edit.",
           "#![allow(dead_code)]", ""]
    for sig in SIGNALS:
        if sig in pins:
            out.append("/// {} line.".format(sig.replace("_", " ")))
            out.append("pub const {}_GPIO: u8 = {};".format(sig, pins[sig]))
    out.append("")
    return "\n".join(out)


RADIO_RS = '''//! SX127x / RFM95 LoRa driver over an embedded-hal SPI device + control pins.
//! Register protocol is hardware-agnostic; the pin map lives in `bsp`.
//! Generated — do not edit.
#![allow(dead_code)]
use embedded_hal::spi::SpiDevice;
use embedded_hal::digital::OutputPin;

const REG_OP_MODE: u8 = 0x01;
const REG_VERSION: u8 = 0x42;
const MODE_SLEEP: u8 = 0x00;
const MODE_LORA: u8 = 0x80;
/// SX1276/77/78/79 silicon revision returned by RegVersion.
pub const SX127X_VERSION: u8 = 0x12;

pub struct Lora<SPI, RST> {
    spi: SPI,
    rst: RST,
}

impl<SPI: SpiDevice, RST: OutputPin> Lora<SPI, RST> {
    pub fn new(spi: SPI, rst: RST) -> Self {
        Self { spi, rst }
    }

    fn write_reg(&mut self, reg: u8, val: u8) -> Result<(), SPI::Error> {
        self.spi.write(&[reg | 0x80, val])
    }

    fn read_reg(&mut self, reg: u8) -> Result<u8, SPI::Error> {
        let mut buf = [reg & 0x7f, 0];
        self.spi.transfer_in_place(&mut buf)?;
        Ok(buf[1])
    }

    /// Hardware reset pulse (active-low on the RFM95).
    pub fn reset<D: embedded_hal::delay::DelayNs>(&mut self, delay: &mut D) {
        let _ = self.rst.set_low();
        delay.delay_ms(1);
        let _ = self.rst.set_high();
        delay.delay_ms(5);
    }

    /// Read RegVersion — `Ok(true)` if it matches the SX127x silicon id.
    pub fn probe(&mut self) -> Result<bool, SPI::Error> {
        Ok(self.read_reg(REG_VERSION)? == SX127X_VERSION)
    }

    /// Put the radio into LoRa mode (must transit through sleep).
    pub fn set_lora_mode(&mut self) -> Result<(), SPI::Error> {
        self.write_reg(REG_OP_MODE, MODE_SLEEP)?;
        self.write_reg(REG_OP_MODE, MODE_LORA)
    }
}
'''

IMU_RS = '''//! InvenSense MPU-6050 6-axis IMU driver over an embedded-hal I2C bus.
//! Generated — do not edit.
#![allow(dead_code)]
use embedded_hal::i2c::I2c;

/// 7-bit address with AD0 tied low (the board grounds AD0).
pub const ADDR: u8 = 0x68;
const REG_WHO_AM_I: u8 = 0x75;
const REG_PWR_MGMT_1: u8 = 0x6b;
const REG_ACCEL_XOUT_H: u8 = 0x3b;
/// WHO_AM_I value for the MPU-6050.
pub const WHO_AM_I: u8 = 0x68;

pub struct Imu<I2C> {
    i2c: I2C,
}

impl<I2C: I2c> Imu<I2C> {
    pub fn new(i2c: I2C) -> Self {
        Self { i2c }
    }

    fn read_reg(&mut self, reg: u8) -> Result<u8, I2C::Error> {
        let mut buf = [0u8; 1];
        self.i2c.write_read(ADDR, &[reg], &mut buf)?;
        Ok(buf[0])
    }

    /// Read WHO_AM_I — `Ok(true)` if it matches the MPU-6050 id.
    pub fn probe(&mut self) -> Result<bool, I2C::Error> {
        Ok(self.read_reg(REG_WHO_AM_I)? == WHO_AM_I)
    }

    /// Wake the device from its default sleep state.
    pub fn wake(&mut self) -> Result<(), I2C::Error> {
        self.i2c.write(ADDR, &[REG_PWR_MGMT_1, 0x00])
    }

    /// Burst-read the six accelerometer bytes (X, Y, Z big-endian).
    pub fn read_accel(&mut self) -> Result<[i16; 3], I2C::Error> {
        let mut b = [0u8; 6];
        self.i2c.write_read(ADDR, &[REG_ACCEL_XOUT_H], &mut b)?;
        Ok([
            i16::from_be_bytes([b[0], b[1]]),
            i16::from_be_bytes([b[2], b[3]]),
            i16::from_be_bytes([b[4], b[5]]),
        ])
    }
}
'''


GNSS_RS = '''//! GNSS receiver (Quectel L80-R, NMEA over UART) — reads sentences from an
//! embedded-io serial port. The UART GPIOs are in `bsp` (GPS_TX/GPS_RX).
//! Generated — do not edit.
#![allow(dead_code)]
use embedded_io::Read;

pub struct Gnss<R> {
    uart: R,
}

impl<R: Read> Gnss<R> {
    pub fn new(uart: R) -> Self {
        Self { uart }
    }

    /// Read one NMEA sentence (up to the newline) into `buf`; returns the byte
    /// count. Lines longer than `buf` are truncated.
    pub fn read_sentence(&mut self, buf: &mut [u8]) -> Result<usize, R::Error> {
        let mut i = 0;
        let mut b = [0u8; 1];
        while i < buf.len() {
            let n = self.uart.read(&mut b)?;
            if n == 0 {
                break;
            }
            if b[0] == b'\\n' {
                break;
            }
            if b[0] != b'\\r' {
                buf[i] = b[0];
                i += 1;
            }
        }
        Ok(i)
    }

    /// `Ok(true)` if the next sentence starts with '$' (a valid NMEA frame) and
    /// is a GGA/RMC fix line.
    pub fn has_fix_sentence(&mut self) -> Result<bool, R::Error> {
        let mut buf = [0u8; 83]; // max NMEA 0183 line
        let n = self.read_sentence(&mut buf)?;
        let line = &buf[..n];
        Ok(line.first() == Some(&b'$')
            && (line.windows(3).any(|w| w == b"GGA") || line.windows(3).any(|w| w == b"RMC")))
    }
}
'''

CELL_RS = '''//! Cellular modem (LTE-M / NB-IoT breakout) — AT-command driver over an
//! embedded-io read/write serial port. UART GPIOs + PWRKEY/RESET are in `bsp`.
//! Generated — do not edit.
#![allow(dead_code)]
use embedded_io::{Read, Write};

pub struct Modem<S> {
    uart: S,
}

impl<S: Read + Write> Modem<S> {
    pub fn new(uart: S) -> Self {
        Self { uart }
    }

    /// Send an AT command, appending CR/LF.
    pub fn send_at(&mut self, cmd: &str) -> Result<(), S::Error> {
        self.uart.write_all(cmd.as_bytes())?;
        self.uart.write_all(b"\\r\\n")
    }

    /// Read response bytes into `buf` (best-effort, up to `buf.len()`).
    pub fn read_response(&mut self, buf: &mut [u8]) -> Result<usize, S::Error> {
        self.uart.read(buf)
    }

    /// `Ok(true)` if the response to a bare `AT` contains "OK" (modem alive).
    pub fn probe(&mut self) -> Result<bool, S::Error> {
        self.send_at("AT")?;
        let mut buf = [0u8; 32];
        let n = self.read_response(&mut buf)?;
        Ok(buf[..n].windows(2).any(|w| w == b"OK"))
    }

    /// Attach to the packet network (LTE-M context activate).
    pub fn network_attach(&mut self) -> Result<(), S::Error> {
        self.send_at("AT+CGATT=1")
    }
}
'''


TEMPSENSOR_RS = '''//! I2C temperature sensor (LM75 / TMP1075 family) over an embedded-hal I2C bus.
//! 12-bit, left-justified temperature register; A0-A2 grounded -> address 0x48.
//! Generated — do not edit.
#![allow(dead_code)]
use embedded_hal::i2c::I2c;

/// 7-bit address with A0-A2 tied low (the board grounds them).
pub const ADDR: u8 = 0x48;
const REG_TEMP: u8 = 0x00;

pub struct TempSensor<I2C> {
    i2c: I2C,
}

impl<I2C: I2c> TempSensor<I2C> {
    pub fn new(i2c: I2C) -> Self {
        Self { i2c }
    }

    fn raw(&mut self) -> Result<i16, I2C::Error> {
        let mut b = [0u8; 2];
        self.i2c.write_read(ADDR, &[REG_TEMP], &mut b)?;
        Ok(i16::from_be_bytes(b) >> 4) // 12-bit, left-justified
    }

    /// Temperature in milli-degrees Celsius (0.0625 C/LSB).
    pub fn read_milli_c(&mut self) -> Result<i32, I2C::Error> {
        Ok(self.raw()? as i32 * 625 / 10)
    }

    /// Liveness: a successful temperature register read.
    pub fn probe(&mut self) -> Result<bool, I2C::Error> {
        self.raw().map(|_| true)
    }
}
'''


def emit_motors(motors):
    chans = "\n".join(
        "    /// {m} ESC signal (BSP `{m}_GPIO`).\n    {m},".format(m=m) for m in motors)
    arms = "\n".join("    Channel::{},".format(m) for m in motors)
    n = len(motors)
    return '''//! {n}-channel ESC/motor output map + a throttle HAL over embedded-hal PWM.
//! Standard 1000-2000us servo-PWM pulse band; the GPIO per channel is in `bsp`.
//! Generated — do not edit.
#![allow(dead_code)]
use embedded_hal::pwm::SetDutyCycle;

/// Motor output channels on this board.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Channel {{
{chans}
}}

/// Every channel, in board order (used by the disarm-all self-test step).
pub const CHANNELS: [Channel; {n}] = [
{arms}
];

/// Minimum / maximum ESC pulse width in microseconds (disarmed / full).
pub const PULSE_MIN_US: u16 = 1000;
pub const PULSE_MAX_US: u16 = 2000;

/// Map a 0.0..=1.0 throttle to a duty cycle for a PWM pin running at `period_us`
/// (e.g. 20_000us = 50 Hz). Clamps out-of-range throttle. Hardware-agnostic.
pub fn set_throttle<P: SetDutyCycle>(
    pwm: &mut P,
    throttle: f32,
    period_us: u32,
) -> Result<(), P::Error> {{
    let t = if throttle < 0.0 {{ 0.0 }} else if throttle > 1.0 {{ 1.0 }} else {{ throttle }};
    let pulse_us = PULSE_MIN_US as f32 + t * (PULSE_MAX_US - PULSE_MIN_US) as f32;
    let frac = pulse_us / period_us as f32;
    let max = pwm.max_duty_cycle();
    pwm.set_duty_cycle((frac * max as f32) as u16)
}}

/// Disarm: command minimum pulse (zero throttle).
pub fn disarm<P: SetDutyCycle>(pwm: &mut P, period_us: u32) -> Result<(), P::Error> {{
    set_throttle(pwm, 0.0, period_us)
}}
'''.format(n=n, chans=chans, arms=arms)


def emit_selftest(peripherals):
    steps, doc = [], []
    if "radio" in peripherals:
        doc.append("//! - radio: pulse reset, read RegVersion, enter LoRa mode")
        steps.append('''    /// Bring up the LoRa radio: reset, verify silicon id, enter LoRa mode.
    pub fn radio<SPI, RST, D>(lora: &mut crate::radio::Lora<SPI, RST>, delay: &mut D)
        -> Result<bool, SPI::Error>
    where
        SPI: embedded_hal::spi::SpiDevice,
        RST: embedded_hal::digital::OutputPin,
        D: embedded_hal::delay::DelayNs,
    {
        lora.reset(delay);
        if !lora.probe()? {
            return Ok(false);
        }
        lora.set_lora_mode()?;
        Ok(true)
    }''')
    if "imu" in peripherals:
        doc.append("//! - imu: read WHO_AM_I, wake from sleep")
        steps.append('''    /// Bring up the IMU: verify WHO_AM_I, wake from sleep.
    pub fn imu<I2C: embedded_hal::i2c::I2c>(imu: &mut crate::imu::Imu<I2C>)
        -> Result<bool, I2C::Error>
    {
        if !imu.probe()? {
            return Ok(false);
        }
        imu.wake()?;
        Ok(true)
    }''')
    if "tempsensor" in peripherals:
        doc.append("//! - tempsensor: read the temperature register")
        steps.append('''    /// Bring up the temperature sensor: confirm a register read succeeds.
    pub fn tempsensor<I2C: embedded_hal::i2c::I2c>(t: &mut crate::tempsensor::TempSensor<I2C>)
        -> Result<bool, I2C::Error>
    {
        t.probe()
    }''')
    if "gnss" in peripherals:
        doc.append("//! - gnss: read a sentence, confirm a valid NMEA fix frame")
        steps.append('''    /// Bring up the GNSS: confirm it is emitting valid NMEA fix sentences.
    pub fn gnss<R: embedded_io::Read>(gnss: &mut crate::gnss::Gnss<R>)
        -> Result<bool, R::Error>
    {
        gnss.has_fix_sentence()
    }''')
    if "cellular" in peripherals:
        doc.append("//! - cellular: AT probe, confirm the modem answers OK")
        steps.append('''    /// Bring up the modem: AT probe + network attach.
    pub fn cellular<S: embedded_io::Read + embedded_io::Write>(modem: &mut crate::cellular::Modem<S>)
        -> Result<bool, S::Error>
    {
        if !modem.probe()? {
            return Ok(false);
        }
        modem.network_attach()?;
        Ok(true)
    }''')
    body = "\n\n".join(steps) if steps else "    // no probeable peripherals on this board"
    header = ("//! Bring-up self-test: probe each peripheral's identity register so a\n"
              "//! board either answers correctly or fails loudly at power-on.\n"
              + ("\n".join(doc) + "\n" if doc else "")
              + "//! Generated — do not edit.\n#![allow(dead_code)]\n\n")
    if steps:
        return header + "pub struct SelfTest;\n\nimpl SelfTest {\n" + body + "\n}\n"
    return header + body + "\n"


def emit_app(peripherals, motors):
    """Deterministic Controller SCAFFOLD, generated from the peripheral set the
    same way the BSP/HAL is. The struct, generic bounds, new(), init(), and the
    control_step() SIGNATURE are correct-by-construction and always compile;
    ONLY the body between the FL_APP_FILL markers is meant to be rewritten
    (scaffold-fill: the pipeline lets the frontier model replace just that body,
    so it can never break the generics/imports/bounds). Left as generated, the
    body is a working per-peripheral control loop, so a board always ships a
    compiling app layer even if no model runs."""
    tparams = []   # (name, bound), ordered + unique
    fields = []    # (field_name, field_type)
    init_stmts = []
    step_stmts = []

    def add_tp(name, bound):
        if name not in [n for n, _ in tparams]:
            tparams.append((name, bound))

    if "radio" in peripherals:
        add_tp("SPr", "embedded_hal::spi::SpiDevice")
        add_tp("RSr", "embedded_hal::digital::OutputPin")
        fields.append(("radio", "crate::radio::Lora<SPr, RSr>"))
        init_stmts += ["self.radio.reset(&mut self.delay);",
                       "let _ = self.radio.probe().map_err(|_| ())?;",
                       "let _ = self.radio.set_lora_mode().map_err(|_| ())?;"]
        step_stmts.append("let _ = self.radio.probe().map_err(|_| ())?;")
    if "imu" in peripherals:
        add_tp("I2Ci", "embedded_hal::i2c::I2c")
        fields.append(("imu", "crate::imu::Imu<I2Ci>"))
        init_stmts += ["let _ = self.imu.probe().map_err(|_| ())?;",
                       "let _ = self.imu.wake().map_err(|_| ())?;"]
        step_stmts.append("let _ = self.imu.read_accel().map_err(|_| ())?;")
    if "tempsensor" in peripherals:
        add_tp("I2Ct", "embedded_hal::i2c::I2c")
        fields.append(("temp", "crate::tempsensor::TempSensor<I2Ct>"))
        init_stmts.append("let _ = self.temp.probe().map_err(|_| ())?;")
        step_stmts.append("let _ = self.temp.read_milli_c().map_err(|_| ())?;")
    if "gnss" in peripherals:
        add_tp("Rg", "embedded_io::Read")
        fields.append(("gnss", "crate::gnss::Gnss<Rg>"))
        step_stmts += ["let mut nmea = [0u8; 96];",
                       "let _ = self.gnss.read_sentence(&mut nmea).map_err(|_| ())?;"]
    if "cellular" in peripherals:
        add_tp("Sc", "embedded_io::Read + embedded_io::Write")
        fields.append(("modem", "crate::cellular::Modem<Sc>"))
        init_stmts += ["let _ = self.modem.probe().map_err(|_| ())?;",
                       "let _ = self.modem.network_attach().map_err(|_| ())?;"]
        step_stmts.append('let _ = self.modem.send_at("AT").map_err(|_| ())?;')
    if motors:
        add_tp("Pm", "embedded_hal::pwm::SetDutyCycle")
        fields.append(("pwm", "Pm"))
        init_stmts.append("let _ = crate::motors::disarm(&mut self.pwm, 20000).map_err(|_| ())?;")
        step_stmts.append("let _ = crate::motors::disarm(&mut self.pwm, 20000).map_err(|_| ())?;")
    if "radio" in peripherals:  # radio.reset() needs a delay; own one
        add_tp("Dd", "embedded_hal::delay::DelayNs")
        fields.append(("delay", "Dd"))

    L = ["//! Application control-loop SCAFFOLD, generated from the board's peripheral",
         "//! set. The struct, generic bounds, new(), init(), and the control_step()",
         "//! SIGNATURE are correct-by-construction; only the body between the",
         "//! FL_APP_FILL markers is meant to be rewritten. As generated it is a",
         "//! working per-peripheral control loop.",
         "//! Generated — do not edit outside the FL_APP_FILL markers.",
         "#![allow(dead_code)]", ""]

    if not fields:
        L += ["pub struct Controller;", "",
              "impl Controller {",
              "    pub fn new() -> Self { Self }",
              "    pub fn init(&mut self) -> Result<(), ()> { Ok(()) }",
              "    pub fn control_step(&mut self) -> Result<(), ()> {",
              "        // >>> FL_APP_FILL_BEGIN — control logic (the model rewrites below)",
              "        // no controllable peripherals on this board",
              "        // >>> FL_APP_FILL_END",
              "        Ok(())",
              "    }",
              "}"]
        return "\n".join(L) + "\n"

    tp_names = ", ".join(n for n, _ in tparams)
    tp_bounds = ", ".join("{}: {}".format(n, b) for n, b in tparams)
    L.append("pub struct Controller<" + tp_names + "> {")
    for fn, ft in fields:
        L.append("    " + fn + ": " + ft + ",")
    L += ["}", ""]
    L.append("impl<" + tp_bounds + "> Controller<" + tp_names + "> {")
    L.append("    pub fn new(" + ", ".join(fn + ": " + ft for fn, ft in fields) + ") -> Self {")
    L.append("        Self { " + ", ".join(fn for fn, _ in fields) + " }")
    L += ["    }", ""]
    L.append("    /// Bring up every peripheral once. Err(()) if one does not answer.")
    L.append("    pub fn init(&mut self) -> Result<(), ()> {")
    for s in init_stmts:
        L.append("        " + s)
    L += ["        Ok(())", "    }", ""]
    L.append("    /// One control iteration. Only the body between the FL_APP_FILL")
    L.append("    /// markers is meant to change; the signature is fixed.")
    L.append("    pub fn control_step(&mut self) -> Result<(), ()> {")
    L.append("        // >>> FL_APP_FILL_BEGIN — control logic (the model rewrites below)")
    for s in (step_stmts or ["// (all peripherals brought up in init)"]):
        L.append("        " + s)
    L += ["        // >>> FL_APP_FILL_END", "        Ok(())", "    }", "}"]
    return "\n".join(L) + "\n"


def emit(pins, peripherals, motors):
    os.makedirs(os.path.join(OUT, "src"), exist_ok=True)
    os.makedirs(os.path.join(OUT, ".cargo"), exist_ok=True)

    deps = '[dependencies]\nembedded-hal = "1.0"\n'
    if "gnss" in peripherals or "cellular" in peripherals:
        deps += 'embedded-io = "0.6"\n'
    open(os.path.join(OUT, "Cargo.toml"), "w").write(
        '[package]\nname = "firmware"\nversion = "0.1.0"\nedition = "2021"\n\n'
        + deps + '\n[profile.release]\nopt-level = "z"\n')
    open(os.path.join(OUT, ".cargo", "config.toml"), "w").write(
        '[build]\ntarget = "thumbv6m-none-eabi"\n')

    open(os.path.join(OUT, "src", "bsp.rs"), "w").write(emit_bsp(pins))

    mods = ["bsp"]
    if "radio" in peripherals:
        open(os.path.join(OUT, "src", "radio.rs"), "w").write(RADIO_RS)
        mods.append("radio")
    if "imu" in peripherals:
        open(os.path.join(OUT, "src", "imu.rs"), "w").write(IMU_RS)
        mods.append("imu")
    if "tempsensor" in peripherals:
        open(os.path.join(OUT, "src", "tempsensor.rs"), "w").write(TEMPSENSOR_RS)
        mods.append("tempsensor")
    if "motors" in peripherals:
        open(os.path.join(OUT, "src", "motors.rs"), "w").write(emit_motors(motors))
        mods.append("motors")
    if "gnss" in peripherals:
        open(os.path.join(OUT, "src", "gnss.rs"), "w").write(GNSS_RS)
        mods.append("gnss")
    if "cellular" in peripherals:
        open(os.path.join(OUT, "src", "cellular.rs"), "w").write(CELL_RS)
        mods.append("cellular")
    open(os.path.join(OUT, "src", "selftest.rs"), "w").write(emit_selftest(peripherals))
    mods.append("selftest")
    # deterministic application control loop (always compiles + ships; the
    # frontier model enhances it best-effort in the pipeline)
    open(os.path.join(OUT, "src", "app.rs"), "w").write(emit_app(peripherals, motors))
    mods.append("app")

    lib = ["//! Composed-board firmware support crate (no_std). BSP + per-peripheral",
           "//! HAL + bring-up self-test, generated from the routed board netlist by",
           "//! scripts/gen_firmware_compose.py.", "#![no_std]", ""]
    lib += ["pub mod {};".format(m) for m in mods]
    lib.append("")
    open(os.path.join(OUT, "src", "lib.rs"), "w").write("\n".join(lib))


def _mcu_family():
    """The composed board's MCU family, from the device manifest. This
    generator emits RP2040/Pico firmware ONLY — for any other family it must
    say so instead of shipping a Pico image for a non-Pico board."""
    manifest = os.path.splitext(BOARD)[0] + ".devices.json"
    try:
        for d in json.load(open(manifest)):
            if d.get("type") == "mcu":
                return d.get("family", "rp2040")
    except Exception:
        pass
    return "rp2040"


def main():
    fam = _mcu_family()
    if fam != "rp2040":
        # honest gate: no firmware image is better than the WRONG image
        print("FIRMWARE: SKIPPED — board MCU family '%s' is not supported by "
              "the RP2040 generator; the %s firmware target is pending. No "
              "image was produced (never a Pico image for a non-Pico board)."
              % (fam, fam))
        return
    pins, peripherals, motors = load()
    # A bare MCU + power board has no peripheral nets, so `pins` is empty — that
    # is valid hardware, not an error. Emit a minimal BSP crate that still
    # compiles (no pin constants / no probeable peripherals) rather than failing.
    emit(pins, peripherals, motors)
    print("FIRMWARE: peripherals [{}]{}".format(
        ", ".join(peripherals) or "none",
        ", {} motor channels".format(len(motors)) if motors else ""))
    print("FIRMWARE: pins " + ", ".join(
        "{}=GP{}".format(s, pins[s]) for s in SIGNALS if s in pins))
    print("FIRMWARE: wrote crate -> {}".format(OUT))


if __name__ == "__main__":
    main()
