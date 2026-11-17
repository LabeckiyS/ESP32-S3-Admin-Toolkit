'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/keyboard.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');

function start() {
  let now = 0;
  const elements = new Map();
  const packets = [];
  function makeElement() {
    const listeners = new Map();
    return {
      value: '', checked: false, disabled: false, textContent: '', dataset: {},
      listeners,
      addEventListener(kind, cb) { listeners.set(kind, cb); },
      setPointerCapture() {},
      hasPointerCapture() { return false; },
      releasePointerCapture() {},
      fire(kind, ev = {}) {
        const e = { pointerType: 'touch', button: 0, pointerId: 1,
          clientX: 10, clientY: 10, cancelable: true,
          preventDefault() { this.prevented = true; }, ...ev };
        listeners.get(kind)?.(e);
        return e;
      }
    };
  }
  const pad = makeElement();
  elements.set('trackpad', pad);
  elements.set('sensitivity', makeElement());
  elements.set('sensitivity-value', makeElement());
  const rightButton = makeElement(); rightButton.dataset.button = '2';
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, makeElement()); return elements.get(id); },
    querySelectorAll(sel) { if (sel === '.mouse-button') return [rightButton]; return []; }
  };
  const env = {
    document, console, Uint8Array, TextEncoder,
    Date: {now: () => now},
    setTimeout, clearTimeout, setInterval: () => 0,
    rx: { connected: true },
    queueBytes: async payload => { packets.push(Array.from(payload)); },
    queueCommand: async () => {}
  };
  vm.createContext(env);
  vm.runInContext(source, env);
  return {pad, rightButton, packets, setClock(value) { now = value; }};
}

test('Short tap sends only left click', () => {
  const r = start();
  r.setClock(100);
  r.pad.fire('pointerdown');
  r.setClock(200);
  r.pad.fire('pointerup');
  assert.deepEqual(r.packets, [[2, 99, 1]]);
});

test('Long press sends no right click, or any other click', () => {
  const r = start();
  r.setClock(100);
  r.pad.fire('pointerdown');
  r.setClock(1000);
  r.pad.fire('pointerup');
  assert.deepEqual(r.packets, []);
});

test('Right click works only through explicit button', () => {
  const r = start();
  r.rightButton.fire('click');
  assert.deepEqual(r.packets, [[2, 99, 2]]);
});

test('Touchpad suppresses browser context menu and does not render keyboard journal', () => {
  const r = start();
  const event = r.pad.fire('contextmenu');
  assert.equal(event.prevented, true);
  assert.equal(html.includes('id="keyboard-log"'), false);
  assert.equal(html.includes('Журнал клавиатуры'), false);
  assert.equal(html.includes('удержание — правый клик'), false);
});
