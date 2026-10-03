"""Run with: python3 tests/collectors_test.py"""
import os
import subprocess
import unittest
from importlib.machinery import SourceFileLoader
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load(name, filename):
    """Import a collector script. A collector that exits while being imported
    (e.g. when python-dbus is missing) would otherwise end this whole run
    silently with status 0, so turn that into a loud failure."""
    try:
        return SourceFileLoader(name, os.path.join(ROOT, "collectors.d", filename)).load_module()
    except SystemExit as error:
        raise RuntimeError("collectors.d/%s exited while being imported (%r)" % (filename, error.code))


airpods = load("airpods", "airpods")
solaar = load("solaar", "logitech-solaar")

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


class AirPodsMatchingTest(unittest.TestCase):
    """The advert must belong to the connected device, not to nearby AirPods."""

    # 07 19 01 <model lo> <model hi> <flip> <pods> <charging|case>, padded to 25 bytes
    PRO = "0719010e20" + "558945" + "00" * 17    # 0e 20 -> 0x200E, L 80 R 90
    OTHER = "0719011320" + "559915" + "00" * 17  # 13 20 -> 0x2013
    CONNECTED = "/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"

    def setUp(self):
        self.props = {"Address": "AA:BB:CC:DD:EE:FF", "Alias": "My AirPods Pro",
                      "Modalias": "bluetooth:v004Cp200Ed2111"}

    def objects(self, *adverts):
        result = {self.CONNECTED: {"org.bluez.Device1": self.props}}
        for i, (path, hexdata, rssi) in enumerate(adverts):
            result[path] = {"org.bluez.Device1": {
                "ManufacturerData": {airpods.APPLE: list(bytes.fromhex(hexdata))}, "RSSI": rssi}}
        return result

    def run_entries(self, objects):
        return airpods.entries_for([(self.CONNECTED, self.props)], objects, 1000)

    def test_model_helpers(self):
        self.assertEqual(airpods.modalias_product("bluetooth:v004Cp200Ed2111"), 0x200E)
        self.assertIsNone(airpods.modalias_product("usb:v046DpC547"))
        self.assertEqual(airpods.advert_model(list(bytes.fromhex(self.PRO))), 0x200E)
        self.assertEqual(airpods.adapter_of(self.CONNECTED), "/org/bluez/hci0")

    def test_matching_model_is_used(self):
        entries = self.run_entries(self.objects(("/org/bluez/hci0/dev_1", self.PRO, -70 + 10)))
        self.assertEqual([(e["name"], e["left"], e["right"]) for e in entries],
                         [("My AirPods Pro", 80, 90)])

    def test_other_model_is_ignored(self):
        # Someone else's AirPods (another model) right next to us: nothing.
        entries = self.run_entries(self.objects(("/org/bluez/hci0/dev_1", self.OTHER, -30)))
        self.assertEqual(entries, [])

    def test_strongest_matching_model_wins(self):
        weak = "0719010e20" + "552245" + "00" * 17  # same model, 20% / 20%
        entries = self.run_entries(self.objects(("/org/bluez/hci0/dev_1", weak, -64),
                                                ("/org/bluez/hci0/dev_2", self.PRO, -40),
                                                ("/org/bluez/hci0/dev_3", self.OTHER, -20)))
        self.assertEqual(entries[0]["left"], 80)

    def test_other_adapter_is_ignored(self):
        entries = self.run_entries(self.objects(("/org/bluez/hci1/dev_1", self.PRO, -40)))
        self.assertEqual(entries, [])

    def test_without_modalias_needs_a_closer_advert(self):
        del self.props["Modalias"]
        self.assertEqual(self.run_entries(self.objects(("/org/bluez/hci0/dev_1", self.OTHER, -60))), [])
        entries = self.run_entries(self.objects(("/org/bluez/hci0/dev_1", self.OTHER, -50)))
        self.assertEqual(len(entries), 1)


class AirPodsCacheTest(unittest.TestCase):
    """Scans are reused for RESCAN_AFTER seconds unless the panel is open."""

    CONNECTED = [("/org/bluez/hci0/dev_AA", {"Address": "AA"})]
    ENTRY = [{"id": "airpods:AA", "pct": 80, "ttl": airpods.TTL}]

    def setUp(self):
        import tempfile
        self.dir = tempfile.TemporaryDirectory()
        self.patch = mock.patch.object(airpods, "CACHE", os.path.join(self.dir.name, "airpods.json"))
        self.patch.start()

    def tearDown(self):
        self.patch.stop()
        self.dir.cleanup()

    def test_ttl_outlives_rescan_interval(self):
        self.assertGreaterEqual(airpods.TTL, 360)
        self.assertGreater(airpods.TTL, airpods.RESCAN_AFTER)

    def test_fresh_cache_is_reused(self):
        airpods.save_cache(self.CONNECTED, self.ENTRY, 1000)
        self.assertEqual(airpods.cached_entries(self.CONNECTED, 1000 + 299, False), self.ENTRY)

    def test_old_cache_rescans(self):
        airpods.save_cache(self.CONNECTED, self.ENTRY, 1000)
        self.assertIsNone(airpods.cached_entries(self.CONNECTED, 1000 + 300, False))

    def test_open_panel_rescans(self):
        airpods.save_cache(self.CONNECTED, self.ENTRY, 1000)
        self.assertIsNone(airpods.cached_entries(self.CONNECTED, 1001, True))

    def test_other_connected_devices_rescan(self):
        airpods.save_cache(self.CONNECTED, self.ENTRY, 1000)
        other = [("/org/bluez/hci0/dev_BB", {"Address": "BB"})]
        self.assertIsNone(airpods.cached_entries(other, 1001, False))


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
