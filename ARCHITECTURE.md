# Architecture decision record · ADR-001

## Контекст

Нужно получить аппаратные характеристики Windows на Android Chrome без переключения сетей и без поддержки Wi-Fi на приборе. Целевая плата ESP32-S3 имеет 16 MB Flash, но **не имеет PSRAM**. BLE без pairing — пожелание владельца для раннего прототипа, но риск для корпоративных сведений.

## Решение MVP

- Использовать Arduino Core, потому что в текущей линейке есть готовые USB CDC, USB HID, BLE GATT и драйвер ST7735 для PlatformIO.
- Отказаться от Wi-Fi, WebServer, фоновых Windows-агентов и AutoRun.
- Экспортировать **USB CDC + HID** как составное устройство: HID не отправляет ни одной клавиши и зарезервирован для будущего согласованного режима.
- Подключать сборщик к CDC COM-порту **вручную**, без привилегий администратора по умолчанию.
- Принять отчёт на ESP32 в файл `/incoming.part` с лимитом 64 KiB и проверки длины/CRC32 перед публикацией `/report.json`.
- Передавать отчёт с LittleFS через BLE, используя stop-and-wait (16 полезных байт/уведомление) и ACK с телефона. При обрыве смартфон делает запрос повторно.
- Держать UI как самостоятельные статические файлы на HTTPS (например, GitHub Pages). Веб-страница **не делает сетевых запросов за отчётами**.

## Что ещё не доказано

Фактическая USB-энумерация CDC+HID на конкретной сборке PlatformIO, стабильность BLE Notify на S25 Ultra, приём COM PowerShell под Windows 11, размер итоговой прошивки, интерфейс LCD и восстановление после отключения питания. Это аппаратные этапы тестирования, а не заявленные завершённые результаты.

## Путь развития

v0.2: адаптивный BLE размер кадра и пакетное ACK; выбор разделов диагностики; read-only сопоставление устройств; дополнительные проверки дисков. v0.3: защищённая сессия и разграничение полномочий (без необходимости системного BLE PIN), тест восстановления, управление несколькими отчётами. Масштабирование до десятков ПК — отдельный продуктовый этап.

## v0.2: on-demand HID launcher

Команда телефона `RUN` (BLE RX) запускает **видимый** PowerShell на разблокированном Windows с раскладкой ENG через USB HID. Единственная встроенная bootstrap-команда выбирает один USB CDC COM-порт VID 303A, запрашивает `SCRIPT` и читает Base64-содержимое локально встроенного PowerShell-сборщика. Его SHA-256 сравнивается со значением, зафиксированным при компиляции. Скрипт записывается в `%TEMP%\AdminToolkit-Collect.ps1` и исполняется обычным `&`, без обхода Execution Policy.

Поток обратной передачи не меняется: PowerShell -> CDC `BEGIN/DATA/END` -> LittleFS -> BLE `GET/START/D/A/E` -> Android Chrome. После `DONE` ESP32 посылает `P|DONE`, и UI автоматически запускает `GET`. Сообщения `P|LAUNCHING`, `P|BOOTSTRAP`, `P|RECEIVING` служат ориентиром, а не гарантией выполнения в Windows.

Не используется Wi-Fi, системная установка агента, персистентность, повышение прав или автоматический запуск при подключении USB. Недостаток: HID-текст зависит от раскладки и активного рабочего стола; COM VID 303A требует проверки на реальной сборке.

## v0.3 Unified input & inventory

On page load the keyboard tab is displayed first. Both tabs share one BLE GATT connection (Nordic-style UART service). Keyboard UTF-8 data packets are prefixed with `0x10` and limited to 19 payload bytes; the firmware processes them in a FreeRTOS queue and responds with `Q|OK` *after* typing, so the browser can throttle data and avoid overflow. USB HID mouse packets start with `0x02`; shortcut commands use ASCII `K|NAME`. The existing diagnostics protocol is unchanged. No Wi-Fi, BLE PIN or bonding. Composite HID keyboard + mouse + CDC enumeration must be hardware-tested on Windows; CI builds only verify compilation.
