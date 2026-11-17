'use strict';
// Deterministic human-readable report. This file has no network or file I/O.
function formatTechnicalReport(data) {
  const lines = [];
  const add = line => lines.push(line === undefined ? '' : String(line));
  const val = x => {
    if (x === null || x === undefined || x === '') return 'не определено';
    if (x === true) return 'да';
    if (x === false) return 'нет';
    if (typeof x === 'string') {
      const ms = /^\/Date\((\d+)(?:[+-]\d+)?\)\/$/.exec(x);
      if (ms) return new Date(Number(ms[1])).toLocaleString('ru-RU');
    }
    if (typeof x === 'object') return x.unavailable ? 'нет доступа / запрос не поддержан' : 'не определено';
    return String(x);
  };
  const object = x => x && typeof x === 'object' && !Array.isArray(x) && !x.unavailable ? x : {};
  const array = x => Array.isArray(x) ? x : x == null || x.unavailable ? [] : [x];
  const bytes = x => typeof x === 'number' && Number.isFinite(x) ? (x / 1073741824).toFixed(2) + ' ГБ' : val(x);
  const field = (name, x) => add(name + ': ' + val(x));
  const section = (title) => { add(''); add('=== ' + title.toUpperCase() + ' ==='); };
  const item = (i, title) => add('  ' + (i + 1) + '. ' + val(title));
  const unavailable = (x, text) => {
    if (x && x.unavailable) { add(text + ': недоступно' + (x.errorType ? ' (' + x.errorType + ')' : '')); return true; }
    return false;
  };
  const details = (entries) => { for (const [name, v] of entries) add('     ' + name + ': ' + val(v)); };
  const sectionList = (title, data, makeItem) => {
    section(title);
    if (unavailable(data, 'Список')) return;
    const xs = array(data);
    if (!xs.length) { add('Записей нет / данные не получены'); return; }
    xs.forEach((v, i) => makeItem(object(v), i));
  };

  if (data.mode === 'fast') {
    const sys=object(data.system),os=object(sys.os),machine=object(sys.machine);
    const board=object(sys.mainboard),network=object(data.network),access=object(data.localAccess),sec=object(data.security);
    add('БЫСТРАЯ ИНВЕНТАРИЗАЦИЯ ПК');
    add('========================');
    field('Имя ПК',sys.computerName);
    field('Дата UTC',data.collectedAt);
    field('Windows',os.caption);
    field('Сборка',os.build);
    field('Домен',machine.domainJoined);
    field('Материнская плата',[board.manufacturer,board.product].filter(Boolean).join(' '));
    field('ОЗУ всего',bytes(machine.totalMemory));
    sectionList('Процессор',data.cpu,(r,i)=>{item(i,r.Name);details([['Ядра',r.NumberOfCores],['Потоки',r.NumberOfLogicalProcessors]]);});
    sectionList('Оперативная память',data.ram,(r,i)=>{item(i,r.DeviceLocator);details([['Объём',bytes(r.CapacityBytes)],['МГц',r.Speed]]);});
    sectionList('Накопители',data.disks,(r,i)=>{item(i,r.Model);field('Размер',bytes(r.SizeBytes));});
    sectionList('Разделы',data.volumes,(r,i)=>{item(i,r.DeviceID);details([['Размер',bytes(r.SizeBytes)],['Свободно',bytes(r.FreeBytes]]);});
    sectionList('Видеокарты',data.gpu,(r,i)=>item(i,r.Name));
    section('Физические сетевые адаптеры (MAC / IP / DNS)');
    const nics=array(network.adapters),ips=array(network.ipConfig);
    if(unavailable(network.adapters,'Сетевые карты') || unavailable(network.ipConfig,'IP/DNS')) {
      add('Проверь блок сети на ПК и уточни причину ошибки запроса.');
    }
    nics.forEach((r,i)=>{
      item(i,r.Name);
      const ip=object(ips.find(x=>x.interfaceAlias===r.Name));
      details([['Устройство',r.InterfaceDescription],['MAC',r.MacAddress],['Состояние',r.Status],
        ['IPv4',array(ip.ipv4).join(', ')||'не получен'],['Шлюз',array(ip.gateway).join(', ')||'—'],
        ['DNS',array(ip.dns).join(', ')||'—'],['DHCP',ip.dhcp],['Скорость',r.LinkSpeed]]);
    });
    section('Локальные администраторы');
    const group=object(object(access.groups).administrators);
    if (unavailable(object(access.groups).administrators,'Группа')) {}
    else array(group.members).forEach((r,i)=>item(i,r.Name||r.name));
    section('Защита');
    sectionList('Брандмауэр Windows',sec.firewall,(r,i)=>{item(i,r.Name);field('Включён',r.Enabled);});
    const defender=object(sec.defender);
    if(!unavailable(sec.defender,'Defender'))field('Защита в реальном времени',defender.RealTimeProtectionEnabled);
    add('');
    add('Только инвентаризация: тесты SSD SMART и полноценный аудит прав не проводились.');
    add('Без BLE-аутентификации не передавай секретные корпоративные сведения.');
    return lines.join('\n');
  }
  const sys = object(data.system), machine = object(sys.machine), os = object(sys.os);
  const bios = object(sys.bios), board = object(sys.mainboard);
  add('ТЕХНИЧЕСКИЙ ПАСПОРТ КОМПЬЮТЕРА');
  add('====================================');
  field('Имя ПК', sys.computerName);
  field('Время диагностики (UTC)', data.collectedAt);
  field('Версия сборщика', data.collectorVersion);
  field('Версия схемы', data.schemaVersion);
  section('Операционная система и платформа');
  field('ОС', os.caption); field('Версия', os.version); field('Сборка', os.build);
  field('Архитектура', os.architecture); field('Последняя загрузка', os.lastBoot);
  field('Изготовитель', machine.manufacturer); field('Модель', machine.model);
  field('ОЗУ всего', bytes(machine.totalMemory));
  field('В домене', machine.domainJoined);
  field('BIOS производитель', bios.manufacturer); field('BIOS версия', bios.version);
  field('BIOS дата', bios.releaseDate);
  field('Материнская плата', [board.manufacturer, board.product].filter(Boolean).join(' '));
  sectionList('Процессор', data.cpu, (c,i) => {
    item(i, c.Name);
    details([['Производитель',c.Manufacturer], ['Ядра',c.NumberOfCores],
      ['Потоки',c.NumberOfLogicalProcessors], ['Макс. частота МГц',c.MaxClockSpeed]]);
  });
  sectionList('Модули оперативной памяти', data.ram, (r,i) => {
    item(i, r.DeviceLocator);
    details([['Объём',bytes(r.CapacityBytes)],['Частота МГц',r.Speed],
      ['Производитель',r.Manufacturer],['Артикул',r.PartNumber]]);
  });
  sectionList('Накопители', data.disks, (r,i) => {
    item(i, r.Model);
    details([['Тип',r.MediaType],['Интерфейс',r.InterfaceType],['Размер',bytes(r.SizeBytes)]]);
  });
  sectionList('Дисковые разделы', data.volumes, (r,i) => {
    item(i, r.DeviceID);
    details([['Имя тома',r.VolumeName],['Файловая система',r.FileSystem],
      ['Размер',bytes(r.SizeBytes)],['Свободно',bytes(r.FreeBytes)]]);
  });
  sectionList('Видеокарты', data.gpu, (r,i) => {
    item(i, r.Name); details([['Драйвер',r.DriverVersion],['Процессор',r.VideoProcessor]]);
  });
  sectionList('Мониторы', data.monitors, (r,i) => {
    item(i, r.Name);
    details([['Производитель',r.MonitorManufacturer],['Ширина',r.ScreenWidth],['Высота',r.ScreenHeight]]);
  });
  sectionList('Сетевые адаптеры и MAC-адреса', object(data.network).adapters, (r,i) => {
    item(i, r.Name);
    details([['Устройство',r.InterfaceDescription],['MAC-адрес',r.MacAddress],
      ['Состояние',r.Status],['Физический адаптер',r.HardwareInterface],
      ['Скорость канала',r.LinkSpeed],['Индекс',r.ifIndex]]);
  });
  sectionList('IP, шлюзы и DNS', object(data.network).ipConfig, (r,i) => {
    item(i, r.interfaceAlias);
    details([['IPv4',array(r.ipv4).join(', ')||'—'],
      ['IPv6',array(r.ipv6).join(', ')||'—'],
      ['Шлюз',array(r.gateway).join(', ')||'—'],
      ['DNS',array(r.dns).join(', ')||'—'],['DHCP',r.dhcp]]);
  });
  sectionList('Профили сети', object(data.network).profiles, (r,i) => {
    item(i, r.InterfaceAlias);
    details([['Сеть',r.Name],['Категория',r.NetworkCategory],
      ['IPv4 доступ',r.IPv4Connectivity],['IPv6 доступ',r.IPv6Connectivity]]);
  });
  const access = object(data.localAccess);
  section('Локальные учётные записи');
  if (!unavailable(access.localUsers, 'Учётные записи')) {
    const accounts = array(access.localUsers);
    if (!accounts.length) add('Нет записей / недостаточно прав');
    accounts.forEach((raw,i) => {
      const u=object(raw);
      item(i,u.name);
      details([['Аккаунт включён',u.enabled],['Пароль обязателен',u.passwordRequired],
        ['Пароль последний раз задавался/менялся',u.passwordLastSet],
        ['Последний вход',u.lastLogon],['Может менять пароль',u.userMayChangePassword],
        ['SID',u.sid]]);
    });
  }
  add('Важно: «Пароль обязателен» — признак требования Windows, а НЕ проверка фактического наличия непустого пароля.');
  add('Пароли, хеши паролей и секретные ключи не собираются.');
  const groups = object(access.groups);
  for (const [key,title] of [
    ['administrators','Члены локальной группы Администраторы'],
    ['users','Члены локальной группы Пользователи'],
    ['remoteDesktopUsers','Пользователи удалённого рабочего стола'],
    ['backupOperators','Операторы архива']
  ]) {
    section(title);
    const g = groups[key];
    if (unavailable(g,'Группа')) continue;
    const gg=object(g),members=array(gg.members);
    field('Участников (учтено группой)', gg.total);
    if (!members.length) add('Членов нет / данные недоступны');
    members.forEach((raw,i)=>{const m=object(raw);item(i,m.name);
      details([['Тип',m.objectClass],['Источник',m.principalSource],['SID',m.sid]]);
    });
    if (gg.truncated) add('ВНИМАНИЕ: список ограничен по размеру');
  }
  section('Текущий сеанс Windows');
  const session = object(access.currentSession);
  field('Пользователь сеанса',session.account);
  field('Токен содержит роль администратора',session.tokenHasAdministratorsRole);
  add('Вложенные доменные группы, GPO и фактические права каждой доменной учётной записи не оцениваются.');
  section('Подключённые PnP-устройства');
  const pnp=object(data.pnp);
  if (!unavailable(data.pnp,'PnP')) {
    field('Обнаружено активных устройств',pnp.total);
    field('В отчёте',pnp.included);
    if (pnp.truncated) add('Список усечён из-за ограничения размера отчёта');
    array(pnp.devices).forEach((raw,i)=>{const d=object(raw);
      item(i,[d.class,d.name].filter(Boolean).join(' / '));
      details([['Состояние',d.status],['Код проблемы',d.problem]]);
      if (d.instanceId) add('     Идентификатор: '+val(d.instanceId));
    });
  }
  sectionList('Принтеры',data.printers,(r,i)=>{
    item(i,r.Name); details([['Драйвер',r.DriverName],['Порт',r.PortName],['Сетевой',r.Network],['По умолчанию',r.Default]]);
  });
  const sec=object(data.security);
  sectionList('Брандмауэр Windows',sec.firewall,(r,i)=>{
    item(i,r.Name);details([['Включён',r.Enabled],['Входящие',r.DefaultInboundAction],['Исходящие',r.DefaultOutboundAction]]);
  });
  section('Антивирус и защита системы');
  const defender=object(sec.defender);
  if (!unavailable(sec.defender,'Защитник Windows')){
    field('Служба Defender',defender.AMServiceEnabled);
    field('Антивирус Defender',defender.AntivirusEnabled);
    field('Защита в реальном времени',defender.RealTimeProtectionEnabled);
  }
  const avs=array(sec.antivirusProducts);
  if(unavailable(sec.antivirusProducts,'Антивирусы SecurityCenter2')) {} else if(avs.length) {
    avs.forEach((raw,i)=>{const a=object(raw); item(i,a.displayName);
      add('     Код состояния Windows Security Center: '+val(a.productState));
    });
    add('Код состояния Security Center не является прямой проверкой актуальности лицензии.');
  }
  if(!unavailable(sec.uac,'UAC')){
    const uac=object(sec.uac);
    field('UAC EnableLUA (1 = включён)',uac.EnableLUA);
    field('Подтверждение администратора',uac.ConsentPromptBehaviorAdmin);
  }
  if(!unavailable(sec.bitLocker,'BitLocker')) {
    array(sec.bitLocker).forEach((raw,i)=>{const b=object(raw);item(i,b.MountPoint);
      details([['Состояние тома',b.VolumeStatus],['Защита',b.ProtectionStatus],
        ['Шифрование',b.EncryptionMethod]]);
    });
  }
  if(!unavailable(sec.tpm,'TPM')) {
    const t=object(sec.tpm);
    field('TPM установлен',t.TpmPresent); field('TPM готов',t.TpmReady);
    field('TPM активен',t.TpmEnabled);
  }
  field('Secure Boot',sec.secureBoot);
  const sw=object(data.installedSoftware);
  section('Установленные программы (частичный список)');
  if(!unavailable(data.installedSoftware,'Установленное ПО')) {
    field('Всего записей в реестре',sw.total);
    if(sw.truncated)add('Выборка ограничена');
    array(sw.items).forEach((raw,i)=>{const a=object(raw);
      item(i,[a.DisplayName,a.DisplayVersion].filter(Boolean).join(' — '));
      add('     Издатель: '+val(a.Publisher));
    });
  }
  sectionList('Недавние обновления Windows',data.recentUpdates,(r,i)=>{
    item(i,r.HotFixID);details([['Описание',r.Description],['Установлено',r.InstalledOn]]);
  });
  const sv=object(data.autoServicesNotRunning);
  section('Автослужбы, которые сейчас не запущены');
  if(!unavailable(data.autoServicesNotRunning,'Автослужбы')) {
    field('Всего',sv.total);
    if(sv.truncated)add('Часть списка не включена');
    array(sv.items).forEach((raw,i)=>{const a=object(raw);
      item(i,a.DisplayName||a.Name);
      details([['Служба',a.Name],['Состояние',a.State],['Тип запуска',a.StartMode]]);
    });
    add('Остановленная автослужба не обязательно означает неисправность.');
  }
  sectionList('Ошибки системного журнала за 24 часа',data.systemErrors24h,(r,i)=>{
    item(i,[r.ProviderName,'ID '+val(r.Id)].join(' / '));
    details([['Время',r.TimeCreated],['Уровень',r.LevelDisplayName]]);
  });
  section('Ограничения и безопасность');
  add('Отчёт получен через локальный USB CDC и BLE; никаких TXT/JSON файлов отчёта на ПК или телефоне не создаётся.');
  add('В прошивке JSON остаётся внутренним форматом передачи и временно хранится в LittleFS для повторного получения.');
  add('Данные некоторых системных подсистем могут быть недоступны без административных прав.');
  add('Обнаружение вложенных доменных групп и действующего пароля не выполняется.');
  add('Без BLE-аутентификации данные могут быть доступны находящимся рядом устройствам. Не использовать для секретных данных.');
  return lines.join('\n');
}
