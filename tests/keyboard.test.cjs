'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const webDir = path.join(__dirname, '..', 'web');

function createRuntime() {
  const elements = new Map();
  const intervals = [];
  function element() {
    return {
      value: '', hidden: false, disabled: false, checked: false, style: {}, dataset: {},
      textContent: '', listeners: {}, attributes: {},
      classList: { classes:new Set(), toggle(name, on) { if (on) this.classes.add(name); else this.classes.delete(name); } },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      setAttribute(name, value) { this.attributes[name] = value; },
      append() {}, replaceChildren() {}, click() {}, setPointerCapture() {}
    };
  }
  const document = {
    getElementById(id) { if(!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement() { return element(); },
    querySelectorAll(selector) {
      return selector === '.hid-control' ? [document.getElementById('send-text')] : [];
    }
  };
  document.getElementById('diagnostics-panel').hidden = true;
  const env = {document, navigator:{}, Date, TextDecoder, TextEncoder, Uint8Array, DataView, Blob,
    URL:{createObjectURL:()=> 'blob:mock', revokeObjectURL(){}},
    setTimeout, clearTimeout, setInterval:fn=>{ intervals.push(fn); return intervals.length; }, clearInterval(){} };
  vm.createContext(env);
  vm.runInContext(fs.readFileSync(path.join(webDir,'app.js'),'utf8'),env);
  vm.runInContext(fs.readFileSync(path.join(webDir,'keyboard.js'),'utf8'),env);
  return { env, elements, intervals, el: id => document.getElementById(id), run: code => vm.runInContext(code,env) };
}

test('keyboard is default and diagnostics is optional', () => {
  const runtime = createRuntime();
  assert.equal(runtime.el('diagnostics-panel').hidden, true);
  assert.equal(runtime.el('keyboard-panel').hidden, false);
  runtime.el('tab-diagnostics').listeners.click();
  assert.equal(runtime.el('diagnostics-panel').hidden, false);
  assert.equal(runtime.el('keyboard-panel').hidden, true);
  runtime.el('tab-keyboard').listeners.click();
  assert.equal(runtime.el('keyboard-panel').hidden, false);
  assert.equal(runtime.el('tab-keyboard').attributes['aria-selected'], 'true');
});

test('UTF-8 text is framed in 19-byte chunks with acknowledgments', async () => {
  const runtime = createRuntime();
  const packets = [];
  const rx = {writeValueWithResponse: async bytes => {
    packets.push(Uint8Array.from(bytes));
    if(bytes[0] === 0x10) setImmediate(() => runtime.run('onKeyboardAck(true)'));
  }};
  runtime.env.testRx = rx;
  runtime.run('rx = testRx; ui()');
  assert.equal(runtime.el('send-text').disabled, false);
  runtime.el('keyboard-text').value = 'Привет! Hello, world!';
  runtime.el('send-enter').checked = false;
  await runtime.el('send-text').listeners.click();
  assert.ok(packets.length >= 2);
  for (const p of packets) { assert.equal(p[0],0x10); assert.ok(p.length<=20); }
  const output = Buffer.concat(packets.map(p=>Buffer.from(p.slice(1)))).toString('utf8');
  assert.equal(output, 'Привет! Hello, world!');
  assert.match(runtime.el('keyboard-log').textContent,/Отправлено/);
});

test('keyboard HID command encoding is separate from diagnostics RUN', async () => {
  const runtime = createRuntime();
  const packets = [];
  runtime.env.testRx = {writeValueWithResponse: async payload => packets.push(Uint8Array.from(payload))};
  runtime.run('rx = testRx; ui()');
  await runtime.run("queueCommand('K|COPY')");
  await runtime.run("queueCommand('RUN')");
  assert.equal(new TextDecoder().decode(packets[0]),'K|COPY');
  assert.equal(new TextDecoder().decode(packets[1]),'RUN');
});

test('mouse coalesces delayed BLE movements and uses write without response', async () => {
  const rt = createRuntime();
  const packets = [];
  let release = null;
  rt.env.testRx = {
    writeValueWithResponse: async () => { throw Error('mouse should use WRITE_NR'); },
    writeValueWithoutResponse: bytes => new Promise(resolve => { packets.push(Uint8Array.from(bytes)); release = resolve; })
  };
  rt.run('rx = testRx; ui()');
  const pad = rt.el('trackpad');
  pad.listeners.pointerdown({clientX: 0, clientY: 0, pointerId: 1, preventDefault(){}});
  pad.listeners.pointermove({clientX: 100, clientY: 0});
  for (const tick of rt.intervals) tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.length, 1);
  pad.listeners.pointermove({clientX: 150, clientY: 0});
  for (let i = 0; i < 10; i++) for (const tick of rt.intervals) tick();
  assert.equal(packets.length, 1, 'stalled write should not create queued BLE writes');
  release();
  await new Promise(resolve => setImmediate(resolve));
  for (const tick of rt.intervals) tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(packets.length, 2);
  release();
});

test('keyboard and diagnostics scripts have no WiFi coupling', () => {
  for (const f of ['app.js','keyboard.js']) {
    const src = fs.readFileSync(path.join(webDir,f),'utf8');
    assert.doesNotMatch(src,/navigator\.wifi|\bfetch\s*\(|XMLHttpRequest|WebSocket/);
  }
  const html=fs.readFileSync(path.join(webDir,'index.html'),'utf8');
  assert.ok(html.indexOf('id="keyboard-panel"') < html.indexOf('id="diagnostics-panel"'));
  assert.match(html,/<script src="keyboard\.js" defer><\/script>/);
});
