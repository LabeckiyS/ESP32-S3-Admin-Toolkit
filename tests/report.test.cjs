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

test('Fast report omits phantom volumes and never renders network objects as strings', () => {
  const text = format({
    mode:'fast',
    system: {computerName:'TEST-PC',os:{caption:'Windows 11'},machine:{totalMemory:17179869184}},
    network: {
      adapters:[
        {Name:'Ethernet',MacAddress:'11-22-33-44-55-66',Status:'Disconnected'},
        {Name:'Wi-Fi',MacAddress:'AA-BB-CC-DD-EE-FF',Status:'Up'}
      ],
      ipConfig:[
        {interfaceAlias:'Ethernet',ipv4:[{unavailable:true}],gateway:[{unavailable:true}],dns:[{unavailable:true}]},
        {interfaceAlias:'Wi-Fi',ipv4:['192.168.2.41'],gateway:['192.168.2.1'],dns:['192.168.2.1'],dhcp:true}
      ]
    },
    volumes:[{DeviceID:'C:',SizeBytes:1073741824,FreeBytes:536870912},{DeviceID:'E:',SizeBytes:0,FreeBytes:0}],
    security:{firewall:[{Name:'Domain',Enabled:1},{Name:'Public',Enabled:0}]}
  });
  assert.doesNotMatch(text, /\\[object Object\\]/);
  assert.match(text, /192\\.168\\.2\\.41/);
  assert.match(text, /AA-BB-CC-DD-EE-FF/);
  assert.doesNotMatch(text, /E:/);
  assert.match(text, /Включён: да/);
  assert.match(text, /Включён: нет/);
  assert.match(text, /Антивирус: не проверяется в быстром режиме/);
});
