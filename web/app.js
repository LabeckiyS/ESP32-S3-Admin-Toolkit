'use strict';
// No network access. The report moves only across a direct Web Bluetooth link.
const SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e';
const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e';
const $ = id => document.getElementById(id);
let device = null, rx = null, tx = null, current = null, report = null;
let writeQueue = Promise.resolve();
const decoder = new TextDecoder('utf-8', { fatal: true });
const encoder = new TextEncoder();
function log(message) { $('log').textContent = `[${new Date().toLocaleTimeString()}] ${message}\n` + $('log').textContent.slice(0, 4200); }
let connecting = false;
function status(message, connected) {
  $('status').textContent = message;
  $('dot').classList.toggle('online', !!connected);
  $('connect').textContent = connected ? 'Отключить ESP32' : 'Подключить ESP32';
  $('connect').classList.toggle('secondary', !!connected);
}
function ui() {
  $('connect').disabled = connecting;
  // The chosen layout is informational; the dongle never changes Windows language.
  $('run').disabled = !rx || $('pc-layout').value !== 'en';
  $('get').disabled = !rx;
  $('cancel').disabled = !rx || !current;
  if (typeof updateKeyboardUI === 'function') updateKeyboardUI(!!rx);
}
function progress(done, total) { $('progress').style.width = (total ? Math.min(100, 100 * done / total) : 0).toFixed(1) + '%'; }
function queueBytes(payload, withoutResponse = false) {
  if (!rx) return Promise.reject(new Error('BLE не подключён'));
  // Shared GATT serialization for commands, diagnostics ACKs, and mouse packets.
  // Mouse supports WRITE_NR to avoid a BLE round-trip per cursor movement.
  const characteristic = rx;
  const result = writeQueue.then(() => withoutResponse && typeof characteristic.writeValueWithoutResponse === 'function'
    ? characteristic.writeValueWithoutResponse(payload)
    : characteristic.writeValueWithResponse(payload));
  writeQueue = result.catch(() => {});
  return result;
}
function queueCommand(text) { return queueBytes(encoder.encode(text)); }
function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xEDB88320 : 0);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function onFrame(event) {
  const view = event.target.value;
  const buf = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (!buf.length) return;
  if (buf[0] === 68) { // D, binary data frame
    if (!current || buf.length < 4) return;
    const seq = buf[1] | (buf[2] << 8);
    if (seq === current.seq) {
      const payload = buf.slice(3);
      if (current.received + payload.length > current.size) {
        log('Ошибка: слишком длинный отчёт'); queueCommand('STOP').catch(() => {}); current = null; ui(); return;
      }
      current.parts.push(payload);
      current.received += payload.length;
      current.seq++;
      progress(current.received, current.size);
      $('detail').textContent = `${current.received} / ${current.size} байт · пакет ${seq}`;
      queueCommand('A|' + seq).catch(err => { log('ACK: ' + err.message); });
    } else if (seq === current.seq - 1) {
      // Device retried because it did not receive our previous ACK.
      queueCommand('A|' + seq).catch(() => {});
    } else {
      log(`Неверный порядок BLE-пакетов: ${seq}, ожидался ${current.seq}`);
    }
    return;
  }
  let message;
  try { message = decoder.decode(buf); } catch { log('Некорректный служебный BLE-пакет'); return; }
  if (message === 'Q|OK' || message === 'Q|FULL') {
    if (typeof onKeyboardAck === 'function') onKeyboardAck(message === 'Q|OK');
    return;
  }
  if (message.startsWith('M|')) {
    const fields = message.split('|');
    const size = Number(fields[1]);
    const crc = Number.parseInt(fields[2], 16) >>> 0;
    if (!Number.isSafeInteger(size) || size < 1 || size > 65536 || !/^[0-9a-f]{1,8}$/i.test(fields[2] || '')) {
      log('ESP32 прислала неверные параметры отчёта'); return;
    }
    current = { size, crc, parts: [], received: 0, seq: 0 };
    progress(0, size); ui();
    log(`Передача началась: ${size} байт, CRC32 ${fields[2].toUpperCase()}`);
    queueCommand('START').catch(err => log('START: ' + err.message));
  } else if (message === 'E') {
    finishReport();
  } else if (message.startsWith('N|')) {
    if (message === 'N|ENG_REQUIRED') {
      $('detail').textContent = 'На ПК выбрана RUS. Переключи язык вручную на ENG и выбери ENG в панели.';
      log($('detail').textContent);
    } else log('Ошибка устройства: ' + message.slice(2));
    current = null; ui();
  } else if (message.startsWith('P|')) {
    const phase = message.slice(2);
    const labels = { LAUNCHING: 'Открывается PowerShell на компьютере', BOOTSTRAP: 'Загружается сборщик через USB CDC', COLLECTOR: 'Windows получает сборщик с ESP32', RECEIVING: 'Windows передаёт диагностические данные', DONE: 'Диагностика завершена; получаем отчёт', READY: 'Ожидание' };
    $('detail').textContent = labels[phase] || ('Состояние: ' + phase);
    log($('detail').textContent);
    if (phase === 'DONE') queueCommand('GET').catch(err => log('GET: ' + err.message));
  } else if (message.startsWith('S|')) {
    log('Размер сохранённого отчёта: ' + message.slice(2));
  } else {
    log('Неизвестное BLE-сообщение: ' + message);
  }
}
function finishReport() {
  if (!current) return;
  const t = current;
  current = null; ui();
  if (t.received !== t.size) { log(`Ошибка длины: ${t.received} != ${t.size}`); return; }
  const bytes = new Uint8Array(t.size);
  let offset = 0;
  for (const part of t.parts) { bytes.set(part, offset); offset += part.length; }
  if (crc32(bytes) !== t.crc) { log('Ошибка CRC32. Файл отклонён.'); return; }
  try {
    report = { object: JSON.parse(decoder.decode(bytes)), bytes };
    showReport(report.object);
    progress(t.size, t.size);
    $('detail').textContent = `Проверен CRC32 · ${t.size} байт · данные получены`; log('Отчёт получен и проверен.');
  } catch (err) { log('Ошибка JSON: ' + err.message); }
}
function showReport(data) {
  $('report-text').value = formatTechnicalReport(data);
  $('copy-status').textContent = '';
  $('summary').hidden = false;
}
function disconnect() {
  if (tx?.removeEventListener) tx.removeEventListener('characteristicvaluechanged', onFrame);
  if (device?.removeEventListener) device.removeEventListener('gattserverdisconnected', disconnect);
  if (device?.gatt?.connected) device.gatt.disconnect();
  device = null;
  rx = null; tx = null; current = null;
  connecting = false;
  if (typeof onKeyboardAck === 'function') onKeyboardAck(false);
  status('Не подключено', false);
  ui();
  log('BLE отключён.');
}
async function connect() {
  if (connecting || rx) return;
  if (!navigator.bluetooth) { log('Требуется Android Chrome / Chrome или Edge с Web Bluetooth по HTTPS.'); return; }
  connecting = true;
  ui();
  $('connect').textContent = 'Подключение…';
  try {
    device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    device.addEventListener('gattserverdisconnected', disconnect);
    const gatt = await device.gatt.connect();
    const service = await gatt.getPrimaryService(SERVICE);
    tx = await service.getCharacteristic(TX);
    rx = await service.getCharacteristic(RX);
    await tx.startNotifications();
    tx.addEventListener('characteristicvaluechanged', onFrame);
    status('Подключено к ' + (device.name || 'ESP32-S3'), true);
    log('BLE подключён. Для диагностики вручную выбери ENG на ПК и в панели.');
  } catch (err) {
    disconnect();
    log('Ошибка подключения: ' + err.message);
  } finally {
    connecting = false;
    ui();
  }
}
// Default tab is always the keyboard, independent of the previous visit.
function selectTab(name) {
  const keyboard = name === 'keyboard';
  $('keyboard-panel').hidden = !keyboard;
  $('diagnostics-panel').hidden = keyboard;
  $('tab-keyboard').classList.toggle('selected', keyboard);
  $('tab-diagnostics').classList.toggle('selected', !keyboard);
  $('tab-keyboard').setAttribute('aria-selected', String(keyboard));
  $('tab-diagnostics').setAttribute('aria-selected', String(!keyboard));
}
$('tab-keyboard').addEventListener('click', () => selectTab('keyboard'));
$('tab-diagnostics').addEventListener('click', () => selectTab('diagnostics'));
$('connect').addEventListener('click', async () => {
  if (rx || device?.gatt?.connected) disconnect();
  else await connect();
});
$('pc-layout').addEventListener('change', () => {
  ui();
  $('detail').textContent = $('pc-layout').value === 'en'
    ? 'Режим ENG: запуск разрешён. Раскладка Windows автоматически не меняется.'
    : 'Режим RUS: перед запуском вручную переключи Windows на ENG и выбери ENG здесь.';
});
$('run').addEventListener('click', async () => {
  if ($('pc-layout').value !== 'en') {
    log('Запуск отменён: на ПК должна быть вручную установлена раскладка ENG.');
    return;
  }
  try {
    await queueCommand('RUN|EN');
    log('Старт: ESP32 открывает PowerShell без переключения раскладки.');
  } catch (err) { log('RUN: ' + err.message); }
});
$('get').addEventListener('click', async () => {
  try { current = null; progress(0, 1); await queueCommand('GET'); log('Запрошен последний отчёт с ESP32.'); }
  catch (err) { log('GET: ' + err.message); }
});
$('cancel').addEventListener('click', async () => {
  try { await queueCommand('STOP'); } catch (err) { log('STOP: ' + err.message); }
  current = null; ui();
});
$('copy-report').addEventListener('click', async () => {
  const field = $('report-text');
  if (!field.value) return;
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API не предоставлен');
    await navigator.clipboard.writeText(field.value);
    $('copy-status').textContent = 'Отчёт скопирован в буфер обмена.';
  } catch (error) {
    // Android Chrome lets users manually select the contents of readonly textarea.
    // Legacy fallback stays inside the real user click, not in an async background task.
    field.focus();
    field.select();
    let copied = false;
    try { copied = !!document.execCommand?.('copy'); } catch {}
    $('copy-status').textContent = copied
      ? 'Отчёт скопирован.'
      : 'Выделен весь текст. Нажми «Копировать» в меню выделения Android.';
  }
});
ui();
