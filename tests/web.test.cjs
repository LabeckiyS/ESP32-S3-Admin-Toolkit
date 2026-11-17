'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
function makeRuntime() {
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {
      textContent: '', hidden: false, disabled: false, style: {}, value: '',
      children: [], classList: { toggle() {} },
      addEventListener(name, handler) { listeners.set(name, handler); },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      click() { return listeners.get('click')?.(); }
    };
  }
  const doc = {
    getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    createElement() { return element(); }
  };
  const writes = [];
  const env = {
    document: doc, navigator: {}, TextDecoder, TextEncoder, Uint8Array, DataView,
    Blob, URL: { createObjectURL() { return 'blob:mock'; }, revokeObjectURL() {} },
    setTimeout, Date, writes
  };
  vm.createContext(env);
  vm.runInContext(source, env);
  vm.runInContext('rx = {writeValueWithResponse: async payload => writes.push(new TextDecoder().decode(payload))}', env);
  const frame = bytes => ({ target: {value: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)} });
  return { env, elements, frame, send(bytes) { env.packet = frame(bytes); vm.runInContext('onFrame(packet)', env); },
    crc(bytes) { env.testData = bytes; return vm.runInContext('crc32(testData)', env); },
    get(key) { return vm.runInContext(key, env); }
  };
}

test('BLE metadata, data frames, CRC and JSON render', async () => {
  const r = makeRuntime();
  const bytes = new TextEncoder().encode(JSON.stringify({schemaVersion:1,system:{computerName:'TEST-PC',machine:{model:'Lab'},os:{caption:'Windows'}}}));
  const crc = r.crc(bytes).toString(16);
  r.send(new TextEncoder().encode(`M|${bytes.length}|${crc}`));
  for (let i = 0; i < bytes.length; i += 16) {
    const data = bytes.slice(i, i + 16);
    const index = i / 16;
    r.send(new Uint8Array([68, index & 255, index >> 8, ...data]));
  }
  r.send(new Uint8Array([69]));
  assert.equal(r.get('report.object.system.computerName'), 'TEST-PC');
  assert.equal(r.elements.get('summary').hidden, false);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(r.env.writes.includes('START'));
  assert.ok(r.env.writes.includes('A|0'));
});

test('CRC mismatch rejects report', () => {
  const r = makeRuntime();
  const bytes = new TextEncoder().encode('{"a":1}');
  r.send(new TextEncoder().encode(`M|${bytes.length}|deadbeef`));
  r.send(new Uint8Array([68,0,0,...bytes]));
  r.send(new Uint8Array([69]));
  assert.equal(r.get('report'), null);
  assert.match(r.elements.get('log').textContent, /CRC32/);
});


test('RUN button queues explicit BLE command', async () => {
  const r = makeRuntime();
  await r.get("queueCommand('RUN')");
  assert.equal(r.env.writes.at(-1), 'RUN');
  assert.ok(r.elements.has('run'));
});

test('DONE progress automatically requests report', async () => {
  const r = makeRuntime();
  r.send(new TextEncoder().encode('P|DONE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(r.env.writes.includes('GET'));
});

// No implicit host-language changes. RUN from RUS is refused locally.
test('RUS blocks diagnostic launch and never sends BLE RUN', async () => {
  const r = makeRuntime();
  r.env.document.getElementById('pc-layout').value = 'ru';
  r.get('ui()');
  assert.equal(r.elements.get('run').disabled, true);
  await r.elements.get('run').click();
  assert.equal(r.env.writes.length, 0);
  assert.match(r.elements.get('log').textContent, /вручную/);
});

test('ENG explicitly allows the diagnostic command without layout toggling', async () => {
  const r = makeRuntime();
  r.env.document.getElementById('pc-layout').value = 'en';
  r.get('ui()');
  await r.elements.get('run').click();
  assert.equal(r.env.writes.at(-1), 'RUN|EN');
  assert.ok(!r.env.writes.includes('RUN|RU'));
});

test('ESP32 rejects outdated RUN|RU commands without changing Windows language', () => {
  const r = makeRuntime();
  r.send(new TextEncoder().encode('N|ENG_REQUIRED'));
  assert.match(r.elements.get('detail').textContent, /вручную/);
});


test('BLE connection button reflects connected state and allows disconnect', () => {
  const r = makeRuntime();
  r.get("status('Подключено к AdminToolkit-S3', true)");
  assert.equal(r.elements.get('connect').textContent, 'Отключить ESP32');
  assert.equal(r.elements.get('status').textContent, 'Подключено к AdminToolkit-S3');
  r.get('disconnect()');
  assert.equal(r.elements.get('connect').textContent, 'Подключить ESP32');
  assert.equal(r.elements.get('status').textContent, 'Не подключено');
  assert.equal(r.elements.get('run').disabled, true);
});
