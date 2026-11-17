"""Offline guardrails for the embedded, explicitly triggered Windows collector."""
import base64
import hashlib
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).parents[1]
HEADER = ROOT / 'firmware/include/generated_collector.h'
SOURCE = ROOT / 'collectors/windows/Collect-Inventory.ps1'
MAIN = ROOT / 'firmware/src/main.cpp'
WEB = ROOT / 'web/app.js'

class BootstrapTests(unittest.TestCase):
    def test_pinned_collector_is_the_actual_file(self):
        text = HEADER.read_text('utf-8')
        block = text.split('kCollectorBase64[] PROGMEM =', 1)[1].split(';', 1)[0]
        parts = re.findall(r'^\s*("[A-Za-z0-9+/=]+")', block, flags=re.MULTILINE)
        self.assertGreater(len(parts), 2)
        data = base64.b64decode(''.join(json.loads(part) for part in parts), validate=True)
        self.assertEqual(data, SOURCE.read_bytes())
        digest = hashlib.sha256(data).hexdigest().upper()
        self.assertIn(digest, text)

    def test_bootstrap_is_offline_and_does_not_bypass_policy(self):
        text = HEADER.read_text('utf-8')
        bootstrap = text.split('kBootstrap[] PROGMEM = R"BOOT(', 1)[1].split(')BOOT"', 1)[0]
        self.assertTrue(bootstrap.isascii())
        self.assertLess(len(bootstrap), 1200)
        for required in ('VID_303A', "'SCRIPT'", 'SHA256', 'WriteAllBytes', '@(239,187,191)', '& $f'):
            self.assertIn(required, bootstrap)
        for forbidden in ('ExecutionPolicy Bypass','DownloadString','Invoke-WebRequest','Invoke-Expression',' -EncodedCommand','-ep bypass'):
            self.assertNotIn(forbidden, bootstrap)

    def test_hid_only_runs_after_explicit_run_command(self):
        text = MAIN.read_text('utf-8')
        self.assertIn('s == "RUN|RU"', text)
        self.assertIn('s == "RUN" || s == "RUN|EN"', text)
        self.assertIn('void launchCollector()', text)
        self.assertIn('requestEnglishRequired = true;', text)
        self.assertIn('notifyText("N|ENG_REQUIRED");', text)
        self.assertNotIn('selectEnglishIfRussian', text)
        self.assertIn('launchCollector();', text)
        setup = text[text.index('void setup()') : text.index('void loop()')]
        self.assertNotIn('launchCollector();', setup)
        web = WEB.read_text('utf-8')
        self.assertIn("queueCommand('RUN|EN')", web)
        self.assertNotIn("queueCommand(fromRussian", web)
        self.assertIn("if ($('pc-layout').value !== 'en')", web)

if __name__ == '__main__':
    unittest.main()
