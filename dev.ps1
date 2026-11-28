#requires -Version 7.3
param(
    [ValidateSet('up', 'test', 'eval')][string]$Command = 'up',
    [string]$Lane,
    [string]$Case
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (($Command -eq 'eval' -and $Lane -notin 'replay','live') -or ($Command -ne 'eval' -and ($Lane -or $Case))) {
    throw 'Use dev.ps1 up, dev.ps1 test, or dev.ps1 eval replay|live [scenario[/conversation]].'
}
$previousRoot = $env:INTERVIEW_PREP_WEBROOT
$previousBuild = $env:INTERVIEW_PREP_BUILD
$previousJobIndex = $env:INTERVIEW_PREP_HN_JOB_SEARCH
$modelSettings = @{}
foreach ($k in 'INTERVIEW_PREP_MODEL_PORT','INTERVIEW_PREP_MODEL_KEY_FILE','INTERVIEW_PREP_MODEL_ID') { $modelSettings[$k] = [Environment]::GetEnvironmentVariable($k) }
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
        'up'   {
            if ($null -eq $previousJobIndex) { $env:INTERVIEW_PREP_HN_JOB_SEARCH = '1' }
            $installed = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'InterviewPrep' 'inference' 'server.key'
            if (!$env:INTERVIEW_PREP_MODEL_PORT -and (Test-Path -LiteralPath $installed)) { & (Join-Path $PSScriptRoot 'scripts' 'model.ps1') connect }
            dotnet run --no-build --no-launch-profile --project $project
        }
        'test' {
            dotnet run --project (Join-Path $PSScriptRoot 'tests' 'schema' 'SchemaCheck.csproj') -c Release -p:RestoreLockedMode=true
            $tests = @(Get-ChildItem (Join-Path $PSScriptRoot 'tests'), (Join-Path $PSScriptRoot 'apps' 'web' 'tests') -Filter '*.test.mjs' |
                Where-Object Name -ne 'assessment-replay.test.mjs' | ForEach-Object FullName)
            node --test --test-concurrency=2 @tests
        }
        'eval' {
            if ($Lane -eq 'replay' -and !$Case) {
                $checks = @((Join-Path $PSScriptRoot 'tests' 'assessment-replay.test.mjs')) +
                    @(Get-ChildItem (Join-Path $PSScriptRoot 'evals') -Filter '*.test.mjs' | ForEach-Object FullName)
                node --test @checks
            }
            $selection = if ($Case) { @('--case', $Case) } else { @() }
            node (Join-Path $PSScriptRoot 'evals' 'run.mjs') --lane $Lane @selection
        }
    }
} finally {
    Pop-Location
    $env:INTERVIEW_PREP_WEBROOT = $previousRoot
    $env:INTERVIEW_PREP_BUILD = $previousBuild
    $env:INTERVIEW_PREP_HN_JOB_SEARCH = $previousJobIndex
    foreach ($k in $modelSettings.Keys) { [Environment]::SetEnvironmentVariable($k, $modelSettings[$k]) }
}
