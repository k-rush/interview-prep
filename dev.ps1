#requires -Version 7.3
param(
    [ValidateSet('up', 'test', 'eval')][string]$Command = 'up',
    [string]$Lane
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (($Command -eq 'eval' -and $Lane -ne 'replay') -or ($Command -ne 'eval' -and $Lane)) {
    throw 'Use dev.ps1 up, dev.ps1 test, or dev.ps1 eval replay.'
}
$previousRoot = $env:INTERVIEW_PREP_WEBROOT
$previousBuild = $env:INTERVIEW_PREP_BUILD
Push-Location $PSScriptRoot
try {
    if ($Command -ne 'eval') {
        if ($Command -eq 'test') { $env:INTERVIEW_PREP_WEBROOT = Join-Path $PSScriptRoot 'apps' 'api' 'bin' 'test-wwwroot' }
        Push-Location (Join-Path $PSScriptRoot 'apps' 'web')
        try {
            if (-not (Test-Path 'node_modules\typescript\bin\tsc') -or -not (Test-Path 'node_modules\pdfjs-dist\build\pdf.worker.min.mjs') -or
                -not (Test-Path 'node_modules\fflate\package.json')) { npm ci --no-audit --no-fund }
            npm run build
        } finally { Pop-Location }
    }
    $project = Join-Path $PSScriptRoot 'apps' 'api' 'InterviewPrep.Api.csproj'
    $configuration = if ($Command -eq 'up') { 'Debug' } else { 'Release' }
    $env:INTERVIEW_PREP_BUILD = $configuration
    dotnet build $project -c $configuration -p:RestoreLockedMode=true --nologo --verbosity quiet
    switch ($Command) {
        'up'   { dotnet run --no-build --no-launch-profile --project $project }
        'test' {
            dotnet run --project (Join-Path $PSScriptRoot 'tests' 'schema' 'SchemaCheck.csproj') -c Release -p:RestoreLockedMode=true
            $tests = @(Get-ChildItem (Join-Path $PSScriptRoot 'tests'), (Join-Path $PSScriptRoot 'apps' 'web' 'tests') -Filter '*.test.mjs' |
                Where-Object Name -ne 'assessment-replay.test.mjs' | ForEach-Object FullName)
            node --test --test-concurrency=2 @tests
        }
        'eval' { node --test tests/assessment-replay.test.mjs }
    }
} finally {
    Pop-Location
    $env:INTERVIEW_PREP_WEBROOT = $previousRoot
    $env:INTERVIEW_PREP_BUILD = $previousBuild
}
