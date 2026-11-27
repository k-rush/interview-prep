param(
    [Parameter(Mandatory)][ValidateSet('promote', 'rollback', 'monitor', 'eval')][string]$Operation,
    [Parameter(Mandatory)][ValidateSet('staging', 'production')][string]$Ring,
    [string]$Commit = '-',
    [string]$Digest = '-'
)
$ErrorActionPreference = 'Stop'
foreach ($name in 'AZURE_RESOURCE_GROUP', 'OPS_JOB', 'OPS_CONTAINER', 'GITHUB_RUN_ID') {
    if (-not [Environment]::GetEnvironmentVariable($name)) { throw "Missing $name" }
}
if ($Operation -ne 'monitor' -and ($Commit -cnotmatch '^[a-f0-9]{40}$' -or $Digest -cnotmatch '^sha256:[a-f0-9]{64}$')) {
    throw 'A release requires an immutable commit and image digest.'
}
# An Azure execution override replaces the template. Preserve the pinned image, identity context,
# resources and environment from the installed job; change only its positional arguments.
$template = az containerapp job show -g $env:AZURE_RESOURCE_GROUP -n $env:OPS_JOB --query properties.template -o json --only-show-errors | ConvertFrom-Json -AsHashtable
if ($LASTEXITCODE -ne 0 -or $template.containers.Count -ne 1 -or $template.containers[0].name -ne $env:OPS_CONTAINER) {
    throw 'Unexpected control job template.'
}
if ($Operation -ne 'eval' -and ($env:CONTROLLER_DIGEST -cnotmatch '^sha256:[a-f0-9]{64}$' -or
    !$template.containers[0].image.EndsWith("/interview-prep-control@$env:CONTROLLER_DIGEST"))) {
    throw 'Control job is not using the reviewed controller digest. Check the protected infrastructure deployment.'
}
$template.containers[0].args = @($Operation, $Ring, $Commit, $Digest, $env:GITHUB_RUN_ID)
$file = Join-Path ([IO.Path]::GetTempPath()) "ops-$([guid]::NewGuid()).yaml"
try {
    $template | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $file -Encoding utf8NoBOM
    $execution = az containerapp job start --resource-group $env:AZURE_RESOURCE_GROUP --name $env:OPS_JOB --yaml $file --query name -o tsv --only-show-errors
} finally { Remove-Item -LiteralPath $file -ErrorAction SilentlyContinue }
if ($LASTEXITCODE -ne 0 -or -not $execution) { throw 'Could not confirm job start; reconcile before retrying.' }
$deadline = [DateTime]::UtcNow.AddMinutes(18)
do {
    $status = az containerapp job execution show --resource-group $env:AZURE_RESOURCE_GROUP --name $env:OPS_JOB --job-execution-name $execution --query properties.status -o tsv --only-show-errors
    if ($LASTEXITCODE -ne 0) { throw "Cannot read execution $execution; inspect its receipt." }
    if ($status -eq 'Succeeded') { Write-Output "$Operation on ${Ring}: $execution succeeded."; return }
    if ($status -in 'Failed', 'Stopped', 'Canceled', 'Cancelled', 'Degraded') { throw "$execution ended with $status" }
    Start-Sleep -Seconds 10
} while ([DateTime]::UtcNow -lt $deadline)
throw "Timed out observing $execution; do not assume rollback or replay automatically."
