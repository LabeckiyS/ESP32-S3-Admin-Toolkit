'use strict';
// USB HID keyboard + mouse frontend. Uses the same BLE RX as the diagnostic UI.
// Packet 0x10 + up to 19 bytes of UTF-8, acknowledged after physical typing.
// No keyboard journal in the UI; errors remain inspectable in Chrome DevTools.
const keyboardLog = message => console.info('[Admin Toolkit keyboard] ' + message);
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
// Clear only the phone's draft, without sending any HID key or BLE packet.
document.getElementById('clear-text').addEventListener('click', () => {
  const field = document.getElementById('keyboard-text');
  field.value = '';
  field.focus?.();
});
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
  return queueBytes(bytes, kind === 'm').catch(err => keyboardLog('Мышь: ' + err.message));
}
// Never queue unbounded historical cursor movements. Keep at most one in-flight
// move and aggregate the newest deltas. WRITE_NR avoids BLE response latency.
let mouseMoveBusy = false;
let mousePendingX = 0, mousePendingY = 0;
async function flushMouseMovement() {
  if (!rx || mouseMoveBusy) return;
  const x = limitByte(mousePendingX), y = limitByte(mousePendingY);
  if (!x && !y) return;
  mousePendingX -= x;
  mousePendingY -= y;
  mouseMoveBusy = true;
  try {
    await mousePacket('m', [x, y]);
  } finally {
    mouseMoveBusy = false;
  }
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
// No right-click or other action on long press: explicit mouse buttons below
// are the only way to send right/middle clicks. A short tap sends left click.
const MAX_TAP_MS = 350;
let down = false, lastX = 0, lastY = 0, accX = 0, accY = 0, moved = false, downAt = 0;
pad.addEventListener('pointerdown', e => {
  if (!rx || down || (e.pointerType === 'mouse' && e.button !== 0)) return;
  down = true; moved = false; downAt = Date.now();
  accX = accY = 0; lastX = e.clientX; lastY = e.clientY;
  pad.setPointerCapture(e.pointerId);
  e.preventDefault();
});
pad.addEventListener('pointermove', e => {
  if (!down) return;
  const dx = e.clientX - lastX, dy = e.clientY - lastY;
  lastX = e.clientX; lastY = e.clientY;
  if (Math.abs(dx) > 1 || Math.abs(dy) > 1) moved = true;
  accX += dx; accY += dy;
  if (e.cancelable) e.preventDefault();
});
pad.addEventListener('pointerup', e => {
  if (!down) return;
  down = false;
  if (!moved && Date.now() - downAt <= MAX_TAP_MS) mousePacket('c', 1);
  if (pad.hasPointerCapture?.(e.pointerId)) pad.releasePointerCapture(e.pointerId);
  e.preventDefault();
});
pad.addEventListener('pointercancel', () => { down = false; accX = accY = 0; });
// Suppress Chrome's own long-press context menu on the touchpad surface.
pad.addEventListener('contextmenu', e => e.preventDefault());
setInterval(() => {
  if (!rx) { accX = accY = mousePendingX = mousePendingY = 0; return; }
  if (accX || accY) {
    // Input is accumulated rather than enqueued; cap backlog to two HID moves.
    mousePendingX = Math.max(-254, Math.min(254, mousePendingX + Math.round(accX * sensitivity)));
    mousePendingY = Math.max(-254, Math.min(254, mousePendingY + Math.round(accY * sensitivity)));
    accX = accY = 0;
  }
  void flushMouseMovement();
}, 30);
updateKeyboardUI(!!rx);
