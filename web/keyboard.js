'use strict';
// USB HID keyboard + mouse frontend. Uses the same BLE RX as the diagnostic UI.
// Packet 0x10 + up to 19 bytes of UTF-8, acknowledged after physical typing.
const keyboardLog = message => {
  const el = document.getElementById('keyboard-log');
  el.textContent = `[${new Date().toLocaleTimeString()}] ${message}\n` + el.textContent.slice(0, 2400);
};
let keyboardAckResolve = null;
function onKeyboardAck(success) {
  if (!keyboardAckResolve) return;
  const resolve = keyboardAckResolve;
  keyboardAckResolve = null;
  resolve(success);
}
function updateKeyboardUI(connected) {
  for (const button of document.querySelectorAll('.hid-control')) button.disabled = !connected;
}
function timeoutAck(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => {
      if (keyboardAckResolve === done) { keyboardAckResolve = null; resolve(false); }
    }, ms);
    function done(success) { clearTimeout(timer); resolve(success); }
    keyboardAckResolve = done;
  });
}
let sendingText = false;
async function sendKeyboardText() {
  if (sendingText || !rx) return;
  sendingText = true;
  document.getElementById('send-text').disabled = true;
  try {
    let text = document.getElementById('keyboard-text').value;
    if (document.getElementById('send-enter').checked) text += '\n';
    const bytes = new TextEncoder().encode(text);
    for (let offset = 0; offset < bytes.length; offset += 19) {
      // Register ack listener before sending to avoid a fast notify race.
      const ack = timeoutAck(15000);
      await queueBytes(new Uint8Array([0x10, ...bytes.slice(offset, offset + 19)]));
      if (!(await ack)) throw new Error('ESP32 не подтвердила печать блока текста');
    }
    keyboardLog(`Отправлено ${bytes.length} байт.`);
  } catch (error) {
    onKeyboardAck(false); // release a pending waiter when BLE transport fails
    keyboardLog('Ошибка: ' + error.message);
  } finally {
    sendingText = false;
    updateKeyboardUI(!!rx);
  }
}
document.getElementById('send-text').addEventListener('click', sendKeyboardText);
for (const el of document.querySelectorAll('.key-action')) {
  el.addEventListener('click', async () => {
    try { await queueCommand('K|' + el.dataset.key); }
    catch (error) { keyboardLog('Клавиша: ' + error.message); }
  });
}
function limitByte(v) { return Math.max(-127, Math.min(127, Math.round(v))); }
function mousePacket(kind, value) {
  if (!rx) return;
  const bytes = kind === 'm'
    ? new Uint8Array([0x02, 0x6d, (limitByte(value[0]) + 128) & 255, (limitByte(value[1]) + 128) & 255])
    : kind === 'c'
      ? new Uint8Array([0x02, 0x63, value])
      : new Uint8Array([0x02, 0x73, (limitByte(value) + 128) & 255]);
  queueBytes(bytes).catch(err => keyboardLog('Мышь: ' + err.message));
}
for (const el of document.querySelectorAll('.mouse-button')) {
  el.addEventListener('click', () => mousePacket('c', Number(el.dataset.button)));
}
for (const el of document.querySelectorAll('.scroll-button')) {
  el.addEventListener('click', () => mousePacket('s', Number(el.dataset.scroll)));
}
const slider = document.getElementById('sensitivity');
const sliderLabel = document.getElementById('sensitivity-value');
let sensitivity = 1.6;
slider.addEventListener('input', () => {
  sensitivity = Math.max(.3, Math.min(5, Number(slider.value) || 1.6));
  sliderLabel.textContent = sensitivity.toFixed(1) + '×';
});
const pad = document.getElementById('trackpad');
let down = false, lastX = 0, lastY = 0, accX = 0, accY = 0, moved = false, longClicked = false, longTimer = null;
pad.addEventListener('pointerdown', e => {
  if (!rx || down) return;
  down = true; moved = false; longClicked = false;
  accX = accY = 0; lastX = e.clientX; lastY = e.clientY;
  pad.setPointerCapture(e.pointerId);
  longTimer = setTimeout(() => { if (down && !moved) { longClicked = true; mousePacket('c', 2); } }, 650);
  e.preventDefault();
});
pad.addEventListener('pointermove', e => {
  if (!down) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) { moved = true; clearTimeout(longTimer); }
  accX += dx; accY += dy;
});
pad.addEventListener('pointerup', () => {
  if (!down) return;
  down = false; clearTimeout(longTimer);
  if (!moved && !longClicked) mousePacket('c', 1);
});
pad.addEventListener('pointercancel', () => { down = false; clearTimeout(longTimer); accX = accY = 0; });
setInterval(() => {
  if (!rx || (!accX && !accY)) return;
  const x = limitByte(accX * sensitivity), y = limitByte(accY * sensitivity);
  accX = accY = 0;
  if (x || y) mousePacket('m', [x, y]);
}, 40);
updateKeyboardUI(!!rx);
