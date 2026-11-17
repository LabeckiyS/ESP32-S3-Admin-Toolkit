"""Dependency-free checks for framing, CRC32, and the v0.1 budget."""
import binascii
from pathlib import Path
import json
import unittest
import zlib

MAX_REPORT = 65536
USB_CHUNK = 64
BLE_CHUNK = 16


def usb_frames(data: bytes):
    assert 0 < len(data) <= MAX_REPORT
    yield f'BEGIN|{len(data)}|{zlib.crc32(data):08X}'
    for seq, pos in enumerate(range(0, len(data), USB_CHUNK)):
        yield f'DATA|{seq}|{data[pos:pos+USB_CHUNK].hex().upper()}'
    yield 'END'


def ble_frame(seq: int, payload: bytes) -> bytes:
    assert 0 <= seq <= 65535 and 1 <= len(payload) <= BLE_CHUNK
    return b'D' + seq.to_bytes(2, 'little') + payload


class ProtocolTests(unittest.TestCase):
    def test_crc_known_vector(self):
        self.assertEqual(zlib.crc32(b'123456789'), 0xCBF43926)

    def test_utf8_roundtrip_usb(self):
        sample = json.dumps({'name': 'Тестовый ПК', 'ip': '192.0.2.12'}, ensure_ascii=False).encode('utf-8')
        frames = list(usb_frames(sample))
        self.assertTrue(frames[0].startswith('BEGIN|'))
        got = b''.join(binascii.unhexlify(line.split('|')[2]) for line in frames[1:-1])
        self.assertEqual(got, sample)
        self.assertEqual(len(got), int(frames[0].split('|')[1]))

    def test_ble_payload_fits_default_mtu(self):
        frame = ble_frame(42, bytes(range(16)))
        self.assertEqual(len(frame), 19)
        self.assertEqual(frame[:3], b'D\x2a\x00')

    def test_max_size_number_of_frames(self):
        frames = list(usb_frames(b'x' * MAX_REPORT))
        self.assertEqual(len(frames), 1026)
        self.assertLessEqual(max(map(len, frames)), 138)

    def test_project_has_no_wifi_symbols(self):
        from pathlib import Path
        root = Path(__file__).parents[1]
        firmware = (root / 'firmware/src/main.cpp').read_text(encoding='utf-8')
        self.assertNotIn('#include <WiFi', firmware)
        self.assertNotIn('softAP(', firmware)
        self.assertNotIn('WebServer', firmware)
        self.assertNotIn('Keyboard.write(', firmware)


if __name__ == '__main__':
    unittest.main()


class KeyboardLayoutContractTests(unittest.TestCase):
    def test_diagnostics_never_toggles_host_language(self):
        source = (Path(__file__).resolve().parents[1] / "firmware/src/main.cpp").read_text(encoding="utf-8")
        self.assertIn('s == "RUN|RU"', source)
        self.assertIn('s == "RUN" || s == "RUN|EN"', source)
        self.assertIn('requestEnglishRequired = true;', source)
        self.assertIn('notifyText("N|ENG_REQUIRED");', source)
        launch = source[source.index("void launchCollector(bool full)") : source.index("void pollTransfer()")]
        self.assertNotIn("selectEnglishIfRussian", source)
        self.assertNotIn("KEY_LEFT_GUI, ' '", launch)
        self.assertNotIn("keyboard.press(' ')", launch)
        self.assertIn('typeAscii("powershell.exe', launch)

class ModeContractTests(unittest.TestCase):
    def test_fast_and_full_are_separate_entrypoints(self):
        root = Path(__file__).resolve().parents[1]
        collector = (root / 'collectors/windows/Collect-Inventory.ps1').read_text(encoding='utf-8')
        self.assertIn('function Get-QuickInventory', collector)
        self.assertIn('function Get-Inventory', collector)
        self.assertIn("if ($Mode -eq 'Fast')", collector)
        self.assertIn('Get-NetAdapter -Physical', collector)
        self.assertIn('Win32_NetworkAdapterConfiguration', collector)
        firmware = (root / 'firmware/src/main.cpp').read_text(encoding='utf-8')
        self.assertIn('RUN|EN|FULL', firmware)
        self.assertIn('RUN|EN|FAST', firmware)
        self.assertIn('|W4', firmware)
