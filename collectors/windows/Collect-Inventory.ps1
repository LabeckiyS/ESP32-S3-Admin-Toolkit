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
    [string]$OutputDirectory = (Join-Path $PSScriptRoot 'reports'), # Deprecated compatibility parameter; no report files are written.
    [ValidateRange(1,500)][int]$MaxPnpDevices = 120,
    [switch]$IncludeSerialNumbers
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Capture([scriptblock]$Action) {
    try { return (& $Action) }
    catch { return @{ unavailable = $true; reason = 'Access denied, unsupported or query failed' } }
}
# All local group lookups use invariant SIDs, so they work on RU/EN Windows.
function Get-LocalAccessAudit {
    $localUsers = Capture {
        try {
            @(Get-LocalUser -ErrorAction Stop | Sort-Object Name | ForEach-Object {
                [ordered]@{
                    name = $_.Name
                    enabled = $_.Enabled
                    passwordRequired = $_.PasswordRequired
                    passwordLastSet = $_.PasswordLastSet
                    lastLogon = $_.LastLogon
                    userMayChangePassword = $_.UserMayChangePassword
                    sid = [string]$_.SID
                }
            })
        } catch {
            # 32-bit PowerShell can lack Microsoft.PowerShell.LocalAccounts.
            @(Get-CimInstance Win32_UserAccount -Filter 'LocalAccount=True' -ErrorAction Stop |
                Sort-Object Name | ForEach-Object {
                    [ordered]@{
                        name = $_.Name
                        enabled = (-not $_.Disabled)
                        passwordRequired = $_.PasswordRequired
                        passwordLastSet = $null
                        lastLogon = $null
                        userMayChangePassword = $_.PasswordChangeable
                        sid = $_.SID
                    }
                })
        }
    }
    $groups = [ordered]@{}
    foreach ($entry in @(
        @{ name='administrators'; sid='S-1-5-32-544' },
        @{ name='users'; sid='S-1-5-32-545' },
        @{ name='remoteDesktopUsers'; sid='S-1-5-32-555' },
        @{ name='backupOperators'; sid='S-1-5-32-551' }
    )) {
        $sid = $entry.sid
        $groups[$entry.name] = Capture {
            $sidObject = New-Object System.Security.Principal.SecurityIdentifier($sid)
            $members = @(Get-LocalGroupMember -SID $sidObject -ErrorAction Stop | Sort-Object Name)
            $items = @($members | Select-Object -First 40 | ForEach-Object {
                [ordered]@{
                    name = $_.Name
                    objectClass = [string]$_.ObjectClass
                    principalSource = [string]$_.PrincipalSource
                    sid = [string]$_.SID
                }
            })
            [ordered]@{ total=$members.Count; truncated=($members.Count -gt 40); members=$items }
        }
    }
    $session = Capture {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        [ordered]@{
            account = $identity.Name
            tokenHasAdministratorsRole = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        }
    }
    [ordered]@{
        localUsers = $localUsers
        groups = $groups
        currentSession = $session
        note = 'PasswordRequired is policy metadata, not proof that a nonempty password is set. Domain nested groups and effective rights are not fully resolved.'
    }
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
        $all = @(Get-PnpDevice -PresentOnly -ErrorAction Stop | Sort-Object Class, FriendlyName)
        $selected = @($all | Select-Object -First $MaxPnpDevices | ForEach-Object {
            [ordered]@{
                class = $_.Class
                name = $_.FriendlyName
                status = $_.Status
                problem = $_.Problem
                instanceId = if ($IncludeSerialNumbers) { $_.InstanceId } else { $null }
            }
        })
        [ordered]@{ total = $all.Count; included = $selected.Count; truncated = ($all.Count -gt $MaxPnpDevices); devices = $selected }
    }
    $adapters = Capture {
        @(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Select-Object -First 24 Name, InterfaceDescription, Status, MacAddress, LinkSpeed, HardwareInterface, ifIndex)
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
    # Read-only software/services/security checks: no Win32_Product MSI repair.
    $software = Capture {
        $paths = @(
            'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*',
            'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*'
        )
        $all = @(Get-ItemProperty -Path $paths -ErrorAction SilentlyContinue |
            Where-Object { -not [string]::IsNullOrWhiteSpace($_.DisplayName) } |
            Sort-Object DisplayName, DisplayVersion -Unique)
        [ordered]@{
            total=$all.Count
            truncated=($all.Count -gt 45)
            items=@($all | Select-Object -First 45 |
                Select-Object DisplayName, DisplayVersion, Publisher, InstallDate)
        }
    }
    $updates = Capture {
        @(Get-HotFix -ErrorAction Stop | Sort-Object InstalledOn -Descending |
            Select-Object -First 12 HotFixID, Description, InstalledOn)
    }
    $services = Capture {
        $all = @(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'" -ErrorAction Stop |
            Sort-Object DisplayName)
        [ordered]@{
            total=$all.Count
            truncated=($all.Count -gt 25)
            items=@($all | Select-Object -First 25 |
                Select-Object Name, DisplayName, State, StartMode)
        }
    }
    $antivirus = Capture {
        @(Get-CimInstance -Namespace 'root/SecurityCenter2' -ClassName AntivirusProduct -ErrorAction Stop |
            Select-Object displayName, productState)
    }
    $uac = Capture {
        Get-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System' -ErrorAction Stop |
            Select-Object EnableLUA, ConsentPromptBehaviorAdmin
    }
    $bitLocker = Capture {
        @(Get-BitLockerVolume -ErrorAction Stop |
            Select-Object MountPoint, VolumeStatus, ProtectionStatus, EncryptionMethod)
    }
    $tpm = Capture {
        Get-Tpm -ErrorAction Stop | Select-Object TpmPresent, TpmReady, TpmEnabled
    }
    $secureBoot = Capture { Confirm-SecureBootUEFI -ErrorAction Stop }

    $recentErrors = Capture {
        @(Get-WinEvent -FilterHashtable @{ LogName='System'; Level=1,2; StartTime=(Get-Date).AddDays(-1) } -MaxEvents 8 -ErrorAction Stop | Select-Object TimeCreated, Id, LevelDisplayName, ProviderName)
    }

    return [ordered]@{
        schemaVersion = 1
        collectorVersion = '0.3.8'
        collectedAt = (Get-Date).ToUniversalTime().ToString('o')
        system = $system
        localAccess = Get-LocalAccessAudit
        cpu = $cpu
        ram = $memory
        disks = $disks
        volumes = $volumes
        gpu = $gpu
        monitors = $monitors
        printers = $printers
        pnp = $pnp
        network = [ordered]@{ adapters = $adapters; ipConfig = $ipConfig; profiles = $profiles }
        security = [ordered]@{
            firewall = $firewall
            defender = $defender
            antivirusProducts = $antivirus
            uac = $uac
            bitLocker = $bitLocker
            tpm = $tpm
            secureBoot = $secureBoot
        }
        installedSoftware = $software
        recentUpdates = $updates
        autoServicesNotRunning = $services
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

# JSON is only an in-memory transport; no JSON/TXT report is written on Windows.
# Preserve the user/group audit and network MAC addresses when a large PnP
# or software inventory would otherwise exceed the ESP32 flash protocol cap.
foreach ($limit in @(40, 20, 10, 0)) {
    if ($bytes.Length -le 65536) { break }
    if ($inventory['pnp'] -is [System.Collections.IDictionary] -and
        $inventory['pnp']['devices'] -is [array]) {
        $inventory['pnp']['devices'] = @($inventory['pnp']['devices'] | Select-Object -First $limit)
        $inventory['pnp']['included'] = $inventory['pnp']['devices'].Count
        $inventory['pnp']['truncated'] = $true
    }
    if ($inventory['installedSoftware'] -is [System.Collections.IDictionary]) {
        $inventory['installedSoftware']['items'] = @($inventory['installedSoftware']['items'] | Select-Object -First $limit)
        $inventory['installedSoftware']['truncated'] = $true
    }
    $json = ConvertTo-Json -InputObject $inventory -Depth 8 -Compress
    $bytes = $utf8.GetBytes($json)
    $crc = Get-Crc32 $bytes
}
Write-Host ("Инвентаризация в памяти: UTF-8 {0} байт; CRC32: {1:X8}" -f $bytes.Length, $crc)
if ($bytes.Length -gt 65536) {
    throw 'Report exceeds 65536-byte firmware limit even after list reduction'
}
if ($NoTransfer) { Write-Host 'Диагностика завершена без передачи. Файлы отчётов не создаются.'; return }
if (-not $Port -and $null -eq $OpenSerial) {
    Write-Host 'Укажи COM-порт прибора: .\Collect-Inventory.ps1 -Port COM7'
    Write-Host 'Доступные порты: '
    [System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { Write-Host "  $_" }
    return
}
Send-Inventory -Bytes $bytes -Checksum $crc -ComPort $Port -ExistingSerial $OpenSerial
Write-Host 'Данные переданы на ESP32. Открой вкладку Диагностика на телефоне для копирования технического текста.'
