"""Offline, fail-closed check of the public KiCad inputs used by planner CI.

Run before importing planner modules (they cache library paths at import time).
--manifest prints the immutable download manifest; this script never downloads,
installs libraries, creates geometry, accesses run artifacts, or skips tests.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys


# 10.0.1 tags resolved with git ls-remote, then named raw files independently
# retrieved at these commits and SHA256-checked against the installed Mac copy.
RELEASE = "10.0.1"
REPOSITORIES = {
    "symbols": {
        "url": "https://gitlab.com/kicad/libraries/kicad-symbols",
        "commit": "7058584a0fbe9aa2f1c9ff2acf7847726ff6922c",
        "env": "FL_KICAD_SYMBOLS",
    },
    "footprints": {
        "url": "https://gitlab.com/kicad/libraries/kicad-footprints",
        "commit": "3d2b27e687a44c97f02109afb2acfeebbc8dd75f",
        "env": "FL_KICAD_FOOTPRINTS",
    },
}

# All seed symbol queries run even for a single requested part. Explicit legacy
# calls additionally exercise inheritance, BGA pins and multi-rail components.
# Each tuple is (exact symbol name, inherited pin count).
SYMBOLS = {
    "74xx": [("74HC595", 16)],
    "Analog_ADC": [("ADS1115IDGS", 10)],
    "Analog_DAC": [("MCP4725xxx-xCH", 6)],
    "Battery_Management": [("MCP73831-2-MC", 8)],
    "Connector": [("USB_C_Receptacle_USB2.0_14P", 15)],
    "Driver_Motor": [("DRV8833PW", 16)],
    "FPGA_Lattice": [("ICE40HX4K-BG121", 121)],
    "Interface_Expansion": [("PCF8574T", 16), ("MCP23017x-x-ML", 29)],
    "Interface_UART": [("MAX3485", 8)],
    "LED": [("WS2812B", 4)],
    "Logic_LevelTranslator": [("TXB0102DCU", 8)],
    "MCU_RaspberryPi": [("RP2040", 57)],
    "Memory_EEPROM": [("24LC02", 8), ("24AA02-OT", 5)],
    "Memory_Flash": [("W25Q128JVE", 9)],
    "Reference_Voltage": [("REF3025", 3)],
    "Regulator_Linear": [("AP2112K-1.2", 5)],
    "Regulator_Switching": [("TPS62162DSG", 9)],
    "Sensor": [("BME280", 8)],
    "Sensor_Energy": [("INA219AxD", 8)],
    "Sensor_Motion": [("LIS3DH", 16)],
    "Timer_RTC": [("DS3231M", 16)],
    "Transistor_Array": [("ULN2803A", 18)],
}

# Real upstream files, not generated stand-ins. Includes the intentionally
# mismatched SOT-23 / SOIC-16 inputs used by negative ingestion tests.
FOOTPRINTS = (
    "Capacitor_SMD:C_0402_1005Metric",
    "Connector_JST:JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal",
    "Connector_PinHeader_2.54mm:PinHeader_1x04_P2.54mm_Vertical",
    "Connector_PinHeader_2.54mm:PinHeader_1x08_P2.54mm_Vertical",
    "Connector_PinHeader_2.54mm:PinHeader_2x03_P2.54mm_Vertical",
    "Connector_PinHeader_2.54mm:PinHeader_2x05_P2.54mm_Vertical",
    "Connector_USB:USB_C_Receptacle_GCT_USB4110",
    "Fiducial:Fiducial_1mm_Mask2mm",
    "LED_SMD:LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm",
    "Module:RaspberryPi_Pico_SMD_HandSolder",
    "MountingHole:MountingHole_3.2mm_M3",
    "Package_BGA:BGA-121_9.0x9.0mm_Layout11x11_P0.8mm_Ball0.4mm_Pad0.35mm_NSMD",
    "Package_DFN_QFN:DFN-8-1EP_3x2mm_P0.5mm_EP1.7x1.4mm",
    "Package_DFN_QFN:QFN-28-1EP_6x6mm_P0.65mm_EP4.8x4.8mm",
    "Package_DFN_QFN:QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm",
    "Package_LGA:Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering",
    "Package_LGA:LGA-16_3x3mm_P0.5mm_LayoutBorder3x5y",
    "Package_QFP:LQFP-48_7x7mm_P0.5mm",
    "Package_SO:HTSSOP-16-1EP_4.4x5mm_P0.65mm_EP3.4x5mm",
    "Package_SO:SOIC-8_3.9x4.9mm_P1.27mm",
    "Package_SO:SOIC-16_3.9x9.9mm_P1.27mm",
    "Package_SO:SOIC-16W_7.5x10.3mm_P1.27mm",
    "Package_SO:SOIC-18W_7.5x11.6mm_P1.27mm",
    "Package_SO:TSSOP-10_3x3mm_P0.5mm",
    "Package_SO:TSSOP-16_4.4x5mm_P0.65mm",
    "Package_SO:VSSOP-8_2.3x2mm_P0.5mm",
    "Package_SON:WSON-8-1EP_2x2mm_P0.5mm_EP0.9x1.6mm",
    "Package_SON:WSON-8-1EP_8x6mm_P1.27mm_EP3.4x4.3mm",
    "Package_TO_SOT_SMD:SOT-23",
    "Package_TO_SOT_SMD:SOT-23-5",
    "Package_TO_SOT_SMD:SOT-23-6",
    "Package_TO_SOT_SMD:SOT-23-8",
    "Resistor_SMD:R_0402_1005Metric",
    "TerminalBlock:TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm",
    "TestPoint:TestPoint_Pad_1.5x1.5mm",
)

# SHA256 of bytes retrieved from immutable raw URLs. Symbol libraries in the
# upstream 10.x tree are unpacked; the official packer preserves symbol blocks.
# Each symbol record is (source-file SHA256, packed-block SHA256).
SHA256 = {
    "footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_2x05_P2.54mm_Vertical.kicad_mod": "e92fcd01a2df9c567dbd6e2c8c05c4e021cb1b96ca035b85d568d1710f9d48b1",
    "footprints/Capacitor_SMD.pretty/C_0402_1005Metric.kicad_mod": "0403382fc4583ed510b461b1fa4a36dfaec6f4c0d9b1a67e6b0027837a54e1b5",
    "footprints/Connector_JST.pretty/JST_PH_S2B-PH-K_1x02_P2.00mm_Horizontal.kicad_mod": "296506c379958ec5f3f455ae66c169b9e0b5e3482713b4aa4366b677dea398e7",
    "footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x04_P2.54mm_Vertical.kicad_mod": "571d2d16b49795f8f9a91f96cc83fd2adf49890cd66c377189c44204ebd03c29",
    "footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_1x08_P2.54mm_Vertical.kicad_mod": "a3487a12dc87702385d7c9d219d8e1dff23f5bd4d263be9d8ce0507ebf77b0df",
    "footprints/Connector_PinHeader_2.54mm.pretty/PinHeader_2x03_P2.54mm_Vertical.kicad_mod": "8bb8f0a71c1009c3d1e966e2c66c65cf301d26696ac9603fc7cbbfe58a27153e",
    "footprints/Connector_USB.pretty/USB_C_Receptacle_GCT_USB4110.kicad_mod": "ef9bb2acbd4b01c8a998c19176bb7a00238ca32f67b5d43e3ffb198c3a792637",
    "footprints/Fiducial.pretty/Fiducial_1mm_Mask2mm.kicad_mod": "ef0adfb15b51d4657524802277f1f3703f6d1d0f06998df4ee7dda8179dd48bd",
    "footprints/LED_SMD.pretty/LED_WS2812B_PLCC4_5.0x5.0mm_P3.2mm.kicad_mod": "157bb05e692b8bf0fa4da063b97264ec9faca5677dd989248b0aae9077996085",
    "footprints/Module.pretty/RaspberryPi_Pico_SMD_HandSolder.kicad_mod": "0303c5fb4497cc7d03cdcf03b921f646497192adc1d53291d3ec9ef9d2c15746",
    "footprints/MountingHole.pretty/MountingHole_3.2mm_M3.kicad_mod": "b83ec84428449465df3b459f1bc24b285045c812102a2052b1b7ce0f67e018f2",
    "footprints/Package_BGA.pretty/BGA-121_9.0x9.0mm_Layout11x11_P0.8mm_Ball0.4mm_Pad0.35mm_NSMD.kicad_mod": "e0386344108940e44a8fe89b61734983b90ec84fe13da57a8db70c07a45b7dfb",
    "footprints/Package_DFN_QFN.pretty/DFN-8-1EP_3x2mm_P0.5mm_EP1.7x1.4mm.kicad_mod": "3458dbb71a7050ad339f66dcefe4501f993374ef1e8e2a69d424f11a8fdf0af4",
    "footprints/Package_DFN_QFN.pretty/QFN-28-1EP_6x6mm_P0.65mm_EP4.8x4.8mm.kicad_mod": "6ee3cfbd78c1147a857ca43c8b7e7b6716cc94682406f70856ac737a5f0f29fb",
    "footprints/Package_DFN_QFN.pretty/QFN-56-1EP_7x7mm_P0.4mm_EP3.2x3.2mm.kicad_mod": "2e70e6fb9394393594c10b827ee21a4b42ca52860a3bc8e079c4b8e24a75ccce",
    "footprints/Package_LGA.pretty/Bosch_LGA-8_2.5x2.5mm_P0.65mm_ClockwisePinNumbering.kicad_mod": "14464b7a437e7efb0fa9947b89a7d3825242f3ed82d649fe2ca45fad5d3dda86",
    "footprints/Package_LGA.pretty/LGA-16_3x3mm_P0.5mm_LayoutBorder3x5y.kicad_mod": "cb4dc919966fb8537d7087439ccf755f46692c6c6eecf2de8b178cce94342ec7",
    "footprints/Package_QFP.pretty/LQFP-48_7x7mm_P0.5mm.kicad_mod": "1ccc5ad4d95398a4c6eb4b4cd1c429865368d06b8373613c6fcb332b53106ee0",
    "footprints/Package_SO.pretty/HTSSOP-16-1EP_4.4x5mm_P0.65mm_EP3.4x5mm.kicad_mod": "ddac518a7e3248d46a65ef7ecdcfe542958195e812ce3ba8d036f574ae04b87b",
    "footprints/Package_SO.pretty/SOIC-16W_7.5x10.3mm_P1.27mm.kicad_mod": "07aa02ced9fcdc61d7c6bb5ea1b86803731041e9e171db91a991c3daa7817383",
    "footprints/Package_SO.pretty/SOIC-16_3.9x9.9mm_P1.27mm.kicad_mod": "f9b5075740f7816c540ae1137f025d659beaec522ed7b86b1a5274cc9a2d8a25",
    "footprints/Package_SO.pretty/SOIC-18W_7.5x11.6mm_P1.27mm.kicad_mod": "7eec490ec4feabbe30fa197f0f395da5eeabbd36efadacce0a3f05290c8be447",
    "footprints/Package_SO.pretty/SOIC-8_3.9x4.9mm_P1.27mm.kicad_mod": "074ecb2092b24fa4b4b9cdd7c926fc587b0d7d6d21e7341e57935fd42d36894f",
    "footprints/Package_SO.pretty/TSSOP-10_3x3mm_P0.5mm.kicad_mod": "2086038e5c7206b71f55b2b549ebc926ab2462fa36b107db5287ae1d38a0da96",
    "footprints/Package_SO.pretty/TSSOP-16_4.4x5mm_P0.65mm.kicad_mod": "fbac79fc5f310754726589d67071a422c429216f843ecd6013bbe2e6a49e7064",
    "footprints/Package_SO.pretty/VSSOP-8_2.3x2mm_P0.5mm.kicad_mod": "dca72da69de3263affb64fd1abd218db3cf30ff727c784b3f02c8c588a2875a8",
    "footprints/Package_SON.pretty/WSON-8-1EP_2x2mm_P0.5mm_EP0.9x1.6mm.kicad_mod": "09103a32792d7f693f480a8a9a8bdde5a1ed700022385d9dc8bb03492316d0f9",
    "footprints/Package_SON.pretty/WSON-8-1EP_8x6mm_P1.27mm_EP3.4x4.3mm.kicad_mod": "e2f247a30fb0641050d1e5bf0563b48484511721768db90c8491c09c544ba755",
    "footprints/Package_TO_SOT_SMD.pretty/SOT-23-5.kicad_mod": "455a3f7c3e5eb5b8847eaa5df23e18651e78ab9f75afd09a0883758a0d901761",
    "footprints/Package_TO_SOT_SMD.pretty/SOT-23-6.kicad_mod": "f341c73aac9dcb553456f68bf3fee3d26eb14acf6d8a1cae82b50418fe1d71ca",
    "footprints/Package_TO_SOT_SMD.pretty/SOT-23-8.kicad_mod": "275a1c87693f80538dec9617ad6864fd57e5ecdf6663719b8ebf435759d5ac7b",
    "footprints/Package_TO_SOT_SMD.pretty/SOT-23.kicad_mod": "0d88c86c1b6d8c1aae4aa8c09386264c089d4451a128b6ccd63ed253f4300b15",
    "footprints/Resistor_SMD.pretty/R_0402_1005Metric.kicad_mod": "e05c7605248c220836f642ed1f526133edf0374acdfd5bb2631e58b4e377acfb",
    "footprints/TerminalBlock.pretty/TerminalBlock_MaiXu_MX126-5.0-02P_1x02_P5.00mm.kicad_mod": "2d23d7c92fe098ad4e511f5eefdd34dc0d4ced8cad15fcea606fbee42512c4cf",
    "footprints/TestPoint.pretty/TestPoint_Pad_1.5x1.5mm.kicad_mod": "3bc6d5e42ac6570be508f2534022843f8bf6e4a94c2c0e3f784ba2aef27fcb90"
}
SYMBOL_HASHES = {
    "74xx:74HC595": [
        "20f4937a51a34b399bb9a8a676db952d4ca55817331548a2544ef039019df775",
        "b1994caa38a9f7aa97b78cc76afb3a97ae5e5b0cf31f20bc50542f1ac27b707f"
    ],
    "Analog_ADC:ADS1015IDGS": [
        "b748e6049d0efbee38826adae4e7e3981886932edc6177b3e78887c90231ab96",
        "b02403ac63363f1ed6010f38a19183c726087059bf336d80f0fbb20657b5802a"
    ],
    "Analog_ADC:ADS1115IDGS": [
        "d3dc0236d84f8666ba143015b352705dd798816e91b51af13171fc87a49553e1",
        "3cdf0047db5c5d9d15eb549022127e4a670c3f5ba97fadcb0fdaa202b3fd9bf6"
    ],
    "Analog_DAC:MCP4725xxx-xCH": [
        "19c0d52041a9f24c507b4fd90f8bc89a6d92d0a5a90bd2ddf993ff568f97a5c0",
        "cbfa4ec039e4df9c9f9e59ccf132eed41ac49f022ac7259057e39c630cb05d41"
    ],
    "Battery_Management:MCP73831-2-MC": [
        "0e30220f0cb3965a0817b88a0a3b7f692f85bbe06f42f9561969a7b65749194a",
        "b8f5022b919dea9b09fd4a1ae9e0fa17362b59cbbf61b5de36c5806e599ccd6f"
    ],
    "Connector:USB_C_Receptacle_USB2.0_14P": [
        "04b7a737b110f1f2a8a664ba6cb1dc582a045ccb5fb1aef4ab87cc9394ec8d27",
        "0499dbe59071487eb7f657d44400cc8f6ced50f1d662f58473c871dfc72e9ae8"
    ],
    "Driver_Motor:DRV8833PW": [
        "536e2474bb17cbba0b53b2995626b32a4452ed802ad471a9353c5ad524baffc6",
        "c1c2614c567c4ea48b6825d5bf4e36027375aa9845ad3fbcb29b7f95d339df14"
    ],
    "FPGA_Lattice:ICE40HX4K-BG121": [
        "00d4234fdf2dd37478a4b866fa9bc3fd6036a91b2e3f7252bf791c5912df8686",
        "3492bed617f0e26caa367fc993b572c8927b0ab7deebc7d63399a8bf631e4fdd"
    ],
    "FPGA_Lattice:ICE40HX8K-BG121": [
        "72ad6a916aaca32c579107d9a8e9cbda112be9b8bdc33b4403fea568f95726f2",
        "ae2a0580bfe90a3ebbd41b3ae94d5f7d5874f1fa69c51197ee7775072f1e6e80"
    ],
    "Interface_Expansion:MCP23017x-x-ML": [
        "288239cdd8a868398c87359c70ae8caf9a94313f072567e3e001fd46e32222eb",
        "2a7030ed415ce8c1139844a2d4aeeee676d82fa515db11a381e63ed4ad039b65"
    ],
    "Interface_Expansion:PCF8574T": [
        "e826b378b311a0101f0a642ae411fa63386fd5d01e405356fcafd7bede70cfe1",
        "e362b451d7c7a36b226e77fd2b3d4000d07a6fa18f496f8ebbc597651e670553"
    ],
    "Interface_Expansion:TCA9534": [
        "78e9945c200f6203a538588bc64a6c944256151bfb0c1abaa6b6a6268eb7102c",
        "d15083a568125e74d327b3e64a9ff13e7238e765b078dc05218d1bc06ee71d7d"
    ],
    "Interface_UART:LTC2850xS8": [
        "d3eb1cb0e556e81028e4be16a7d0db09732753f611475329d1f761e4a257d176",
        "073a7e224950b1deb24a4e7072b0630c9c3fb724b9ed1bf79a32cf83b8143022"
    ],
    "Interface_UART:MAX3485": [
        "fe32cccaa2c2a826b537d8bba3ff5eed01effe7dcfeff4aeff5ac50c8aebc40f",
        "40dce0da65202bc0147529b348d5539bc3bf743343fd93bf112ba045a079aa90"
    ],
    "LED:WS2812B": [
        "673826a8a1203cb9c0fe5ab7ebde84ab135d26e352553805c6680d89dd828ba7",
        "18e0271aad19655ae2d754449bf2bc29f1d4b151417c461120db299ffed4e15a"
    ],
    "Logic_LevelTranslator:TXB0102DCU": [
        "1a7338e75ffc3afc01874cb9a3fdcdb120780042db4f7b1ca06ca59ab06a2911",
        "97aed5f13d27d3c15d89264ddb1068156beb455a77adf5dd69d9b30014becaae"
    ],
    "MCU_RaspberryPi:RP2040": [
        "d2a498bceee0e62cc48021861f628d7c7ed5099354bdc261241395be1665eb99",
        "1d99d3e6a7140af3987de83513b4303e8f8777964efaa7dca904fcc56aa468a8"
    ],
    "Memory_EEPROM:24AA02-OT": [
        "989f59bd1e6c6121fbd91d2a775bde2d8a6e47fc99f0dc7f2755b2d68b08e9e4",
        "a321eec32938fc7dc5403906c48e5878a1c9d3103901f877e4fe972aefac6a1a"
    ],
    "Memory_EEPROM:24LC02": [
        "350c27d2d28eb86e6aa04827a80186474d8389e87383a4452b021579d184501b",
        "1fad4260d2c12332dec658e25d9548986f5ee9e295f7cc2d84e7425369efbcd2"
    ],
    "Memory_EEPROM:24LC16": [
        "c6b7336ea8fd0300eb1ad6bd6b2d1d076a4ccec110ea76d584f2a7fe673d771f",
        "d7986e968f34ac3f2d1648ead29a2f74e6e55516de67a35614ac1e06768e7b66"
    ],
    "Memory_Flash:W25Q128JVE": [
        "9d696fb7a5e1f49d6855d2b5c325de99495440ab7da3e65fc1adf856cf63e2e8",
        "83bdd1547c3dd480fc0bb1c345d58df284bad06d992e8b9b5cc367baa5de0c18"
    ],
    "Memory_Flash:W25Q32JVZP": [
        "6cde49dcf6fc97e9b4ccdce2c743cfce04dc92c7d451f43de4e834a953c5f08e",
        "26510ce19a72125ee02b1aa02ff9be21687d2862d19ca44f19dc913d20bf05dd"
    ],
    "Reference_Voltage:REF3012": [
        "4bddf27cc507c2942634629a13d60f682e7b938e5491bba9d1df716a098d1a98",
        "664a58a4312a6148452d14e32438eb844ff7662c4fc7b4c53f4c6e11956198fc"
    ],
    "Reference_Voltage:REF3025": [
        "0804cfbbec77c4848eb686940f9798915fc76eabb4922b2f4af42c5f928c2181",
        "991fbc543e9f6026aa8d090c266f805a67aec6822acaccf7cf57cfd42a28470e"
    ],
    "Regulator_Linear:AP2112K-1.2": [
        "6b33bae7740ebe5877f81d855bf9e9dfda745205f878691b0cb7f51f507a1c17",
        "51d51a9e2bce5beeca22797260d9c30346a488dfee4033b0fbad5b27f1608e16"
    ],
    "Regulator_Linear:AP2204K-1.5": [
        "9e4c795d67c38eacb6fe89110d6b9eaa698b8040ff5f37b537e268978eb0616c",
        "4f95889505f237673c62e5b801f6885aadc44774eebc7b891b0bf0ffe8d2123c"
    ],
    "Regulator_Switching:TPS62162DSG": [
        "5a67f3d3390959e7788450ab31f03cc02b0b6f044d01c61cdd4798b2a34ef2b8",
        "3b738b8a9ce2aecdc560530d7172bf827c737a2575cb9fa5cf68d316a9e73400"
    ],
    "Regulator_Switching:TPS62170DSG": [
        "3b7fa625cc249a05940b8f4ce83535ae4d48845bce75386e34dd36e8e43c7076",
        "dff27f8b19a4bb6a7119c46f87dca60a4ad3e19ed868da7d2d60e690f21683f2"
    ],
    "Sensor:BME280": [
        "d194dfcae6dc11d852b349df938c2b95f08ef803bababdf2792ee2bec11cb55a",
        "d79f6ed721940469574538224f106de1b9fcd7b1143d0ba2b0fada2aee1a9378"
    ],
    "Sensor_Energy:INA219AxD": [
        "55a21a4fd9730c62d50e405d75f401519104265c4413144968fffa4494a95615",
        "c9e7895c87ee3c05784e52ab2e3c18a0b1f60b3ffe0920a8b330c142280486a5"
    ],
    "Sensor_Motion:LIS3DH": [
        "f21689b667190de4fabdc63f45b3bcd248b2fab2e2e879349c1cd5261e31a3b7",
        "d53f5649c919bb6da1c447f4c77f45e3cb2e5c9e18155eb03f8d4db78a2a45ae"
    ],
    "Timer_RTC:DS3231M": [
        "d6785f2048442a5c6e20e4e58dfa06ea9b35f21af2584b4bbe03e9d02c7a90a1",
        "849edeacc4d28b72da2ec3b9f395efa8f4e69a3c2fca0c5b3e89fb0a6ec12cd8"
    ],
    "Transistor_Array:ULN2803A": [
        "12716543857f47b4d8175ef15322e3d6ee1bf479c43620c0a8d5693394e2417b",
        "54326fd8bcbb415108bdd1c3d325a34b77533d18081a5cd50e46d6d4a54a0d32"
    ]
}


def required_paths():
    return {
        "symbols": sorted(lib + ".kicad_sym" for lib in SYMBOLS),
        "footprints": sorted(
            lib + ".pretty/" + name + ".kicad_mod"
            for lib, name in (fp.split(":", 1) for fp in FOOTPRINTS)
        ),
    }


def manifest():
    files = {
        "footprints": [{"path": path, "sha256": SHA256["footprints/" + path]}
                       for path in required_paths()["footprints"]],
        "symbols": [
            {"path": lib + ".kicad_symdir/" + name + ".kicad_sym",
             "sha256": hashes[0], "packed_path": lib + ".kicad_sym",
             "symbol": name, "block_sha256": hashes[1]}
            for key, hashes in sorted(SYMBOL_HASHES.items())
            for lib, name in [key.split(":", 1)]
        ],
    }
    return {
        "schema_version": 1,
        "release": RELEASE,
        "scope": "bounded planner library preflight, not the complete legacy suite or saved run artifacts",
        "symbol_packing": "python3 tools/kicad_lib_pack.py --input . --output packed",
        "libraries": {kind: {**repo, "files": files[kind]}
                      for kind, repo in REPOSITORIES.items()},
    }


def preflight():
    """Return all dependency problems; never turn a missing dependency into a skip."""
    errors = []
    roots = {}
    for kind, paths in required_paths().items():
        variable = REPOSITORIES[kind]["env"]
        value = os.environ.get(variable)
        if not value:
            errors.append("%s must explicitly name the pinned %s directory" % (variable, kind))
            continue
        root = Path(value)
        if not root.is_absolute() or not root.is_dir():
            errors.append("%s is not an existing absolute directory: %s" % (variable, value))
            continue
        roots[kind] = root
        for relative in paths:
            path = root / relative
            try:
                data = path.read_bytes()
            except OSError as exc:
                errors.append("%s: %s" % (path, exc))
                continue
            if kind == "footprints":
                expected = SHA256.get(kind + "/" + relative)
                actual = hashlib.sha256(data).hexdigest()
                if not expected or actual != expected:
                    errors.append("%s: SHA256 mismatch (expected %s, got %s)" % (path, expected, actual))
                    continue
                text = data.decode("utf-8")
                if not text.lstrip().startswith("(footprint ") or not re.search(r'\(pad\s+"[^"]*"\s', text):
                    errors.append("%s: no real footprint/pads" % path)
    if errors:
        return errors

    # Exercise the same inheritance-aware parser that the legacy tests use.
    # Import only after validating the environment and exact upstream bytes.
    import chipdown_synthesis
    if Path(chipdown_synthesis.SYM_SHARE).resolve() != roots["symbols"].resolve():
        return ["symbol parser cached a different FL_KICAD_SYMBOLS; run preflight in a fresh process"]
    texts = {}
    for key, (_, expected) in SYMBOL_HASHES.items():
        lib, name = key.split(":", 1)
        path = roots["symbols"] / (lib + ".kicad_sym")
        try:
            if lib not in texts:
                texts[lib] = path.read_text(encoding="utf-8")
            block = chipdown_synthesis._extract_block(texts[lib], name)
            actual = hashlib.sha256(block.encode("utf-8")).hexdigest() if block else None
            if actual != expected:
                errors.append("%s:%s: symbol block SHA256 mismatch (expected %s, got %s)" % (
                    path, name, expected, actual))
        except (OSError, UnicodeError, IndexError) as exc:
            errors.append("%s:%s could not read symbol block: %s" % (path, name, exc))
    if errors:
        return errors
    for lib, requirements in SYMBOLS.items():
        for name, count in requirements:
            try:
                pins, reason = chipdown_synthesis.parse_symbol(lib, name)
                if not pins or len(pins) != count:
                    errors.append("%s:%s expected %d pins, got %s (%s)" % (
                        lib, name, count, len(pins) if pins else 0, reason))
            except (OSError, ValueError, IndexError) as exc:
                errors.append("%s:%s could not parse: %s" % (lib, name, exc))
    return errors


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", action="store_true", help="print pinned JSON download manifest, without checking the host")
    args = parser.parse_args(argv)
    if args.manifest:
        print(json.dumps(manifest(), indent=2, sort_keys=True))
        return 0
    errors = preflight()
    if errors:
        print("Planner KiCad preflight FAILED:", file=sys.stderr)
        for error in errors:
            print("  " + error, file=sys.stderr)
        return 1
    paths = required_paths()
    print("Planner KiCad preflight OK: %d symbol libraries, %d footprints; pinned %s bytes and symbol pins verified" % (
        len(paths["symbols"]), len(paths["footprints"]), RELEASE))
    return 0


if __name__ == "__main__":
    sys.exit(main())
