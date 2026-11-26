'use strict';
// One phone-local record per computer; does not scan the LAN or send data to GitHub.
const HW_STORAGE_KEY = 'admin-toolkit-hardware-v1';
const hwArray = v => Array.isArray(v) ? v : v && typeof v==='object' && v.unavailable ? [] : v == null ? [] : [v];
const hwObject = v => v && typeof v==='object' && !Array.isArray(v) && !v.unavailable ? v : {};
const hwString = v => typeof v==='string' && v.trim() ? v.trim() : '—';
const hwGiB = v => typeof v==='number' && Number.isFinite(v) && v>0 ? Math.round(v/1073741824*10)/10 : null;
const hwDistinct = v => [...new Set(v.filter(x=>typeof x==='string' && x && x!=='—'))];
function extractHardwareRecord(data) {
  if(data?.mode!=='hardware') throw Error('Выбери режим «Железо и IP»');
  const sys=hwObject(data.system), net=hwObject(data.network);
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
  const uuid=hwString(sys.uuid);
  const valid=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(uuid) && !/^0{8}-|^f{8}-/i.test(uuid);
  return {
    id:valid ? 'uuid:'+uuid.toLowerCase() : 'name:'+name.toLowerCase(),name,
    uuid:valid?uuid:'',collectedAt:typeof data.collectedAt==='string'?data.collectedAt:'',
    model:[hwObject(sys.machine).Manufacturer,hwObject(sys.machine).Model].filter(Boolean).join(' ')||'—',
    board:[hwObject(sys.mainboard).Manufacturer,hwObject(sys.mainboard).Product].filter(Boolean).join(' ')||'—',
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
    if(typeof report!=='undefined'&&report?.object?.mode==='hardware')addHardwareToRegistry(report.object);
  });
  renderHardwareRegistry();
}
