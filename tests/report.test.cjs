'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../web/report.js'), 'utf8');
const context = { };
vm.createContext(context);
vm.runInContext(code, context);
const format = value => vm.runInContext('formatTechnicalReport(sample)', Object.assign(context, {sample: value}));

test('Report includes network MACs and local admin membership', () => {
  const text = format({
    system: {computerName:'LAPTOP-TEST',machine:{domainJoined:false}},
    network:{adapters:[{Name:'Wi-Fi',MacAddress:'12-34-56-78-9A-BC'}]},
    localAccess:{localUsers:[{name:'operator',enabled:true,passwordRequired:false}],
      groups:{administrators:{total:1,members:[{name:'LAPTOP-TEST\\\\admin',principalSource:'Local'}]}}},
    pnp:{total:1,included:1,devices:[{name:'USB Mouse',class:'Mouse',status:'OK'}]}
  });
  for (const part of ['LAPTOP-TEST', '12-34-56-78-9A-BC',
    'operator', 'Пароль обязателен: нет', 'USB Mouse',
    'Члены локальной группы Администраторы'.toUpperCase()]) assert.ok(text.includes(part), part);
  assert.match(text,/НЕ проверка фактического наличия/);
});

test('Missing and inaccessible data are labelled, not invented', () => {
  const text = format({security:{bitLocker:{unavailable:true}},network:{},pnp:{unavailable:true}});
  assert.match(text,/нет доступа/);
  assert.match(text,/не определено/);
});
