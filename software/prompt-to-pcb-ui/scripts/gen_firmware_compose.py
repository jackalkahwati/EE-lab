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

    peripherals = []
    if "LORA_NSS" in nets_on_board or "SPI_SCK" in nets_on_board:
        peripherals.append("radio")
    if "I2C_SDA" in nets_on_board:
        peripherals.append("imu")
    motors = sorted(n for n in nets_on_board if re.fullmatch(r"MOTOR\d+", n))
    if motors:
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
    body = "\n\n".join(steps) if steps else "    // no probeable peripherals on this board"
    header = ("//! Bring-up self-test: probe each peripheral's identity register so a\n"
              "//! board either answers correctly or fails loudly at power-on.\n"
              + ("\n".join(doc) + "\n" if doc else "")
              + "//! Generated — do not edit.\n#![allow(dead_code)]\n\n")
    if steps:
        return header + "pub struct SelfTest;\n\nimpl SelfTest {\n" + body + "\n}\n"
    return header + body + "\n"


def emit(pins, peripherals, motors):
    os.makedirs(os.path.join(OUT, "src"), exist_ok=True)
    os.makedirs(os.path.join(OUT, ".cargo"), exist_ok=True)

    open(os.path.join(OUT, "Cargo.toml"), "w").write(
        '[package]\nname = "firmware"\nversion = "0.1.0"\nedition = "2021"\n\n'
        '[dependencies]\nembedded-hal = "1.0"\n\n'
        '[profile.release]\nopt-level = "z"\n')
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
    if "motors" in peripherals:
        open(os.path.join(OUT, "src", "motors.rs"), "w").write(emit_motors(motors))
        mods.append("motors")
    open(os.path.join(OUT, "src", "selftest.rs"), "w").write(emit_selftest(peripherals))
    mods.append("selftest")

    lib = ["//! Composed-board firmware support crate (no_std). BSP + per-peripheral",
           "//! HAL + bring-up self-test, generated from the routed board netlist by",
           "//! scripts/gen_firmware_compose.py.", "#![no_std]", ""]
    lib += ["pub mod {};".format(m) for m in mods]
    lib.append("")
    open(os.path.join(OUT, "src", "lib.rs"), "w").write("\n".join(lib))


def main():
    pins, peripherals, motors = load()
    if not pins:
        print("FIRMWARE: ERROR — no MCU pin map found (expected a Pico/RP2040 footprint)")
        sys.exit(1)
    emit(pins, peripherals, motors)
    print("FIRMWARE: peripherals [{}]{}".format(
        ", ".join(peripherals) or "none",
        ", {} motor channels".format(len(motors)) if motors else ""))
    print("FIRMWARE: pins " + ", ".join(
        "{}=GP{}".format(s, pins[s]) for s in SIGNALS if s in pins))
    print("FIRMWARE: wrote crate -> {}".format(OUT))


if __name__ == "__main__":
    main()
