"""Run with: python3 tests/collectors_test.py"""
import os
import subprocess
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
airpods = SourceFileLoader("airpods", os.path.join(ROOT, "collectors.d", "airpods")).load_module()
solaar = SourceFileLoader("solaar", os.path.join(ROOT, "collectors.d", "logitech-solaar")).load_module()

SOLAAR_SHOW = """solaar version 1.1.20

G502 X PLUS
     USB id       : 046d:C095
     Codename     : G502 X PLUS
     Kind         : mouse
            Kind: None
            Battery: 44%, BatteryStatus.RECHARGING.
     Battery: 44%, BatteryStatus.RECHARGING.

Lightspeed Headset Receiver
  USB id       : 046d:0B18
     USB id       : 046d:0B18
     Codename     : G522 LIGHTSPEED - Wireless Mode
     Kind         : headset
            Kind: None
            Battery: 59%, BatteryStatus.DISCHARGING.
     Battery: 59%, BatteryStatus.DISCHARGING.
"""


class AirPodsTest(unittest.TestCase):
    def decode(self, hexdata):
        return airpods.decode(list(bytes.fromhex(hexdata + "00" * 15)))

    def test_levels_and_case_charging(self):
        r = self.decode("07190114205589450000")
        self.assertEqual((r["left"], r["right"], r["case"]), (80, 90, 50))
        self.assertTrue(r["caseCharging"])

    def test_flip_swaps_pods(self):
        r = self.decode("07190114207589150000")
        self.assertEqual((r["left"], r["right"]), (90, 80))

    def test_unavailable_pod(self):
        self.assertEqual(self.decode("071901142055f8f50000")["left"], -1)

    def test_rejects_other_adverts(self):
        self.assertIsNone(airpods.decode([0x10, 0x05, 0x01]))


class SolaarTest(unittest.TestCase):
    def test_parses_devices(self):
        result = subprocess.CompletedProcess([], 0, stdout=SOLAAR_SHOW)
        with mock.patch.object(solaar.shutil, "which", return_value="/usr/bin/solaar"), \
                mock.patch.object(solaar.subprocess, "run", return_value=result):
            entries = solaar.main()
        self.assertEqual([(e["name"], e["kind"], e["pct"], e["charging"]) for e in entries], [
            ("Logitech G502 X PLUS", "mouse", 44, True),
            ("Logitech G522 LIGHTSPEED", "headset", 59, False),
        ])


if __name__ == "__main__":
    unittest.main()
