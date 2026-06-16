"""
FL-1 Calibration Board model: resistor decade, diode array, LED, RC filter,
EEPROM I2C pads. Simplified topology for fault isolation validation.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from board_model import Board


def build() -> Board:
    b = Board(name="FL-1 Calibration Board Rev A")

    # External 3.3V supply
    b.add_rail("3V3", 3.3)

    # =========================================================
    # Resistor decade network (precision reference resistors)
    # =========================================================
    # R10 (10Ω), R1K (1kΩ), R100K (100kΩ) in series from 3V3 → GND
    # Test points at each junction allow individual resistance verification
    r10 = b.add_r("R10", "3V3", "NODE_A", 10.0)
    r1k = b.add_r("R1K", "NODE_A", "NODE_B", 1e3)
    r100k = b.add_r("R100K", "NODE_B", "GND", 100e3)

    # Shunt caps at divider nodes (for filtering)
    b.add_c("C_SHUNT_A", "NODE_A", "GND", 10e-9)
    b.add_c("C_SHUNT_B", "NODE_B", "GND", 10e-9)

    # =========================================================
    # Diode array (signal + protection diodes)
    # =========================================================
    # D1: forward-biased from 3V3 via R_D1 (limits current)
    r_d1 = b.add_r("R_D1", "3V3", "D1_ANODE", 1e3)
    d1 = b.add_diode("D1", "D1_ANODE", "D1_CATHODE", vf=0.7)
    b.add_r("R_D1_LOAD", "D1_CATHODE", "GND", 10e3)

    # D2: Schottky (lower Vf ~0.3V)
    r_d2 = b.add_r("R_D2", "3V3", "D2_ANODE", 1e3)
    d2 = b.add_diode("D2", "D2_ANODE", "D2_CATHODE", vf=0.3)
    b.add_r("R_D2_LOAD", "D2_CATHODE", "GND", 10e3)

    # D3: reverse-biased (for protection test)
    # In healthy board, D3 is in reverse — modeled as 1e12Ω
    # For simplicity model as large R
    b.add_r("R_D3_REV", "3V3", "D3_NET", 10e6)

    # =========================================================
    # LED indicator
    # =========================================================
    r_led = b.add_r("R_LED", "3V3", "LED_A", 330.0)
    d_led = b.add_diode("D_LED", "LED_A", "GND", vf=2.1)

    # =========================================================
    # RC low-pass filter (for ADC input verification)
    # =========================================================
    r_rc = b.add_r("R_RC", "NODE_B", "RC_OUT", 10e3)
    c_rc = b.add_c("C_RC", "RC_OUT", "GND", 100e-9)

    # =========================================================
    # EEPROM I2C pads (24AA025)
    # =========================================================
    # Modeled as: pull-up R on SDA/SCL to 3V3, IC load
    r_sda = b.add_r("R_EEPROM_SDA", "3V3", "SDA", 4700.0)
    r_scl = b.add_r("R_EEPROM_SCL", "3V3", "SCL", 4700.0)
    u_eeprom = b.add_ic("U_EEPROM", "3V3", "GND", load_ohms=100e3)

    # =========================================================
    # Precision voltage reference (REF3033 → 3.3V/2 = 1.65V)
    # =========================================================
    r_ref_div1 = b.add_r("R_REF1", "3V3", "VREF_IN", 10e3)
    u_ref = b.add_vref("U_REF", "VREF_IN", "VREF_OUT", vout=1.65)
    b.add_c("C_REF", "VREF_OUT", "GND", 100e-9)
    r_ref_load = b.add_r("R_REF_LOAD", "VREF_OUT", "GND", 100e3)

    # =========================================================
    # Test points (FL-1 probe destinations)
    # =========================================================
    b.add_tp("TP_3V3", "3V3")
    b.add_tp("TP_NODE_A", "NODE_A")       # between R10 and R1K
    b.add_tp("TP_NODE_B", "NODE_B")       # between R1K and R100K
    b.add_tp("TP_D1_A", "D1_ANODE")
    b.add_tp("TP_D1_K", "D1_CATHODE")
    b.add_tp("TP_D2_A", "D2_ANODE")
    b.add_tp("TP_D2_K", "D2_CATHODE")
    b.add_tp("TP_RC_OUT", "RC_OUT")
    b.add_tp("TP_VREF", "VREF_OUT")
    b.add_tp("TP_SDA", "SDA")
    b.add_tp("TP_GND", "GND")

    return b


if __name__ == "__main__":
    board = build()
    print(f"Board: {board.name}")
    print(f"Nets: {board.nets}")
    print(f"Components: {len(board.components)}")
    print(f"Test points: {[tp.tp_name for tp in board.testpoints()]}")
