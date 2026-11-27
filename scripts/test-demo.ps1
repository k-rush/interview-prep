#requires -Version 7.3
param([Parameter(Mandatory)][string]$Image, [Parameter(Mandatory)][ValidatePattern('^[a-f0-9]{40}$')][string]$Commit)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$id = docker run -d --read-only --tmpfs /tmp:rw,nosuid,nodev --publish '127.0.0.1::5187' `
    --env INTERVIEW_PREP_DEMO_ONLY=1 --env INTERVIEW_PREP_PUBLIC_ORIGIN=https://demo.example.invalid $Image
try {
    $address = docker port $id '5187/tcp'
    if ($address -notmatch '^127\.0\.0\.1:\d+$') { throw 'Expected an isolated loopback port.' }
    $origin = "http://$address"
    $ready = $false
    for ($i = 0; $i -lt 30; $i++) {
        try { $ready = (Invoke-RestMethod "$origin/readyz" -TimeoutSec 2).status -eq 'ready' } catch { }
        if ($ready) { break }
        Start-Sleep -Seconds 1
    }
    if (!$ready) { throw 'The read-only demo container did not become ready.' }
    Push-Location (Join-Path $PSScriptRoot '..')
    try {
        node --input-type=module -e 'import { smoke } from "./infra/control/smoke.mjs"; console.log(await smoke(...process.argv.slice(1)))' $origin $Commit
    } finally { Pop-Location }
} finally {
    docker rm -f $id | Out-Null
}
