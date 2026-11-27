#requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][ValidatePattern('^rg-interview-prep-synthetic-[a-z0-9-]+$')][string]$Group,
    [switch]$EnableRollout
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$repo = 'github.com/k-rush/interview-prep'
$path = 'repos/k-rush/interview-prep/environments/private-test'
$templates = Join-Path $PSScriptRoot '..' 'infra' 'bicep'
function Cloud { $r = az @args --subscription $SubscriptionId -o json --only-show-errors; if ($r) { ($r -join "`n") | ConvertFrom-Json } }
function ReadApi($route) { gh api --hostname github.com $route | Out-String | ConvertFrom-Json }
$g = Cloud group show -n $Group
if ($g.tags.profile -cne 'entra-synthetic-test-v1' -or ([DateTimeOffset]$g.tags.expiresUtc) -le [DateTimeOffset]::UtcNow) { throw 'Not an active test group.' }
$oidc = ReadApi 'repos/k-rush/interview-prep/actions/oidc/customization/sub'
if (!$oidc.use_default -or $oidc.sub_claim_prefix -cnotmatch '^repo:k-rush/interview-prep(:[0-9]+)?$') { throw 'Unexpected OIDC subject.' }
if ('private-test' -notin (ReadApi 'repos/k-rush/interview-prep/environments?per_page=100').environments.name) {
    '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' |
        gh api --hostname github.com -X PUT $path --input - --silent
    '{"name":"main","type":"branch"}' | gh api --hostname github.com -X POST "$path/deployment-branch-policies" --input - --silent
}
$rules = (ReadApi "$path/deployment-branch-policies").branch_policies
if (!(ReadApi $path).deployment_branch_policy.custom_branch_policies -or $rules.Count -ne 1 -or $rules[0].name -cne 'main' -or $rules[0].type -ne 'branch') {
    throw 'The private-test environment must allow only the main branch.'
}
$ci = Cloud deployment group create -g $Group -n publisher --template-file (Join-Path $templates 'test-publisher.bicep') --parameters "subject=$($oidc.sub_claim_prefix):environment:private-test"
$foundation = Cloud deployment group show -g $Group -n foundation
$settings = @{
    TEST_ACR=$foundation.properties.outputs.registryName.value;TEST_GROUP=$Group;TEST_SUBSCRIPTION=$SubscriptionId.ToString()
    TEST_TENANT=(Cloud account show).tenantId;TEST_PUBLISHER=$ci.properties.outputs.clientId.value
}
foreach ($key in $settings.Keys) { $settings[$key] | gh secret set $key --repo $repo --env private-test }
gh variable set TEST_EXPIRES --body (([DateTimeOffset]$g.tags.expiresUtc).UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')) --repo $repo --env private-test
if ($EnableRollout) {
    $app = Cloud containerapp show -g $Group -n studio-test
    if ('private-test' -cnotin @($app.properties.template.containers[0].env | Where-Object name -eq 'INTERVIEW_PREP_PLANE').value) { throw 'Not the tester-only app.' }
    $null = Cloud deployment group create -g $Group -n rollout --template-file (Join-Path $templates 'test-rollout.bicep')
}
