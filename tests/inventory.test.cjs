'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const src = fs.readFileSync(path.join(__dirname,'../web/inventory.js'),'utf8');
const html = fs.readFileSync(path.join(__dirname,'../web/index.html'),'utf8');
function runtime() {
  const db = new Map();
  const elements = new Map();
  function node() {
    const listeners = new Map();
    return {
      textContent:'',children:[],hidden:false,disabled:false,
      addEventListener(type,callback){listeners.set(type,callback);},
      click(){return listeners.get('click')?.();},
      append(...nodes){this.children.push(...nodes);},
      replaceChildren(...nodes){this.children = nodes;},
      remove(){},type:''
    };
  }
  const document = {
    body:node(),
    getElementById(id){if(!elements.has(id))elements.set(id,node());return elements.get(id);},
    createElement(){return node();}
  };
  const localStorage = {
    getItem(k){return db.get(k) ?? null;},
    setItem(k,v){db.set(k,v);}
  };
  const env={document,localStorage,console,Blob,TextEncoder,Uint8Array,DataView,
    Date,Map,Set,confirm:()=>true,
    setTimeout:()=>0,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}}
  };
  vm.createContext(env);
  vm.runInContext(src,env);
  return {env,db,elements,execute:(code)=>vm.runInContext(code,env)};
}
const sample=(name='RUSAGRO-0042',ip='192.168.80.81',date='2026-11-26T11:00:00Z')=>({
  mode:'hardware',collectedAt:date,
  system:{computerName:name,uuid:'763ef750-3222-4333-a922-abcdef777777',
    machine:{Manufacturer:'ASUS',Model:'All Series'},mainboard:{Manufacturer:'ASUS',Product:'H81M-K'}},
  cpu:[{Name:'Intel Pentium G3240',NumberOfCores:2,NumberOfLogicalProcessors:2}],
  ram:[{DeviceLocator:'ChannelA-DIMM0',MemoryType:'DDR3',CapacityBytes:8589934592,Speed:1600}],
  disks:[{Model:'Seagate ST1000DM003',DiskType:'HDD',BusType:'SATA',SizeBytes:1000204886016}],
  network:{adapters:[{Name:'Ethernet',MacAddress:'38-D5-47-21-FD-35',Status:'Up',InterfaceDescription:'Realtek GBE'},
    {Name:'Ethernet 2',MacAddress:'11-22-33-44-55-66',Status:'Disconnected',InterfaceDescription:'USB LAN'}],
    ipConfig:[{interfaceAlias:'Ethernet',ipv4:[ip]},{interfaceAlias:'Ethernet 2',ipv4:[]}]}
});
test('Hardware mode has a visible scan option and local Excel actions',()=>{
  assert.match(html,/value="hardware" selected/);
  assert.match(html,/id="registry-export"/);
  assert.match(html,/id="registry-rows"/);
  assert.match(html,/src="inventory.js/);
});
test('One record per physical computer, updating IP rather than adding a duplicate',()=>{
  const r=runtime();
  r.env.testData=sample();
  assert.equal(r.execute('addHardwareToRegistry(testData)'),true);
  assert.equal(r.execute('hardwareRegistry.length'),1);
  assert.equal(r.execute('hardwareRegistry[0].memory[0].type'),'DDR3');
  assert.equal(r.execute('hardwareRegistry[0].disks[0].type'),'HDD');
  assert.equal(r.execute('hwSummary(hardwareRegistry[0]).ipv4'),'192.168.80.81');
  r.env.testData=sample('RUSAGRO-0042','192.168.80.99','2026-11-26T12:00:00Z');
  r.execute('addHardwareToRegistry(testData)');
  assert.equal(r.execute('hardwareRegistry.length'),1);
  assert.equal(r.execute('hwSummary(hardwareRegistry[0]).ipv4'),'192.168.80.99');
  assert.ok(r.db.has('admin-toolkit-hardware-v1'));
  assert.equal(r.elements.get('registry-rows').children.length,1);
});
test('Old inventory never replaces newer reading',()=>{
  const r=runtime();
  r.env.testData=sample('PC','192.168.2.25','2026-11-26T13:00:00Z');
  r.execute('addHardwareToRegistry(testData)');
  r.env.testData=sample('PC','192.168.2.20','2026-11-26T12:00:00Z');
  assert.equal(r.execute('addHardwareToRegistry(testData)'),false);
  assert.equal(r.execute('hwSummary(hardwareRegistry[0]).ipv4'),'192.168.2.25');
});
test('Normal fast/full report cannot be mistaken for hardware inventory',()=>{
  const r=runtime();
  r.env.testData={mode:'full',system:{computerName:'PC'}};
  assert.equal(r.execute('addHardwareToRegistry(testData)'),false);
  assert.equal(r.execute('hardwareRegistry.length'),0);
});
test('Generated XLSX contains five ZIP worksheets, RAM, disks and IP text',async()=>{
  const r=runtime();
  r.env.testData=sample();
  r.execute('addHardwareToRegistry(testData)');
  const blob=r.execute('hardwareWorkbookBlob()');
  assert.equal(blob.type,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const buffer=new Uint8Array(await blob.arrayBuffer());
  const v=new DataView(buffer.buffer);
  assert.equal(v.getUint32(0,true),0x04034b50);
  let i=0;const entries=new Map();
  while(i+30<buffer.length && v.getUint32(i,true)===0x04034b50){
    const size=v.getUint32(i+18,true),n=v.getUint16(i+26,true),extra=v.getUint16(i+28,true);
    const name=new TextDecoder().decode(buffer.slice(i+30,i+30+n));
    const data=buffer.slice(i+30+n+extra,i+30+n+extra+size);
    entries.set(name,new TextDecoder().decode(data));
    i+=30+n+extra+size;
  }
  assert.equal(entries.size,10);
  assert.ok(entries.has('xl/workbook.xml'));
  assert.ok(entries.has('xl/worksheets/sheet5.xml'));
  assert.match(entries.get('xl/workbook.xml'),/Компьютеры/);
  assert.match(entries.get('xl/worksheets/sheet2.xml'),/RUSAGRO-0042/);
  assert.match(entries.get('xl/worksheets/sheet3.xml'),/DDR3/);
  assert.match(entries.get('xl/worksheets/sheet4.xml'),/Seagate ST1000DM003/);
  assert.match(entries.get('xl/worksheets/sheet5.xml'),/192.168.80.81/);
  assert.equal(v.getUint32(buffer.length-22,true),0x06054b50);
});
