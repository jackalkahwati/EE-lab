"""MCU-family adapters for the composed-board firmware generator.

The generator (gen_firmware_compose.py) is family-independent: it takes the
planner's pin allocation (<board>.pin-assignment.json: role -> MCU pad) and
the device manifest, and emits ONE crate layout for every MCU:

    src/lib.rs        drivers + self-test + Controller scaffold (embedded-hal 1.0
                      traits only — no HAL types, identical on every family)
    src/board.rs      THIS family's bring-up: clocks, buses, pins  (from here)
    src/main.rs       #[entry]: board::init() -> Controller -> control loop
    Cargo.toml / .cargo/config.toml / memory.x / build.rs   (from here)

Adding an MCU family = one row in FAMILIES (target triple, HAL crate, memory
map, peripheral-instance rules, a board.rs template) + `pad_names` on its
mcu_specs seed so pad numbers resolve to pin names. Nothing else changes.

Pure python (no pcbnew) so it is unit-testable outside KiCad.
"""
import os
import re
import sys

# planner specs: single source of truth for pad -> pin name
_PLANNER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "..",
                        "hardware", "planner")
if _PLANNER not in sys.path:
    sys.path.insert(0, _PLANNER)
try:
    import mcu_specs  # noqa: E402
except Exception:  # pragma: no cover - reported by the caller
    mcu_specs = None


class FamilyError(Exception):
    """A design this adapter cannot honestly turn into an image."""


# --------------------------------------------------------------------------
# family table
# --------------------------------------------------------------------------
_COMMON_DEPS = ('embedded-hal = "1.0"\n'
                'embedded-hal-bus = "0.3"\n'
                'cortex-m = "0.7"\n'
                'cortex-m-rt = "0.7"\n'
                'panic-halt = "1.0"\n')

FAMILIES = {
    "rp2040": {
        "label": "RP2040 (Raspberry Pi Pico module)",
        "target": "thumbv6m-none-eabi",
        "hal": "rp2040-hal", "hal_version": "0.11",
        "deps": _COMMON_DEPS
                + 'rp2040-hal = { version = "0.11", features = ["rt", "critical-section-impl"] }\n'
                + 'rp2040-boot2 = "0.3"\n',
        "memory_x": (
            "MEMORY {\n"
            "    BOOT2 : ORIGIN = 0x10000000, LENGTH = 0x100\n"
            "    FLASH : ORIGIN = 0x10000100, LENGTH = 2048K - 0x100\n"
            "    RAM   : ORIGIN = 0x20000000, LENGTH = 256K\n"
            "}\n"
            "EXTERN(BOOT2_FIRMWARE)\n"
            "SECTIONS {\n"
            "    .boot2 ORIGIN(BOOT2) :\n"
            "    {\n"
            "        KEEP(*(.boot2));\n"
            "    } > BOOT2\n"
            "} INSERT BEFORE .text;\n"),
        "main_extra": (
            "/// Second-stage bootloader (W25Q-class QSPI flash, as on the Pico).\n"
            "#[link_section = \".boot2\"]\n"
            "#[used]\n"
            "pub static BOOT2: [u8; 256] = rp2040_boot2::BOOT_LOADER_GENERIC_03H;\n"),
        "mcu_key": "RP2040",
        "buses": ("i2c", "spi", "gpio", "delay"),
    },
    "stm32f1": {
        "label": "STM32F1 (STM32F103C8T6 LQFP-48)",
        "target": "thumbv7m-none-eabi",
        "hal": "stm32f1xx-hal", "hal_version": "0.11",
        "deps": _COMMON_DEPS
                + 'stm32f1xx-hal = { version = "0.11", features = ["stm32f103", "medium"] }\n',
        "memory_x": (
            "MEMORY {\n"
            "    FLASH : ORIGIN = 0x08000000, LENGTH = 64K\n"
            "    RAM   : ORIGIN = 0x20000000, LENGTH = 20K\n"
            "}\n"),
        "main_extra": "",
        "mcu_key": "STM32F103",
        "buses": ("i2c", "spi", "gpio", "delay"),
    },
}

_ALIASES = {"rp2040": "rp2040", "pico": "rp2040", "stm32f1": "stm32f1", "stm32f103": "stm32f1",
            "stm32": "stm32f1"}


def resolve_family(tag):
    """Family key for a planner family tag ('STM32F1', 'stm32f1', 'rp2040'…) or None."""
    if not tag:
        return None
    t = str(tag).strip().lower()
    if t in _ALIASES:
        return _ALIASES[t]
    for k in FAMILIES:
        if t.startswith(k):
            return k
    return None


def pad_names_for(family):
    """pad number (str) -> pin name, from the planner's MCU seed."""
    if mcu_specs is None:
        raise FamilyError("planner mcu_specs not importable; cannot name MCU pads")
    spec = mcu_specs.get_mcu(FAMILIES[family]["mcu_key"])
    names = (spec or {}).get("pad_names") or {}
    if not names:
        raise FamilyError("mcu_specs %s has no pad_names table" % FAMILIES[family]["mcu_key"])
    return {str(k): v for k, v in names.items()}


def name_pins(family, assignments):
    """[{role, pad, cap}] -> [{role, pad, cap, name}] using the seed's pad_names.
    A pad without a name is an error (never guess a pin)."""
    names = pad_names_for(family)
    out = []
    for a in assignments:
        pad = str(a.get("pad"))
        if pad not in names:
            raise FamilyError("pad %s (role %s) has no pin name for %s"
                              % (pad, a.get("role"), FAMILIES[family]["mcu_key"]))
        out.append({"role": a["role"], "pad": pad, "cap": a.get("cap", ""), "name": names[pad]})
    return out


def field_name(role):
    return re.sub(r"[^a-z0-9]+", "_", str(role).lower()).strip("_") or "pin"


# --------------------------------------------------------------------------
# bus plan: which HAL instance drives which allocated pins
# --------------------------------------------------------------------------
def _by_role(pins):
    return {p["role"]: p for p in pins}


def plan_buses(family, pins):
    """Decide the I2C / SPI instances and GPIO outputs for this family from the
    allocated pins. Returns {'i2c': {...}|None, 'spi': {...}|None, 'outs': [...]}.
    Raises FamilyError when the allocation cannot map onto a real instance."""
    r = _by_role(pins)
    plan = {"i2c": None, "spi": None, "outs": []}
    if "I2C_SDA" in r and "I2C_SCL" in r:
        plan["i2c"] = _I2C_RULES[family](r["I2C_SDA"]["name"], r["I2C_SCL"]["name"])
    if all(k in r for k in ("SPI_SCK", "SPI_MOSI", "SPI_MISO")):
        plan["spi"] = _SPI_RULES[family](r["SPI_SCK"]["name"], r["SPI_MOSI"]["name"],
                                         r["SPI_MISO"]["name"])
    for p in pins:
        if p["cap"] in ("gpio", "spi_cs"):
            plan["outs"].append({"field": field_name(p["role"]), "role": p["role"], "name": p["name"]})
    return plan


def _stm32_i2c(sda, scl):
    inst = {("PB7", "PB6"): "I2C1", ("PB11", "PB10"): "I2C2"}.get((sda, scl))
    if not inst:
        raise FamilyError("no STM32F1 I2C instance on SDA=%s SCL=%s" % (sda, scl))
    return {"inst": inst, "sda": sda, "scl": scl}


def _stm32_spi(sck, mosi, miso):
    inst = {("PA5", "PA7", "PA6"): "SPI1", ("PB13", "PB15", "PB14"): "SPI2"}.get((sck, mosi, miso))
    if not inst:
        raise FamilyError("no STM32F1 SPI instance on SCK=%s MOSI=%s MISO=%s" % (sck, mosi, miso))
    return {"inst": inst, "sck": sck, "mosi": mosi, "miso": miso}


def _gp(name):
    m = re.fullmatch(r"GP(\d+)", name or "")
    if not m:
        raise FamilyError("not an RP2040 GPIO name: %r" % name)
    return int(m.group(1))


def _rp2040_i2c(sda, scl):
    s, c = _gp(sda), _gp(scl)
    if s % 4 != 0 or c % 4 != 1 or (s // 4 % 2) != (c // 4 % 2):
        # RP2040 mux: SDA on GP(4k), GP(4k+2); SCL on GP(4k+1), GP(4k+3); the
        # instance alternates every two GPIO (I2C0: 0/1,4/5,8/9,…; I2C1: 2/3,6/7,…)
        if not (s % 2 == 0 and c == s + 1):
            raise FamilyError("RP2040 I2C needs SDA=GP(even) and SCL=SDA+1, got %s/%s" % (sda, scl))
    inst = "I2C0" if (s % 4) == 0 else "I2C1"
    return {"inst": inst, "sda": sda, "scl": scl}


def _rp2040_spi(sck, mosi, miso):
    k, o, i = _gp(sck), _gp(mosi), _gp(miso)
    if k in (2, 6, 18, 22) and o in (3, 7, 19, 23) and i in (0, 4, 16, 20):
        inst = "SPI0"
    elif k in (10, 14) and o in (11, 15) and i in (8, 12):
        inst = "SPI1"
    else:
        raise FamilyError("no RP2040 SPI instance on SCK=%s MOSI=%s MISO=%s" % (sck, mosi, miso))
    return {"inst": inst, "sck": sck, "mosi": mosi, "miso": miso}


_I2C_RULES = {"stm32f1": _stm32_i2c, "rp2040": _rp2040_i2c}
_SPI_RULES = {"stm32f1": _stm32_spi, "rp2040": _rp2040_spi}


# --------------------------------------------------------------------------
# board.rs emitters
# --------------------------------------------------------------------------
def _stm32_pin(name):
    m = re.fullmatch(r"P([A-E])(\d+)", name)
    if not m:
        raise FamilyError("not an STM32 pin name: %r" % name)
    port, num = m.group(1).lower(), int(m.group(2))
    return port, num


def _board_stm32f1(mcu, plan):
    L = ["//! Board bring-up for %s (family stm32f1): clocks, buses and pins as" % mcu,
         "//! allocated by the planner (pin-assignment.json). Generated — do not edit.",
         "//! Clock: internal HSI (the design carries no crystal); buses run at safe",
         "//! conservative rates.",
         "#![allow(unused_imports, unused_mut, unused_variables, dead_code)]",
         "use stm32f1xx_hal::{pac, prelude::*, gpio::{ErasedPin, Output, PushPull},",
         "                    i2c::{I2c, Mode}, spi::{Spi, Mode as SpiMode, Phase, Polarity},",
         "                    timer::{SysDelay, Delay as TimDelay}};",
         "",
         "pub type OutPin = ErasedPin<Output<PushPull>>;",
         "pub type Delay = SysDelay;",
         "pub type LoopDelay = TimDelay<pac::TIM2, 1_000_000>;"]
    if plan["i2c"]:
        L.append("pub type I2cBus = I2c<pac::%s>;" % plan["i2c"]["inst"])
    if plan["spi"]:
        L.append("pub type SpiBus = Spi<pac::%s, u8>;" % plan["spi"]["inst"])
    L += ["", "pub struct Board {"]
    if plan["i2c"]:
        L.append("    pub i2c: I2cBus,")
    if plan["spi"]:
        L.append("    pub spi: SpiBus,")
    L += ["    pub delay: Delay,", "    pub loop_delay: LoopDelay,"]
    for o in plan["outs"]:
        L.append("    /// %s (%s)" % (o["role"], o["name"]))
        L.append("    pub %s: OutPin," % o["field"])
    L += ["}", "",
          "pub fn init() -> Board {",
          "    let dp = pac::Peripherals::take().unwrap();",
          "    let cp = cortex_m::Peripherals::take().unwrap();",
          "    let mut rcc = dp.RCC.constrain();",
          "    let mut gpioa = dp.GPIOA.split(&mut rcc);",
          "    let mut gpiob = dp.GPIOB.split(&mut rcc);",
          "    let mut gpioc = dp.GPIOC.split(&mut rcc);"]
    if plan["i2c"]:
        i = plan["i2c"]
        L.append("    let i2c = I2c::new(dp.%s, (gpio%s.%s, gpio%s.%s), Mode::standard(100.kHz()), &mut rcc);"
                 % (i["inst"], _stm32_pin(i["scl"])[0], i["scl"].lower(),
                    _stm32_pin(i["sda"])[0], i["sda"].lower()))
    if plan["spi"]:
        s = plan["spi"]
        L.append("    let spi = dp.%s.spi((Some(gpio%s.%s), Some(gpio%s.%s), Some(gpio%s.%s)),"
                 % (s["inst"], _stm32_pin(s["sck"])[0], s["sck"].lower(),
                    _stm32_pin(s["miso"])[0], s["miso"].lower(),
                    _stm32_pin(s["mosi"])[0], s["mosi"].lower()))
        L.append("        SpiMode { phase: Phase::CaptureOnFirstTransition, polarity: Polarity::IdleLow },")
        L.append("        1.MHz(), &mut rcc);")
    L.append("    let delay = cp.SYST.delay(&rcc.clocks);")
    L.append("    let loop_delay = dp.TIM2.delay::<1_000_000>(&mut rcc);")
    for o in plan["outs"]:
        port, num = _stm32_pin(o["name"])
        L.append("    let %s = gpio%s.%s.into_push_pull_output(&mut gpio%s.%s).erase();"
                 % (o["field"], port, o["name"].lower(), port, "crl" if num < 8 else "crh"))
    fields = (["i2c"] if plan["i2c"] else []) + (["spi"] if plan["spi"] else []) + \
        ["delay", "loop_delay"] + [o["field"] for o in plan["outs"]]
    L += ["    Board { " + ", ".join(fields) + " }", "}", ""]
    return "\n".join(L)


def _board_rp2040(mcu, plan):
    L = ["//! Board bring-up for %s (family rp2040): clocks, buses and pins as" % mcu,
         "//! allocated by the planner (pin-assignment.json). Generated — do not edit.",
         "#![allow(unused_imports, unused_mut, unused_variables, dead_code)]",
         "use rp2040_hal::{self as hal, pac, Clock, Sio, Watchdog, Timer,",
         "                 clocks::init_clocks_and_plls, fugit::RateExtU32,",
         "                 gpio::{Pins, Pin, bank0, DynPinId, FunctionI2C, FunctionSpi, FunctionSioOutput, PullUp, PullDown},",
         "                 i2c::I2C, spi::Spi};",
         "use embedded_hal::spi::MODE_0;",
         "",
         "/// Pico module crystal.",
         "const XOSC_CRYSTAL_FREQ: u32 = 12_000_000;",
         "",
         "pub type OutPin = Pin<DynPinId, FunctionSioOutput, PullDown>;",
         "pub type Delay = Timer;",
         "pub type LoopDelay = Timer;"]
    if plan["i2c"]:
        i = plan["i2c"]
        L.append("pub type I2cBus = I2C<pac::%s, (Pin<bank0::Gpio%d, FunctionI2C, PullUp>, Pin<bank0::Gpio%d, FunctionI2C, PullUp>)>;"
                 % (i["inst"], _gp(i["sda"]), _gp(i["scl"])))
    if plan["spi"]:
        s = plan["spi"]
        L.append("pub type SpiBus = Spi<hal::spi::Enabled, pac::%s, (Pin<bank0::Gpio%d, FunctionSpi, PullDown>, Pin<bank0::Gpio%d, FunctionSpi, PullDown>, Pin<bank0::Gpio%d, FunctionSpi, PullDown>), 8>;"
                 % (s["inst"], _gp(s["mosi"]), _gp(s["miso"]), _gp(s["sck"])))
    L += ["", "pub struct Board {"]
    if plan["i2c"]:
        L.append("    pub i2c: I2cBus,")
    if plan["spi"]:
        L.append("    pub spi: SpiBus,")
    L += ["    pub delay: Delay,", "    pub loop_delay: LoopDelay,"]
    for o in plan["outs"]:
        L.append("    /// %s (%s)" % (o["role"], o["name"]))
        L.append("    pub %s: OutPin," % o["field"])
    L += ["}", "",
          "pub fn init() -> Board {",
          "    let mut p = pac::Peripherals::take().unwrap();",
          "    let mut watchdog = Watchdog::new(p.WATCHDOG);",
          "    let clocks = init_clocks_and_plls(XOSC_CRYSTAL_FREQ, p.XOSC, p.CLOCKS, p.PLL_SYS, p.PLL_USB,",
          "                                      &mut p.RESETS, &mut watchdog).ok().unwrap();",
          "    let sio = Sio::new(p.SIO);",
          "    let pins = Pins::new(p.IO_BANK0, p.PADS_BANK0, sio.gpio_bank0, &mut p.RESETS);",
          "    let timer = Timer::new(p.TIMER, &mut p.RESETS, &clocks);"]
    if plan["i2c"]:
        i = plan["i2c"]
        L.append("    let i2c = I2C::%s(p.%s, pins.gpio%d.reconfigure(), pins.gpio%d.reconfigure(), 400.kHz(),"
                 % (i["inst"].lower(), i["inst"], _gp(i["sda"]), _gp(i["scl"])))
        L.append("                        &mut p.RESETS, clocks.system_clock.freq());")
    if plan["spi"]:
        s = plan["spi"]
        L.append("    let spi = Spi::<_, _, _, 8>::new(p.%s, (pins.gpio%d.reconfigure(), pins.gpio%d.reconfigure(), pins.gpio%d.reconfigure()))"
                 % (s["inst"], _gp(s["mosi"]), _gp(s["miso"]), _gp(s["sck"])))
        L.append("        .init(&mut p.RESETS, clocks.peripheral_clock.freq(), 1.MHz(), MODE_0);")
    for o in plan["outs"]:
        L.append("    let %s = pins.gpio%d.into_push_pull_output().into_dyn_pin();" % (o["field"], _gp(o["name"])))
    fields = (["i2c"] if plan["i2c"] else []) + (["spi"] if plan["spi"] else []) + \
        ["delay: timer", "loop_delay: timer"] + [o["field"] for o in plan["outs"]]
    L += ["    Board { " + ", ".join(fields) + " }", "}", ""]
    return "\n".join(L)


_BOARD = {"stm32f1": _board_stm32f1, "rp2040": _board_rp2040}


def emit_board(family, mcu, plan):
    return _BOARD[family](mcu, plan)


# --------------------------------------------------------------------------
# crate skeleton
# --------------------------------------------------------------------------
BUILD_RS = '''//! Put memory.x where cortex-m-rt's link.x can INCLUDE it.
use std::{env, fs, path::PathBuf};

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    fs::copy("memory.x", out.join("memory.x")).unwrap();
    println!("cargo:rustc-link-search={}", out.display());
    println!("cargo:rerun-if-changed=memory.x");
    println!("cargo:rerun-if-changed=build.rs");
}
'''


def crate_files(family, extra_deps=""):
    """{relative path: content} for the family-specific crate skeleton."""
    f = FAMILIES[family]
    cargo = ('[package]\nname = "firmware"\nversion = "0.1.0"\nedition = "2021"\n\n'
             '[dependencies]\n' + f["deps"] + extra_deps +
             '\n[profile.release]\nopt-level = "z"\ndebug = 1\nlto = true\n'
             'codegen-units = 1\n')
    cfg = ('[build]\ntarget = "%s"\n\n[target.%s]\nrustflags = ["-C", "link-arg=-Tlink.x"]\n'
           % (f["target"], f["target"]))
    return {"Cargo.toml": cargo, ".cargo/config.toml": cfg, "memory.x": f["memory_x"],
            "build.rs": BUILD_RS}


def elf_path(family, target_dir):
    return os.path.join(target_dir, FAMILIES[family]["target"], "release", "firmware")
