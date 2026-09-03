"""
Power supply board model: VIN(24V) → 5V buck → 3.3V LDO chain.
Mirrors topology of TPS54331DR + TPS62086 as used in dut-power-rev-a,
eload-rev-a, and io-card-rev-a power trees.
"""
import sys
import os
sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from board_model import Board


def build() -> Board:
    b = Board(name="FL-1 Power Supply Board")

    # External 24V bench supply
    b.add_rail("VIN", 24.0)

    # --- Protection ---
    f1 = b.add_fuse("F1", "VIN", "VIN_FUSED", rating_a=3.0)
    tvs = b.add_diode("TVS1", "GND", "VIN_FUSED")  # TVS (rev-biased normally)

    # --- 24V → 5V TPS54331 buck regulator ---
    # Input caps
    cin1 = b.add_c("CIN1", "VIN_FUSED", "GND", 22e-6)
    cin2 = b.add_c("CIN2", "VIN_FUSED", "GND", 100e-9)
    # Buck inductor
    l1 = b.add_l("L1", "VIN_FUSED", "SW1", 33e-6)
    # Catch diode (freewheel)
    d_boot = b.add_diode("D1", "GND", "SW1")
    # Output cap
    cout1 = b.add_c("COUT1", "5V", "GND", 100e-6)
    cout2 = b.add_c("COUT2", "5V", "GND", 100e-9)
    # Feedback divider (R1=100kΩ, R2=30kΩ sets Vout=5V)
    rfb1 = b.add_r("RFB1", "5V", "FB1", 100e3)
    rfb2 = b.add_r("RFB2", "FB1", "GND", 30e3)
    # Regulator
    u1 = b.add_vreg("U1_TPS54331", "VIN_FUSED", "5V", vout_nominal=5.0, dropout=2.0)
    # Bootstrap
    cboot = b.add_c("CBOOT", "SW1", "BOOT1", 100e-9)

    # --- 5V → 3.3V TPS62086 buck-LDO ---
    cin3 = b.add_c("CIN3", "5V", "GND", 10e-6)
    l2 = b.add_l("L2", "5V", "SW2", 4.7e-6)
    d2 = b.add_diode("D2", "GND", "SW2")
    cout3 = b.add_c("COUT3", "3V3", "GND", 22e-6)
    cout4 = b.add_c("COUT4", "3V3", "GND", 100e-9)
    rfb3 = b.add_r("RFB3", "3V3", "FB2", 560e3)
    rfb4 = b.add_r("RFB4", "FB2", "GND", 330e3)
    u2 = b.add_vreg("U2_TPS62086", "5V", "3V3", vout_nominal=3.3, dropout=0.4)

    # --- Load models ---
    # MCU load on 3.3V
    r_mcu = b.add_r("R_MCU_LOAD", "3V3", "GND", 33.0)
    # Peripheral load on 5V
    r_5v_load = b.add_r("R_5V_LOAD", "5V", "GND", 50.0)

    # --- Bypass caps for good measure ---
    b.add_c("C_BYPASS_3V3", "3V3", "GND", 100e-9)
    b.add_c("C_BYPASS_5V", "5V", "GND", 100e-9)

    # --- Test points ---
    b.add_tp("TP_VIN", "VIN_FUSED")    # after fuse — isolates F1 from downstream
    b.add_tp("TP_5V", "5V")
    b.add_tp("TP_3V3", "3V3")
    b.add_tp("TP_FB1", "FB1")          # 1st feedback divider midpoint
    b.add_tp("TP_FB2", "FB2")          # 2nd feedback divider midpoint
    b.add_tp("TP_GND", "GND")
    b.add_tp("TP_SW1", "SW1")          # 1st stage switching node (between L1 and D1)
    b.add_tp("TP_BOOT1", "BOOT1")      # bootstrap cap node (between SW1 and CBOOT)
    b.add_tp("TP_SW2", "SW2")          # 2nd stage switching node (between L2 and D2)

    return b


if __name__ == "__main__":
    board = build()
    print(f"Board: {board.name}")
    print(f"Nets:  {board.nets}")
    print(f"Components: {len(board.components)}")
    print(f"Test points: {[tp.tp_name for tp in board.testpoints()]}")
