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
    @classmethod
    def setUpClass(cls):
        # Simulate PlatformIO's prebuild hook; this tests the exact embedded
        # snapshot that firmware compilation will use, not a stale checked-in header.
        class FakeEnv:
            def subst(self, key):
                if key != '$PROJECT_DIR':
                    raise ValueError(key)
                return str(ROOT / 'firmware')
        script = ROOT / 'firmware/extra_scripts/embed_collector.py'
        scope = {'Import': lambda name: None, 'env': FakeEnv(), '__file__': str(script)}
        exec(compile(script.read_text('utf-8'), str(script), 'exec'), scope)


    def test_pinned_collector_is_the_actual_file(self):
        text = HEADER.read_text('utf-8')
        block = text.split('kCollectorBase64[] PROGMEM =', 1)[1].split(';', 1)[0]
        parts = re.findall(r'^\s*("[A-Za-z0-9+/=]+")', block, flags=re.MULTILINE)
        self.assertGreater(len(parts), 2)
        data = base64.b64decode(''.join(json.loads(part) for part in parts), validate=True)
        self.assertEqual(data, SOURCE.read_bytes())
        self.assertIn("[ValidateSet('Fast','Full')]", SOURCE.read_text('utf-8'))
        self.assertIn('Get-HardwareDetails', SOURCE.read_text('utf-8'))
        self.assertNotIn('Get-HardwareInventory', SOURCE.read_text('utf-8'))
        digest = hashlib.sha256(data).hexdigest().upper()
        self.assertIn(digest, text)

    def test_bootstrap_is_offline_and_does_not_bypass_policy(self):
        text = HEADER.read_text('utf-8')
        bootstrap = text.split('kBootstrapFast[] PROGMEM = R"BOOT(', 1)[1].split(')BOOT"', 1)[0]
        self.assertTrue(bootstrap.isascii())
        self.assertLess(len(bootstrap), 1200)
        for required in ('VID_303A', "'SCRIPT'", 'SHA256', 'WriteAllBytes', '@(239,187,191)', '& $f'):
            self.assertIn(required, bootstrap)
        for forbidden in ('ExecutionPolicy Bypass','DownloadString','Invoke-WebRequest','Invoke-Expression',' -EncodedCommand','-ep bypass'):
            self.assertNotIn(forbidden, bootstrap)

    def test_usb_report_reuses_original_open_cdc_port(self):
        collector = SOURCE.read_text('utf-8')
        generator = (ROOT / 'firmware/extra_scripts/embed_collector.py').read_text('utf-8')
        embedded = HEADER.read_text('utf-8')
        self.assertIn('[System.IO.Ports.SerialPort]$OpenSerial', collector)
        self.assertIn('$ownsPort = ($null -eq $ExistingSerial)', collector)
        self.assertIn('if ($ownsPort) {', collector)
        self.assertIn('-ExistingSerial $OpenSerial', collector)
        self.assertIn('-OpenSerial $s', generator)
        self.assertIn('-OpenSerial $s', embedded)
        self.assertIn('}finally{$s.Dispose()}', embedded)

    def test_cdc_close_cannot_trigger_bootloader(self):
        source = MAIN.read_text('utf-8')
        setup = source[source.index('void setup() {'):source.index('void loop() {')]
        self.assertIn('Serial.enableReboot(false);', setup)
        self.assertLess(setup.index('Serial.enableReboot(false);'), setup.index('USB.begin();'))
        self.assertNotIn('Serial.enableReboot(true)', source)

    def test_ble_advertising_recovers_after_disconnect(self):
        source = MAIN.read_text('utf-8')
        self.assertIn('void pollAdvertisingRecovery()', source)
        self.assertIn('bleDisconnectedAtMs = millis();', source)
        for wait in ('500UL', '3000UL', '10000UL'):
            self.assertIn(wait, source)
        self.assertIn('pollAdvertisingRecovery();', source)

    def test_collector_audits_local_access_without_secrets_or_reports_on_disk(self):
        source = SOURCE.read_text('utf-8')
        for expected in ('Get-LocalUser', 'Get-LocalGroupMember -SID', 'S-1-5-32-544',
                         'S-1-5-32-545', 'PasswordRequired', 'PasswordLastSet',
                         'MacAddress', 'Get-PnpDevice -PresentOnly', 'Get-HotFix',
                         'Get-BitLockerVolume', 'Get-Tpm', 'Confirm-SecureBootUEFI'):
            self.assertIn(expected, source)
        self.assertNotIn('WriteAllText($txtPath', source)
        self.assertNotIn('WriteAllBytes($jsonPath', source)
        self.assertNotIn('Get-WmiObject Win32_Product', source)

    def test_hid_only_runs_after_explicit_run_command(self):
        text = MAIN.read_text('utf-8')
        self.assertIn('s == "RUN|RU"', text)
        self.assertIn('s == "RUN" || s == "RUN|EN" || s == "RUN|EN|FAST"', text)
        self.assertIn('void launchCollector(bool full)', text)
        self.assertIn('requestEnglishRequired = true;', text)
        self.assertIn('notifyText("N|ENG_REQUIRED");', text)
        self.assertNotIn('selectEnglishIfRussian', text)
        self.assertIn('launchCollector(full);', text)
        self.assertNotIn('RUN|EN|HARDWARE', text)
        self.assertNotIn('kBootstrapHardware', text)
        setup = text[text.index('void setup()') : text.index('void loop()')]
        self.assertNotIn('launchCollector(full);', setup)
        web = WEB.read_text('utf-8')
        self.assertIn("queueCommand('RUN|EN|' + mode)", web)
        self.assertNotIn("queueCommand(fromRussian", web)
        self.assertIn("if ($('pc-layout').value !== 'en')", web)

    def test_temporary_policy_does_not_change_persistent_scopes(self):
        text = HEADER.read_text('utf-8')
        for mode in ('Fast', 'Full'):
            bootstrap = text.split('kBootstrap%s[] PROGMEM = R"BOOT(' % mode, 1)[1].split(')BOOT"', 1)[0]
            self.assertIn("Get-ExecutionPolicy -Scope Process", bootstrap)
            self.assertIn("(Get-ExecutionPolicy) -eq 'Restricted'", bootstrap)
            self.assertIn("Get-ExecutionPolicy -List", bootstrap)
            self.assertIn("'*Policy'", bootstrap)
            self.assertIn("Set-ExecutionPolicy -Scope Process RemoteSigned -Force", bootstrap)
            self.assertIn("Set-ExecutionPolicy -Scope Process $o -Force", bootstrap)
            self.assertIn("}finally{", bootstrap)
            self.assertIn("Remove-Item -LiteralPath $f", bootstrap)
            self.assertNotIn("-Scope CurrentUser", bootstrap)
            self.assertNotIn("-Scope LocalMachine", bootstrap)
            self.assertNotIn("ExecutionPolicy Bypass", bootstrap)
            self.assertIn("Get-FileHash -InputStream", bootstrap)

    def test_console_exits_only_after_collector_and_cleanup(self):
        text = HEADER.read_text('utf-8')
        for mode in ('Fast', 'Full'):
            bootstrap = text.split('kBootstrap%s[] PROGMEM = R"BOOT(' % mode, 1)[1].split(')BOOT"', 1)[0]
            self.assertTrue(bootstrap.endswith('}finally{$s.Dispose()};exit'))
            self.assertLess(bootstrap.index('& $f -Port $p -OpenSerial $s'),
                            bootstrap.rindex('Set-ExecutionPolicy -Scope Process $o -Force'))
            self.assertLess(bootstrap.rindex('Set-ExecutionPolicy -Scope Process $o -Force'),
                            bootstrap.rindex('$s.Dispose()'))
            self.assertEqual(bootstrap.count(';exit'), 1)
        self.assertIn('powershell.exe -NoProfile -NoLogo -NoExit', MAIN.read_text('utf-8'))

if __name__ == '__main__':
    unittest.main()
