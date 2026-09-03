"""
MCU board model: RP2040/Pico2 with 3.3V power, I2C bus, LED, reset circuit.
Mirrors the Control module from dut-power-rev-a/eload-rev-a/io-card-rev-a.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from board_model import Board


def build() -> Board:
    b = Board(name="FL-1 MCU Board (Pico2)")

    # External 5V from power board (or USB)
    b.add_rail("5V", 5.0)

    # --- 5V → 3.3V LDO (RT9080, internal to Pico2) ---
    u_ldo = b.add_vreg("U_LDO_RT9080", "5V", "3V3", vout_nominal=3.3, dropout=0.5)
    cin_ldo = b.add_c("C_LDO_IN", "5V", "GND", 10e-6)
    cout_ldo = b.add_c("C_LDO_OUT", "3V3", "GND", 10e-6)

    # --- MCU core ---
    u_mcu = b.add_ic("U1_RP2040", "3V3", "GND", load_ohms=200.0)
    c_mcu1 = b.add_c("C_MCU1", "3V3", "GND", 100e-9)
    c_mcu2 = b.add_c("C_MCU2", "3V3", "GND", 100e-9)

    # --- Reset circuit: TPS3823 supervisor ---
    # MR pin is open-collector with pull-up; nRST drives MCU reset
    r_mr = b.add_r("R_MR", "3V3", "MR_NET", 100e3)
    u_wdt = b.add_ic("U2_TPS3823", "3V3", "GND", load_ohms=10e3)
    c_wdt = b.add_c("C_WDT", "3V3", "GND", 100e-9)
    # Reset line (nRST to MCU — model as R to 3V3)
    r_rst = b.add_r("R_RST", "3V3", "nRST", 10e3)

    # --- I2C bus with pull-ups ---
    # SDA and SCL pulled to 3.3V
    r_sda = b.add_r("R_SDA", "3V3", "I2C_SDA", 4700.0)
    r_scl = b.add_r("R_SCL", "3V3", "I2C_SCL", 4700.0)
    # I2C device loads (EEPROM, INA219 etc.)
    r_i2c_load = b.add_r("R_I2C_LOAD", "I2C_SDA", "GND", 100e3)

    # --- Status LEDs ---
    # 3 LEDs with 330Ω series resistors
    r_led1 = b.add_r("R_LED1", "3V3", "LED1_A", 330.0)
    d_led1 = b.add_diode("D_LED1", "LED1_A", "GND", vf=2.0)

    r_led2 = b.add_r("R_LED2", "3V3", "LED2_A", 330.0)
    d_led2 = b.add_diode("D_LED2", "LED2_A", "GND", vf=2.0)

    r_led3 = b.add_r("R_LED3", "3V3", "LED3_A", 330.0)
    d_led3 = b.add_diode("D_LED3", "LED3_A", "GND", vf=2.0)

    # --- UART / USB connector stub (resistive model) ---
    r_usb = b.add_r("R_USB", "5V", "GND", 10e3)

    # --- Flash bypass ---
    b.add_c("C_FLASH", "3V3", "GND", 100e-9)

    # --- Test points ---
    # Original TPs
    b.add_tp("TP_5V", "5V")
    b.add_tp("TP_3V3", "3V3")
    b.add_tp("TP_nRST", "nRST")
    b.add_tp("TP_SDA", "I2C_SDA")
    b.add_tp("TP_SCL", "I2C_SCL")
    b.add_tp("TP_GND", "GND")
    # Added: interior TPs between LED series R and diode anode.
    # Previously all 3 LEDs were indistinguishable — each was just 3V3→GND
    # with no internal probe point. These split each string into R + diode.
    b.add_tp("TP_LED1_A", "LED1_A")    # between R_LED1 and D_LED1
    b.add_tp("TP_LED2_A", "LED2_A")    # between R_LED2 and D_LED2
    b.add_tp("TP_LED3_A", "LED3_A")    # between R_LED3 and D_LED3
    b.add_tp("TP_MR", "MR_NET")        # watchdog MR pin pull-up node

    return b


if __name__ == "__main__":
    board = build()
    print(f"Board: {board.name}")
    print(f"Nets: {board.nets}")
    print(f"Components: {len(board.components)}")
    print(f"Test points: {[tp.tp_name for tp in board.testpoints()]}")
