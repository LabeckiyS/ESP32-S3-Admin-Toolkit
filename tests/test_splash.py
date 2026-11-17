"""Ensure the boot splash is an exact static bitmap with the v11.1 4s hold."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HEADER = ROOT / "firmware/include/cyber_star_v8_splash.h"
FIRMWARE = ROOT / "firmware/src/main.cpp"

class SplashTests(unittest.TestCase):
    def test_original_bitmap_dimensions_and_pixel_count(self):
        image = HEADER.read_text(encoding="utf-8")
        self.assertIn("CYBER_STAR_SPLASH_WIDTH = 80", image)
        self.assertIn("CYBER_STAR_SPLASH_HEIGHT = 160", image)
        self.assertIn("cyberStarSplash[80 * 160] PROGMEM", image)
        self.assertEqual(len(re.findall(r"0x[0-9A-Fa-f]{4}", image)), 12800)

    def test_original_rendering_and_display_hold(self):
        source = FIRMWARE.read_text(encoding="utf-8")
        self.assertIn('#include "cyber_star_v8_splash.h"', source)
        splash = source[source.index("void drawBootSplash() {"):source.index("// Only repaint a status line")]
        self.assertIn("display.drawRGBBitmap(0, 0, cyberStarSplash", splash)
        setup = source[source.index("void setup() {"):source.index("void loop() {")]
        self.assertRegex(setup, r"drawBootSplash\(\);\s*delay\(4000\);")
        self.assertNotIn("delay(1200)", setup)

if __name__ == "__main__":
    unittest.main()
