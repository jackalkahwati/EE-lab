#!/usr/bin/env python3
"""ESP32-C3 firmware crate generator — the esp-hal (RISC-V Rust) sibling of
gen_firmware_compose.py. Reads the composed board + device manifest and emits
a no_std esp-hal crate whose pin map is traced from the ROUTED BOARD's nets
(never guessed): each interface net found on the module's pads becomes a pin
constant.

v1 scope (honest): a compiling BSP crate — verified pin constants, peripheral
inventory, heartbeat main loop — gated by `cargo build` for
riscv32imc-unknown-none-elf exactly like the RP2040 path. Per-peripheral HAL
drivers (I2C sensor bring-up etc.) are the next rung and are listed as
explicit TODOs in the emitted crate, not silently omitted.

Usage: gen_firmware_esp32c3.py <board.kicad_pcb> <out-dir>
"""
import json
import os
import re
import sys

import pcbnew

BOARD = sys.argv[1]
OUT = sys.argv[2]

# ESP32-C3-WROOM-02 module pad -> GPIO number (from the KiCad symbol; straps
# and power pads excluded). Keep in step with MCU_PROFILES["esp32c3"].
PAD_TO_IO = {3: 4, 4: 5, 5: 6, 6: 7, 7: 8, 8: 9, 10: 10, 11: 20, 12: 21,
             13: 18, 14: 19, 15: 3, 16: 2, 17: 1, 18: 0}

SIGNALS = [
    "SPI_SCK", "SPI_MOSI", "SPI_MISO", "SPI_CS",
    "I2C_SDA", "I2C_SCL", "AUDIO_PWM", "AMP_EN",
    "GPS_TX", "GPS_RX", "UART_TX", "UART_RX", "C3_TXD", "C3_RXD",
]


def load():
    b = pcbnew.LoadBoard(BOARD)
    pins = {}
    for fp in b.GetFootprints():
        nm = str(fp.GetFPID().GetLibItemName())
        if "ESP32-C3" not in nm:
            continue
        for p in fp.Pads():
            try:
                pad = int(re.sub(r"[^0-9]", "", p.GetNumber()) or 0)
            except ValueError:
                continue
            sig = str(p.GetNetname()).strip()
            if sig in SIGNALS and pad in PAD_TO_IO:
                pins[sig] = PAD_TO_IO[pad]
    manifest = os.path.splitext(BOARD)[0] + ".devices.json"
    peripherals = []
    try:
        for d in json.load(open(manifest)):
            if d.get("type") not in ("mcu", "connector"):
                peripherals.append("%s (%s)" % (d.get("name") or d.get("type"), d.get("ref")))
    except Exception:
        pass
    return pins, peripherals


CARGO_TOML = """[package]
name = "fl-board-esp32c3"
version = "0.1.0"
edition = "2021"

[dependencies]
esp-hal = { version = "1.0.0-rc.1", features = ["esp32c3", "unstable"] }
panic-halt = "1"

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
"""

CARGO_CONFIG = """[build]
target = "riscv32imc-unknown-none-elf"

[target.riscv32imc-unknown-none-elf]
rustflags = ["-C", "link-arg=-Tlinkall.x"]

[unstable]
build-std = []
"""


def emit(pins, peripherals):
    os.makedirs(os.path.join(OUT, "src"), exist_ok=True)
    os.makedirs(os.path.join(OUT, ".cargo"), exist_ok=True)
    open(os.path.join(OUT, "Cargo.toml"), "w").write(CARGO_TOML)
    open(os.path.join(OUT, ".cargo", "config.toml"), "w").write(CARGO_CONFIG)

    pin_consts = "\n".join(
        "    /// net %s (traced from the routed board)\n    pub const %s: u8 = %d;"
        % (s, s, pins[s]) for s in SIGNALS if s in pins) or \
        "    // no interface nets reach the module on this board"
    periph_doc = "\n".join("//!   - %s" % p for p in peripherals) or "//!   (none)"

    main_rs = '''//! FirstLight board support crate — ESP32-C3-WROOM-02.
//! Pin constants are traced from the ROUTED BOARD (never guessed).
//! Peripherals on this board:
%s
//!
//! v1 BSP: verified pin map + heartbeat. Per-peripheral HAL drivers are the
//! next rung of the firmware ladder (TODO markers below) — this crate is the
//! compile-gated foundation they build on.
#![no_std]
#![no_main]

use esp_hal::clock::CpuClock;
use esp_hal::delay::Delay;
use esp_hal::main;
use panic_halt as _;

/// GPIO numbers for every interface net routed to the module.
pub mod pins {
%s
}

#[main]
fn main() -> ! {
    let config = esp_hal::Config::default().with_cpu_clock(CpuClock::max());
    let _peripherals = esp_hal::init(config);
    let delay = Delay::new();

    // TODO(firmware ladder): I2C bus init + sensor bring-up when pins::I2C_SDA
    // exists; PWM audio when pins::AUDIO_PWM exists; WiFi/BLE via esp-radio.
    loop {
        // heartbeat — proves the image runs; replace with the control loop
        delay.delay_millis(500);
    }
}
''' % (periph_doc, pin_consts)
    open(os.path.join(OUT, "src", "main.rs"), "w").write(main_rs)


def main():
    pins, peripherals = load()
    emit(pins, peripherals)
    print("FIRMWARE: target esp32c3 (riscv32imc-unknown-none-elf, esp-hal)")
    print("FIRMWARE: peripherals [{}]".format(", ".join(peripherals) or "none"))
    print("FIRMWARE: pins " + (", ".join(
        "{}=IO{}".format(s, pins[s]) for s in SIGNALS if s in pins) or "(none)"))
    print("FIRMWARE: wrote crate -> {}".format(OUT))
    print("FIRMWARE: NOTE v1 BSP crate (pin map + heartbeat); per-peripheral "
          "drivers are explicit TODOs, not silently omitted")


if __name__ == "__main__":
    main()
