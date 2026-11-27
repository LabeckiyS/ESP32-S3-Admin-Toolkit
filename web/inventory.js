'use strict';
// One phone-local record per computer; does not scan the LAN or send data to GitHub.
const HW_STORAGE_KEY = 'admin-toolkit-hardware-v1';
const hwArray = v => Array.isArray(v) ? v : v && typeof v==='object' && v.unavailable ? [] : v == null ? [] : [v];
const hwObject = v => v && typeof v==='object' && !Array.isArray(v) && !v.unavailable ? v : {};
const hwString = v => typeof v==='string' && v.trim() ? v.trim() : '—';
const hwGiB = v => typeof v==='number' && Number.isFinite(v) && v>0 ? Math.round(v/1073741824*10)/10 : null;
const hwDistinct = v => [...new Set(v.filter(x=>typeof x==='string' && x && x!=='—'))];
function extractHardwareRecord(data) {
  if(!['fast','full','hardware'].includes(data?.mode)) throw Error('Неизвестный формат диагностического отчёта');
  const sys=hwObject(data.system), net=hwObject(data.network);
  const sysModel=hwObject(sys.machine), sysBoard=hwObject(sys.mainboard);
  const name=hwString(sys.computerName);
  if(name==='—') throw Error('Не получено имя компьютера');
  const memory=hwArray(data.ram).map(hwObject).filter(x=>Number(x.CapacityBytes)>0).map(x=>({
    slot:hwString(x.DeviceLocator),type:hwString(x.MemoryType),
    gib:hwGiB(Number(x.CapacityBytes)),mhz:Number(x.Speed)||null
  }));
  const cpu=hwArray(data.cpu).map(hwObject).filter(x=>x.Name).map(x=>({
    name:hwString(x.Name),cores:Number(x.NumberOfCores)||null,threads:Number(x.NumberOfLogicalProcessors)||null
  }));
  const disks=hwArray(data.disks).map(hwObject).filter(x=>Number(x.SizeBytes)>0).map(x=>({
    model:hwString(x.Model),type:hwString(x.DiskType),bus:hwString(x.BusType),
    gib:hwGiB(Number(x.SizeBytes))
  }));
  const cfg=hwArray(net.ipConfig);
  const adapters=hwArray(net.adapters).map(hwObject).filter(x=>x.Name || x.MacAddress).map(x=>({
    name:hwString(x.Name),description:hwString(x.InterfaceDescription),
    mac:hwString(x.MacAddress),status:hwString(x.Status),
    ipv4:hwDistinct(hwArray(hwObject(cfg.find(c=>hwObject(c).interfaceAlias===x.Name)).ipv4))
  }));
  if(!cpu.length && !memory.length && !disks.length) throw Error('Отчёт не содержит сведений об оборудовании');
  const uuid=hwString(sys.uuid);
  const valid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid) && !/^0{8}-|^f{8}-/i.test(uuid);
  return {
    id:valid ? 'uuid:'+uuid.toLowerCase() : 'name:'+name.toLowerCase(),name,
    uuid:valid?uuid:'',collectedAt:typeof data.collectedAt==='string'?data.collectedAt:'',
    model:[sysModel.manufacturer || sysModel.Manufacturer,sysModel.model || sysModel.Model].filter(Boolean).join(' ')||'—',
    board:[sysBoard.manufacturer || sysBoard.Manufacturer,sysBoard.product || sysBoard.Product].filter(Boolean).join(' ')||'—',
    cpu,memory,disks,adapters
  };
}
function hwLoad() {
  try {
    const value=JSON.parse(localStorage.getItem(HW_STORAGE_KEY)||'[]');
    return Array.isArray(value)?value.filter(x=>x&&typeof x.name==='string'&&Array.isArray(x.disks)).slice(0,300):[];
  }catch{return [];}
}
let hardwareRegistry=hwLoad();
function hwStatus(value) {
  const el=document.getElementById('registry-status');
  if(el) el.textContent=value;
}
function hwSave() {
  try{localStorage.setItem(HW_STORAGE_KEY,JSON.stringify(hardwareRegistry));return true;}
  catch{hwStatus('Не удалось сохранить данные в памяти браузера.');return false;}
}
function hwSummary(r) {
  const ram=r.memory.map(x=>(x.gib??'—')+' ГиБ '+x.type+(x.mhz?' '+x.mhz+' МГц':'')).join('; ')||'—';
  const disks=r.disks.map(x=>x.model+': '+x.type+', '+(x.gib??'—')+' ГиБ').join('; ')||'—';
  const ipv4=hwDistinct(r.adapters.filter(x=>x.status.toLowerCase()==='up').flatMap(x=>x.ipv4)).join(', ')||'—';
  const mac=hwDistinct(r.adapters.map(x=>x.mac)).join(', ')||'—';
  return {cpu:r.cpu.map(x=>x.name).join(' / ')||'—',ram,disks,ipv4,mac};
}
function renderHardwareRegistry() {
  const tbody=document.getElementById('registry-rows'),count=document.getElementById('registry-count');
  if(!tbody||!count)return;
  count.textContent='В реестре: '+hardwareRegistry.length+' ПК';
  tbody.replaceChildren();
  for(const r of [...hardwareRegistry].sort((a,b)=>a.name.localeCompare(b.name,'ru'))){
    const row=document.createElement('tr'),s=hwSummary(r);
    const date=Date.parse(r.collectedAt);
    const stamp=Number.isFinite(date)?new Date(date).toLocaleString('ru-RU'):'—';
    for(const value of [r.name,s.cpu,s.ram,s.disks,s.ipv4,s.mac,stamp]){
      const cell=document.createElement('td');cell.textContent=value;row.append(cell);
    }
    const cell=document.createElement('td'),del=document.createElement('button');
    del.type='button';del.className='secondary';del.textContent='Удалить';
    del.addEventListener('click',()=>{hardwareRegistry=hardwareRegistry.filter(x=>x.id!==r.id);hwSave();renderHardwareRegistry();});
    cell.append(del);row.append(cell);tbody.append(row);
  }
}
function addHardwareToRegistry(data){
  let item;
  try{item=extractHardwareRecord(data);}catch(error){hwStatus(error.message);return false;}
  const idx=hardwareRegistry.findIndex(x=>x.id===item.id||x.name.toLowerCase()===item.name.toLowerCase());
  if(idx>=0){
    const older=Date.parse(item.collectedAt),newer=Date.parse(hardwareRegistry[idx].collectedAt);
    if(Number.isFinite(older)&&Number.isFinite(newer)&&older<newer){
      hwStatus('Старый отчёт не заменил новую запись '+item.name);return false;
    }
    hardwareRegistry[idx]=item;
  }else{
    if(hardwareRegistry.length>=300){hwStatus('Лимит 300 ПК. Сначала выгрузи Excel.');return false;}
    hardwareRegistry.push(item);
  }
  const ok=hwSave();renderHardwareRegistry();
  if(ok)hwStatus('Сохранён '+item.name+'. Всего компьютеров: '+hardwareRegistry.length+'.');
  return ok;
}
function hwSetup(){
  document.getElementById('registry-export')?.addEventListener('click',downloadHardwareWorkbook);
  document.getElementById('registry-clear')?.addEventListener('click',()=>{
    if(!hardwareRegistry.length)return;
    if(confirm('Удалить все компьютеры из реестра на этом телефоне?')){
      hardwareRegistry=[];hwSave();renderHardwareRegistry();hwStatus('Реестр очищен.');
    }
  });
  document.getElementById('add-to-registry')?.addEventListener('click',()=>{
    if(typeof report!=='undefined'&&['fast','full','hardware'].includes(report?.object?.mode))addHardwareToRegistry(report.object);
  });
  renderHardwareRegistry();
}

// Browser-generated real XLSX: five XML worksheets in a standards-compliant ZIP.
const HW_XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const HW_X='<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function hwEscape(x){return String(x==null?'':x).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g,'');}
function hwCol(n){let s='';for(n++;n;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
function hwWorksheet(rows){
  const size=Math.max(1,...rows.map(r=>r.length));
  const cols=Array.from({length:size},(_,i)=>{
    const length=Math.max(0,...rows.slice(0,30).map(r=>String(r[i]??'').length));
    const width=i===0?22:Math.min(45,Math.max(15,length+3));
    return '<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+width+'" customWidth="1"/>';
  }).join('');
  const content=rows.map((row,i)=>'<row r="'+(i+1)+'">'+row.map((v,j)=>{
    if(v===undefined||v===null||v==='')return '';
    const attr=' r="'+hwCol(j)+(i+1)+'"'+(i===0?' s="1"':'');
    if(typeof v==='number'&&Number.isFinite(v))return '<c'+attr+'><v>'+v+'</v></c>';
    return '<c'+attr+' t="inlineStr"><is><t xml:space="preserve">'+hwEscape(v)+'</t></is></c>';
  }).join('')+'</row>').join('');
  return HW_X+'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'+
    '<cols>'+cols+'</cols><sheetData>'+content+'</sheetData><autoFilter ref="A1:'+hwCol(size-1)+Math.max(1,rows.length)+'"/></worksheet>';
}
function hwCrc32(bytes){
  let c=0xFFFFFFFF;for(const b of bytes){c^=b;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xEDB88320:0);}
  return (c^0xFFFFFFFF)>>>0;
}
function hwZip(entries){
  const e=new TextEncoder(),chunks=[],central=[];let pos=0,total=0;
  for(const [path,source] of entries){
    const name=e.encode(path),data=e.encode(source),crc=hwCrc32(data);
    const local=new Uint8Array(30+name.length+data.length),d=new DataView(local.buffer);
    d.setUint32(0,0x04034b50,true);d.setUint16(4,20,true);
    d.setUint32(14,crc,true);d.setUint32(18,data.length,true);d.setUint32(22,data.length,true);
    d.setUint16(26,name.length,true);local.set(name,30);local.set(data,30+name.length);
    const cd=new Uint8Array(46+name.length),v=new DataView(cd.buffer);
    v.setUint32(0,0x02014b50,true);v.setUint16(4,20,true);v.setUint16(6,20,true);
    v.setUint32(16,crc,true);v.setUint32(20,data.length,true);v.setUint32(24,data.length,true);
    v.setUint16(28,name.length,true);v.setUint32(42,pos,true);cd.set(name,46);
    chunks.push(local);central.push(cd);pos+=local.length;total+=cd.length;
  }
  const end=new Uint8Array(22),dv=new DataView(end.buffer);
  dv.setUint32(0,0x06054b50,true);dv.setUint16(8,entries.length,true);dv.setUint16(10,entries.length,true);
  dv.setUint32(12,total,true);dv.setUint32(16,pos,true);
  return new Blob([...chunks,...central,end],{type:HW_XLSX_MIME});
}
function hardwareWorkbookBlob(records=hardwareRegistry){
  const sorted=[...records].sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  const pc=[['№','Имя ПК','Модель ПК','Материнская плата','Процессор','Ядер','Потоков','ОЗУ, ГиБ','Планок ОЗУ','Типы ОЗУ','Дисков','Типы и модели дисков','Активные IPv4','MAC физических адаптеров','Дата диагностики UTC']];
  const ram=[['Имя ПК','Слот','Тип','Объём, ГиБ','Частота, МГц']];
  const disks=[['Имя ПК','№','Модель','Тип','Интерфейс','Объём, ГиБ']];
  const network=[['Имя ПК','Адаптер','Устройство','MAC','Состояние','IPv4']];
  const cpuCounts=new Map(),memoryCounts=new Map(),diskCounts=new Map();
  sorted.forEach((r,i)=>{
    const s=hwSummary(r),cpu=r.cpu[0]||{},ramTotal=r.memory.length?r.memory.reduce((a,m)=>a+(m.gib||0),0):null;
    pc.push([i+1,r.name,r.model,r.board,s.cpu,cpu.cores??'',cpu.threads??'',ramTotal==null?'':Math.round(ramTotal*10)/10,
      r.memory.length,[...new Set(r.memory.map(m=>m.type))].join(', ')||'—',r.disks.length,s.disks,s.ipv4,s.mac,r.collectedAt]);
    for(const m of r.memory){ram.push([r.name,m.slot,m.type,m.gib??'',m.mhz??'']);memoryCounts.set(m.type,(memoryCounts.get(m.type)||0)+1);}
    r.disks.forEach((d,j)=>{disks.push([r.name,j+1,d.model,d.type,d.bus,d.gib??'']);diskCounts.set(d.type,(diskCounts.get(d.type)||0)+1);});
    for(const a of r.adapters)network.push([r.name,a.name,a.description,a.mac,a.status,a.ipv4.join(', ')||'—']);
    const model=cpu.name||'Не определён';cpuCounts.set(model,(cpuCounts.get(model)||0)+1);
  });
  const summary=[['Показатель','Количество'],['Компьютеров',sorted.length],['Модулей ОЗУ',ram.length-1],['Физических дисков',disks.length-1],[],
    ['Модель процессора','ПК'],...Array.from(cpuCounts).sort((a,b)=>a[0].localeCompare(b[0],'ru')),[],
    ['Тип ОЗУ','Модулей'],...Array.from(memoryCounts).sort((a,b)=>a[0].localeCompare(b[0],'ru')),[],
    ['Тип диска','Штук'],...Array.from(diskCounts).sort((a,b)=>a[0].localeCompare(b[0],'ru'))];
  const sheets=[['Сводка',summary],['Компьютеры',pc],['ОЗУ',ram],['Диски',disks],['Сеть',network]];
  const ns='http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel='http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const wb=HW_X+'<workbook xmlns="'+ns+'" xmlns:r="'+rel+'"><sheets>'+sheets.map((x,i)=>
    '<sheet name="'+hwEscape(x[0])+'" sheetId="'+(i+1)+'" r:id="rId'+(i+1)+'"/>').join('')+'</sheets></workbook>';
  const wbRels=HW_X+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'+
    sheets.map((_,i)=>'<Relationship Id="rId'+(i+1)+'" Type="'+rel+'/worksheet" Target="worksheets/sheet'+(i+1)+'.xml"/>').join('')+
    '<Relationship Id="rId'+(sheets.length+1)+'" Type="'+rel+'/styles" Target="styles.xml"/></Relationships>';
  const ct=HW_X+'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'+
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'+
    '<Default Extension="xml" ContentType="application/xml"/>'+
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'+
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'+
    sheets.map((_,i)=>'<Override PartName="/xl/worksheets/sheet'+(i+1)+'.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>').join('')+'</Types>';
  const styles=HW_X+'<styleSheet xmlns="'+ns+'"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>'+
    '<font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts>'+
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'+
    '<fill><patternFill patternType="solid"><fgColor rgb="FF214F75"/></patternFill></fill></fills>'+
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'+
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'+
    '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'+
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs></styleSheet>';
  return hwZip([['[Content_Types].xml',ct],
    ['_rels/.rels',HW_X+'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="'+rel+'/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml',wb],['xl/_rels/workbook.xml.rels',wbRels],['xl/styles.xml',styles],
    ...sheets.map((x,i)=>['xl/worksheets/sheet'+(i+1)+'.xml',hwWorksheet(x[1])])]);
}
function downloadHardwareWorkbook(){
  if(!hardwareRegistry.length){hwStatus('Реестр пуст. Сначала проверь компьютеры.');return;}
  const blob=hardwareWorkbookBlob(),url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download='Reestr_PK_Zhelezo_IP_'+new Date().toISOString().slice(0,10)+'.xlsx';
  document.body.append(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),3000);
  hwStatus('Excel выгружен: '+hardwareRegistry.length+' ПК.');
}
hwSetup();
