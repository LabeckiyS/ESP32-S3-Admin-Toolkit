#!/usr/bin/env python3
"""Checks intended ESP Web Tools installer properties (no connected device required)."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]

class InstallerTest(unittest.TestCase):
    def test_manifest_disables_unneeded_wifi_improv_probe(self):
        spec = importlib.util.spec_from_file_location("installer", ROOT / "scripts" / "build_web_installer.py")
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        manifest = mod.make_manifest()
        self.assertEqual(manifest["new_install_improv_wait_time"], 0)
        self.assertEqual(manifest["builds"][0]["chipFamily"], "ESP32-S3")
        self.assertEqual(manifest["builds"][0]["parts"][0]["offset"], 0)

    def test_installer_has_local_no_reset_loader_and_port_inspection(self):
        install = (ROOT / "web" / "install.html").read_text(encoding="utf-8")
        self.assertIn("./vendor/esp-web-tools-no-reset/install-button.js", install)
        self.assertIn("./usb-check.js", install)
        inspector = (ROOT / "web" / "usb-check.js").read_text(encoding="utf-8")
        self.assertIn("navigator.serial.requestPort()", inspector)
        self.assertNotIn("port.open(", inspector)

if __name__ == "__main__":
    unittest.main()
