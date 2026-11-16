'use strict';
// Browser-side USB descriptor inspection only. Never opens the port or writes any data.
(() => {
  const trigger = document.getElementById('check-port');
  const status = document.getElementById('port-status');
  if (!trigger || !status) return;
  const hex = n => n == null ? 'не указан' : '0x' + n.toString(16).toUpperCase().padStart(4, '0');
  trigger.addEventListener('click', async () => {
    if (!navigator.serial || typeof navigator.serial.requestPort !== 'function') {
      status.textContent = 'Web Serial недоступен. Используй Chrome или Edge на компьютере по HTTPS.';
      return;
    }
    trigger.disabled = true;
    try {
      const port = await navigator.serial.requestPort();
      const info = port.getInfo();
      const vid = hex(info.usbVendorId);
      const pid = hex(info.usbProductId);
      const recognized = info.usbVendorId === 0x303A;
      status.textContent = 'Выбран USB-порт: VID ' + vid + ' / PID ' + pid + '. ' +
        (recognized
          ? 'Обнаружен USB VID Espressif. Попробуй установить прошивку, выбрав этот же порт.'
          : 'Это не стандартный USB VID Espressif. Проверь, что выбрана именно T-Dongle-S3 в режиме BOOT.');
    } catch (error) {
      status.textContent = error && error.name === 'NotFoundError'
        ? 'Порт не выбран. Нажми «Проверить USB-порт» ещё раз и выбери ESP32-S3.'
        : 'Не удалось определить порт: ' + (error && error.message ? error.message : String(error));
    } finally {
      trigger.disabled = false;
    }
  });
})();
