# Run on Windows PowerShell 5.1 (GitHub windows-smoke).
# Verify that a nonpersistent session policy permits one trusted local script,
# and that the exact original Process scope is restored even on completion.
$ErrorActionPreference = 'Stop'
$initialProcess = Get-ExecutionPolicy -Scope Process
try {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy Restricted -Force -ErrorAction Stop
    if ((Get-ExecutionPolicy) -ne 'Restricted') {
        throw 'Test setup failed: effective policy is not Restricted'
    }
    $original = Get-ExecutionPolicy -Scope Process
    $changed = $false
    $file = Join-Path $env:TEMP ('admin-toolkit-policy-test-' + [guid]::NewGuid().ToString('N') + '.ps1')
    [IO.File]::WriteAllText($file, 'Write-Output "COLLECTOR_OK"', [Text.Encoding]::ASCII)
    try {
        if ((Get-ExecutionPolicy) -eq 'Restricted') {
            if ((Get-ExecutionPolicy -Scope MachinePolicy) -ne 'Undefined' -or
                (Get-ExecutionPolicy -Scope UserPolicy) -ne 'Undefined') {
                throw 'Policy is controlled by GPO'
            }
            $changed = $true
            Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force -ErrorAction Stop
        }
        if ((Get-ExecutionPolicy) -ne 'RemoteSigned') {
            throw 'Temporary policy was not applied'
        }
        $result = & $file
        if ($result -ne 'COLLECTOR_OK') {
            throw 'Temporary local collector did not run'
        }
    }
    finally {
        if ($changed) {
            Set-ExecutionPolicy -Scope Process -ExecutionPolicy $original -Force -ErrorAction Stop
        }
        Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
    }
    if ((Get-ExecutionPolicy) -ne 'Restricted' -or (Get-ExecutionPolicy -Scope Process) -ne $original) {
        throw 'Previous process policy was not restored'
    }
    Write-Host 'PASS: local script ran, then Restricted was restored.'
}
finally {
    Set-ExecutionPolicy -Scope Process -ExecutionPolicy $initialProcess -Force -ErrorAction Stop
}

# The USB bootstrap hashes original report collector bytes in memory.
$testStream = [IO.MemoryStream]::new([Text.Encoding]::ASCII.GetBytes('abc'))
try {
    $expectedHash = 'BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD'
    $actualHash = (Get-FileHash -InputStream $testStream -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) { throw 'Windows PowerShell 5.1 SHA256 test failed' }
}
finally { $testStream.Dispose() }
