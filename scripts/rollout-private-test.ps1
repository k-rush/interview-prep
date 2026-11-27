#requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$Sub,
    [Parameter(Mandatory)][ValidatePattern('^rg-interview-prep-synthetic-[a-z0-9-]+$')][string]$Group,
    [Parameter(Mandatory)][ValidatePattern('^iptest[a-z0-9]+$')][string]$Registry,
    [Parameter(Mandatory)][ValidatePattern('^sha256:[a-f0-9]{64}$')][string]$Digest,
    [Parameter(Mandatory)][ValidatePattern('^run-[0-9]+-[0-9]+$')][string]$Revision,
    [Parameter(Mandatory)][string]$Expires
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$end = [DateTimeOffset]$Expires
if ($end -le [DateTimeOffset]::UtcNow -or $end -gt [DateTimeOffset]::UtcNow.AddHours(24)) { throw 'Outside the existing test window.' }
$token = (az account get-access-token --subscription $Sub --resource 'https://management.azure.com/' --query accessToken -o tsv --only-show-errors) |
    ConvertTo-SecureString -AsPlainText -Force
$id = "https://management.azure.com/subscriptions/$Sub/resourceGroups/$Group/providers/Microsoft.App/containerApps/studio-test"
$api = 'api-version=2024-03-01'
$image = "$Registry.azurecr.io/interview-prep@$Digest"
function State { (Invoke-RestMethod "${id}?$api" -Authentication Bearer -Token $token).properties }
function Mutate([string]$method, [string]$suffix, $body) {
    $argsHttp = @{Method=$method; Uri="${id}${suffix}?$api"; Authentication='Bearer'; Token=$token; SkipHttpErrorCheck=$true; ContentType='application/json'}
    if ($body) { $argsHttp.Body=$body | ConvertTo-Json -Compress -Depth 50 }
    for ($i=0; $i -lt 48; $i++) {
        $r = Invoke-WebRequest @argsHttp
        if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 300) { return }
        $code = ($r.Content | ConvertFrom-Json).error.code
        # ARM can report Stopped/Succeeded before it releases the preceding operation's lock.
        if ($r.StatusCode -ne 409 -or $code -ne 'ContainerAppOperationInProgress') { throw "$method $suffix failed: HTTP $($r.StatusCode) $code" }
        Start-Sleep 5
    }
    throw "Azure did not release its operation lock for $method $suffix."
}
function WaitState([scriptblock]$ready) {
    for ($i=0; $i -lt 60; $i++) {
        $current=State
        if ($current.provisioningState -in 'Failed','Canceled') { throw "Container App provisioning: $($current.provisioningState)." }
        if (& $ready $current) { return $current }
        Start-Sleep 5
    }
    throw 'Timed out waiting for the requested revision transition.'
}
$state = State
$template = $state.template
$settings = @{}
foreach ($v in $template.containers[0].env) { $settings[$v.name]=$v.value }
$hostName = $state.configuration.ingress.fqdn
if ($hostName -cnotmatch '^studio-test\.[a-z0-9.-]+\.azurecontainerapps\.io$' -or
    $settings.INTERVIEW_PREP_PLANE -cne 'private-test' -or ([DateTimeOffset]$settings.INTERVIEW_PREP_TEST_EXPIRES) -ne $end -or
    $template.containers.Count -ne 1 -or $template.containers[0].name -ne 'studio' -or $template.scale.maxReplicas -ne 1 -or
    $state.configuration.activeRevisionsMode -ne 'Single' -or $state.configuration.ingress.allowInsecure) { throw 'Not the expected private, single-writer app.' }
if ($template.containers[0].image -cne $image) {
    if ($state.runningStatus -ne 'Stopped') { Mutate POST '/stop' $null }
    $null = WaitState { param($s) $s.runningStatus -eq 'Stopped' }
    $template.containers[0].image=$image
    $template.revisionSuffix=$Revision
    Mutate PATCH '' @{properties=@{template=$template}}
    $state=WaitState { param($s) $s.provisioningState -eq 'Succeeded' -and $s.template.containers[0].image -ceq $image }
}
if ($state.runningStatus -ne 'Running') { Mutate POST '/start' $null }
$null=WaitState { param($s) $s.runningStatus -eq 'Running' -and $s.template.containers[0].image -ceq $image -and
    $s.latestRevisionName -eq $s.latestReadyRevisionName }
for ($i=0; $i -lt 30; $i++) {
    try { $r=Invoke-WebRequest "https://$hostName/api/workspace" -SkipHttpErrorCheck -MaximumRedirection 0 -TimeoutSec 20 }
    catch { $r=$null }
    if ($r -and $r.StatusCode -eq 401) { Write-Output "Private revision serves $Digest and denies anonymous workspace access."; return }
    Start-Sleep 5
}
throw 'The new revision did not deny anonymous access as expected.'
