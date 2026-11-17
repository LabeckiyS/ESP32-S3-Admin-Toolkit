#requires -Version 5.1
<#
.SYNOPSIS
 Read-only Windows hardware inventory for ESP32-S3 Admin Toolkit.
.EXAMPLE
 .\Collect-Inventory.ps1 -NoTransfer
 .\Collect-Inventory.ps1 -Port COM7
.NOTES
 No elevation, execution-policy bypass, network upload or credential collection.
 The operator explicitly invokes this script in a trusted Windows session.
#>
[CmdletBinding()]
param(
    [ValidatePattern('^COM[0-9]+$')][string]$Port,
    [System.IO.Ports.SerialPort]$OpenSerial,
    [switch]$NoTransfer,
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'reports'),
    [ValidateRange(1,500)][int]$MaxPnpDevices = 120,
    [switch]$IncludeSerialNumbers
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Capture([scriptblock]$Action) {
    try { return (& $Action) }
    catch { return @{ unavailable = $true; reason = 'Access denied, unsupported or query failed' } }
}
function Get-Inventory {
    $os = Capture { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
    $cs = Capture { Get-CimInstance Win32_ComputerSystem -ErrorAction Stop }
    $bios = Capture { Get-CimInstance Win32_BIOS -ErrorAction Stop }
    $board = Capture { Get-CimInstance Win32_BaseBoard -ErrorAction Stop }

    $system = [ordered]@{
        computerName = $env:COMPUTERNAME
        os = if ($os -is [Microsoft.Management.Infrastructure.CimInstance]) {
            [ordered]@{ caption = $os.Caption; version = $os.Version; build = $os.BuildNumber; architecture = $os.OSArchitecture; lastBoot = $os.LastBootUpTime }
        } else { $os }
        machine = if ($cs -is [Microsoft.Management.Infrastructure.CimInstance]) {
            [ordered]@{ manufacturer = $cs.Manufacturer; model = $cs.Model; domainJoined = $cs.PartOfDomain; totalMemory = [int64]$cs.TotalPhysicalMemory }
        } else { $cs }
        bios = if ($bios -is [Microsoft.Management.Infrastructure.CimInstance]) {
            $result = [ordered]@{ manufacturer = $bios.Manufacturer; version = $bios.SMBIOSBIOSVersion; releaseDate = $bios.ReleaseDate }
            if ($IncludeSerialNumbers) { $result['serialNumber'] = $bios.SerialNumber }
            $result
        } else { $bios }
        mainboard = if ($board -is [Microsoft.Management.Infrastructure.CimInstance]) {
            $result = [ordered]@{ manufacturer = $board.Manufacturer; product = $board.Product }
            if ($IncludeSerialNumbers) { $result['serialNumber'] = $board.SerialNumber }
            $result
        } else { $board }
    }

    $cpu = Capture {
        @(Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object Name, Manufacturer, NumberOfCores, NumberOfLogicalProcessors, MaxClockSpeed)
    }
    $memory = Capture {
        @(Get-CimInstance Win32_PhysicalMemory -ErrorAction Stop | Select-Object DeviceLocator, @{N='CapacityBytes';E={[int64]$_.Capacity}}, Speed, Manufacturer, PartNumber)
    }
    $disks = Capture {
        @(Get-CimInstance Win32_DiskDrive -ErrorAction Stop | Select-Object Model, InterfaceType, MediaType, @{N='SizeBytes';E={[int64]$_.Size}})
    }
    $volumes = Capture {
        @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' -ErrorAction Stop | Select-Object DeviceID, FileSystem, VolumeName, @{N='SizeBytes';E={[int64]$_.Size}}, @{N='FreeBytes';E={[int64]$_.FreeSpace}})
    }
    $gpu = Capture {
        @(Get-CimInstance Win32_VideoController -ErrorAction Stop | Select-Object Name, DriverVersion, VideoProcessor)
    }
    $monitors = Capture {
        @(Get-CimInstance Win32_DesktopMonitor -ErrorAction Stop | Select-Object Name, MonitorManufacturer, ScreenWidth, ScreenHeight)
    }
    $printers = Capture {
        @(Get-CimInstance Win32_Printer -ErrorAction Stop | Select-Object Name, DriverName, PortName, Network, Default)
    }
    $pnp = Capture {
        $all = @(Get-PnpDevice -ErrorAction Stop | Sort-Object Class, FriendlyName)
        $selected = @($all | Select-Object -First $MaxPnpDevices | ForEach-Object {
            [ordered]@{ class = $_.Class; name = $_.FriendlyName; status = $_.Status }
        })
        [ordered]@{ total = $all.Count; included = $selected.Count; truncated = ($all.Count -gt $MaxPnpDevices); devices = $selected }
    }
    $adapters = Capture {
        @(Get-NetAdapter -ErrorAction Stop | Select-Object Name, InterfaceDescription, Status, MacAddress, LinkSpeed)
    }
    $ipConfig = Capture {
        @(Get-NetIPConfiguration -ErrorAction Stop | ForEach-Object {
            [ordered]@{
                interfaceAlias = $_.InterfaceAlias
                ipv4 = @($_.IPv4Address | ForEach-Object IPAddress)
                ipv6 = @($_.IPv6Address | ForEach-Object IPAddress)
                gateway = @($_.IPv4DefaultGateway | ForEach-Object NextHop)
                dns = if ($null -ne $_.DNSServer) { @($_.DNSServer.ServerAddresses) } else { @() }
            }
        })
    }
    $profiles = Capture {
        @(Get-NetConnectionProfile -ErrorAction Stop | Select-Object InterfaceAlias, Name, NetworkCategory, IPv4Connectivity, IPv6Connectivity)
    }
    $firewall = Capture {
        @(Get-NetFirewallProfile -ErrorAction Stop | Select-Object Name, Enabled, DefaultInboundAction, DefaultOutboundAction)
    }
    $defender = Capture {
        Get-MpComputerStatus -ErrorAction Stop | Select-Object AMServiceEnabled, AntivirusEnabled, RealTimeProtectionEnabled
    }
    $recentErrors = Capture {
        @(Get-WinEvent -FilterHashtable @{ LogName='System'; Level=1,2; StartTime=(Get-Date).AddDays(-1) } -MaxEvents 8 -ErrorAction Stop | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName)
    }

    return [ordered]@{
        schemaVersion = 1
        collectorVersion = '0.1.0'
        collectedAt = (Get-Date).ToUniversalTime().ToString('o')
        system = $system
        cpu = $cpu
        ram = $memory
        disks = $disks
        volumes = $volumes
        gpu = $gpu
        monitors = $monitors
        printers = $printers
        pnp = $pnp
        network = [ordered]@{ adapters = $adapters; ipConfig = $ipConfig; profiles = $profiles }
        security = [ordered]@{ firewall = $firewall; defender = $defender }
        systemErrors24h = $recentErrors
    }
}

function Get-Crc32([byte[]]$Bytes) {
    [uint32]$crc = [uint32]::MaxValue
    [uint32]$polynomial = 3988292384
    foreach ($byte in $Bytes) {
        $crc = [uint32]($crc -bxor [uint32]$byte)
        for ($bit=0; $bit -lt 8; $bit++) {
            if (($crc -band [uint32]1) -ne 0) {
                $crc = [uint32](($crc -shr 1) -bxor $polynomial)
            } else {
                $crc = [uint32]($crc -shr 1)
            }
        }
    }
    return [uint32]($crc -bxor [uint32]::MaxValue)
}
function Receive-Reply([System.IO.Ports.SerialPort]$Serial, [string]$Expected) {
    # Ignore delayed duplicate ACKs from a previous USB retry.
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        $response = $Serial.ReadLine().Trim()
        if ($response -like 'ERR|*') { throw "Устройство вернуло ошибку: $response" }
        if ($response.StartsWith($Expected, [StringComparison]::Ordinal)) {
            return $response
        }
        if ($response -match '^ACK\|[0-9]+$') { continue }
        throw "Неожиданный ответ устройства: $response (ожидалось $Expected)"
    }
    throw "От ESP32 не поступило ожидаемое подтверждение $Expected"
}
function Send-Inventory([byte[]]$Bytes, [uint32]$Checksum, [string]$ComPort, [System.IO.Ports.SerialPort]$ExistingSerial) {
    # The bootstrap passes its already-open USB CDC handle. Reopening the
    # serial device after downloading the script can lose the Windows COM port.
    $ownsPort = ($null -eq $ExistingSerial)
    if ($ownsPort) {
        $serial = [System.IO.Ports.SerialPort]::new($ComPort, 115200, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
    } else {
        $serial = $ExistingSerial
        if (-not $serial.IsOpen) { throw 'Existing USB CDC handle is closed' }
    }
    $serial.NewLine = "`n"
    $serial.ReadTimeout = 3500
    $serial.WriteTimeout = 3500
    try {
        if ($ownsPort) {
            $serial.DtrEnable = $false
            $serial.RtsEnable = $false
            $serial.Open()
            Start-Sleep -Milliseconds 800
        }
        $serial.DiscardInBuffer()
        $serial.WriteLine('PING')
        [void](Receive-Reply $serial 'PONG|')
        $serial.WriteLine(('BEGIN|{0}|{1:X8}' -f $Bytes.Length, $Checksum))
        [void](Receive-Reply $serial 'READY')
        $seq = 0
        for ($offset = 0; $offset -lt $Bytes.Length; $offset += 64) {
            $len = [Math]::Min(64, $Bytes.Length - $offset)
            $part = New-Object byte[] $len
            [Array]::Copy($Bytes, $offset, $part, 0, $len)
            $hex = [BitConverter]::ToString($part).Replace('-', '')
            $command = "DATA|$seq|$hex"
            $serial.WriteLine($command)
            $expected = "ACK|$seq"
            try { [void](Receive-Reply $serial $expected) }
            catch {
                # Re-send the same block once. Firmware recognizes duplicate sequence.
                $serial.WriteLine($command)
                [void](Receive-Reply $serial $expected)
            }
            $seq++
        }
        $serial.WriteLine('END')
        [void](Receive-Reply $serial 'DONE|')
    }
    finally {
        if ($ownsPort) {
            if ($serial.IsOpen) { $serial.Close() }
            $serial.Dispose()
        }
    }
}

$inventory = Get-Inventory
$json = ConvertTo-Json -InputObject $inventory -Depth 8 -Compress
$utf8 = New-Object System.Text.UTF8Encoding($false)
$bytes = $utf8.GetBytes($json)
$crc = Get-Crc32 $bytes

if (-not (Test-Path -LiteralPath $OutputDirectory)) {
    [void](New-Item -ItemType Directory -Path $OutputDirectory -Force)
}
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$name = [regex]::Replace($env:COMPUTERNAME, '[^a-zA-Z0-9_-]', '_')
$jsonPath = Join-Path $OutputDirectory ("{0}-{1}.json" -f $name,$stamp)
$txtPath = Join-Path $OutputDirectory ("{0}-{1}.txt" -f $name,$stamp)
[System.IO.File]::WriteAllBytes($jsonPath, $bytes)
$pretty = ConvertTo-Json -InputObject $inventory -Depth 8
[System.IO.File]::WriteAllText($txtPath, $pretty, $utf8)
Write-Host "Отчёты: $jsonPath / $txtPath"
Write-Host ("UTF-8: {0} байт; CRC32: {1:X8}" -f $bytes.Length, $crc)
if ($bytes.Length -gt 65536) {
    Write-Warning 'Отчёт превышает лимит v0.1 (65536 байт); файлы сохранены локально, передачи USB не будет.'
    return
}
if ($NoTransfer) { Write-Host 'Диагностика завершена без передачи (режим -NoTransfer).'; return }
if (-not $Port -and $null -eq $OpenSerial) {
    Write-Host 'Укажи COM-порт прибора: .\Collect-Inventory.ps1 -Port COM7'
    Write-Host 'Доступные порты: '
    [System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { Write-Host "  $_" }
    return
}
Send-Inventory -Bytes $bytes -Checksum $crc -ComPort $Port -ExistingSerial $OpenSerial
Write-Host 'Отчёт успешно передан на ESP32. Теперь подключись в BLE-панели телефона и нажми «Получить отчёт».'
