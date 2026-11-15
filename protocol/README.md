# Wire protocol v0.2 · USB CDC / BLE GATT

## Windows → ESP32 (USB CDC)

ASCII LF (`\n`), 115200 бод (виртуальный CDC игнорирует физическую скорость), по одному запросу с ответом.

```
PC             ESP32
PING       →   PONG|0.2.0
BEGIN|len|crc32hex  → READY
DATA|0|HEX...       → ACK|0
DATA|1|HEX...       → ACK|1
...
END             → DONE|len
```

`len` — размер компактного UTF-8 JSON в байтах (1..65536). `crc32hex` — CRC32/IEEE по исходным байтам (полином `0xEDB88320`, init/final xor `0xffffffff`). `HEX` — верхне-/нижнерегистровый hex, до 64 байт. Номер кадра начинается с 0. При повторной отправке последнего подтверждённого кадра ESP32 повторно отвечает ACK без записи данных.

Ошибки `ERR|<code>`; `ABORT` удаляет незавершённый файл; `INFO` возвращает готовность и лимит. Нет аутентификации или шифрования в MVP.

## ESP32 ↔ Browser (BLE)

GATT Nordic UART-style Service `6e400001-b5a3-f393-e0a9-e50e24dcca9e`:
- RX (browser → device; WRITE): `6e400002-b5a3-f393-e0a9-e50e24dcca9e`.
- TX (device → browser; NOTIFY): `6e400003-b5a3-f393-e0a9-e50e24dcca9e`.

Commands to RX: `RUN`, `GET`, `START`, `STOP`, `STATUS`, `A|<seq>`. `RUN` explicitly launches an approved HID bootstrap in the unlocked Windows session; it is not run on device insertion.
Notifications from TX:
- `M|<size>|<crc32hex>` — metadata, then browser sends `START`.
- Binary payload: `0x44` (`D`), uint16 little-endian sequence, **1..16** bytes JSON data.
- `E` — end of last acknowledged frame.
- `N|<reason>` — error / no report.
- `S|<size>` — short status response.
- `P|<stage>` — launch/collection status (`LAUNCHING`, `BOOTSTRAP`, `RECEIVING`, `DONE`, etc.); status is advisory, not proof of Windows execution.

## Windows bootstrap delivery (v0.2)

After `RUN`, the built-in USB HID types an ASCII PowerShell bootstrap into a visible Windows console (requires ENG layout and unlocked interactive session). It identifies the **only** CDC COM port whose PnP device ID contains `VID_303A`, sends `SCRIPT` over that port and reads Base64 lines until `ENDSCRIPT`. The payload is the copy of `Collect-Inventory.ps1` embedded into firmware at build time. SHA-256 verification precedes writing the PS1 file to `%TEMP%` and executing it under standard Windows execution policy. After collector completion, the v0.1 CDC `BEGIN/DATA/END` transfer is used.

The browser automatically sends `GET` after `P|DONE`; it still allows a manual `GET` for the saved report.

Browser sends an acknowledgment `A|seq` for each new valid `D` frame. If acknowledgment is lost, it repeats the previous ACK when it sees duplicate data. ESP32 resends after 900 ms (up to 8 retries). On disconnect/STOP transfer is aborted, latest report stays in flash. `GET` restarts transfer from byte zero. The default ATT MTU of 23 is sufficient for the maximum 19-byte data notification.

Transfer is intentionally conservative; throughput optimizations are planned for v0.2.
