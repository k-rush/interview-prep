#requires -Version 7.3
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Foundation','Launch')][string]$Phase,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][ValidatePattern('^rg-interview-prep-synthetic-[a-z0-9-]+$')][string]$Group,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9._-]+$')][string]$ModelGroup,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9-]+$')][string]$ModelAccount,
    [Parameter(Mandatory)][ValidatePattern('^[a-zA-Z0-9.-]+$')][string]$Deployment,
    [guid]$WebClientId, [ValidatePattern('^sha256:[a-f0-9]{64}$')][string]$Digest
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$templates = Join-Path $PSScriptRoot '..' 'infra' 'bicep'
function Cloud { $lines = az @args --subscription $SubscriptionId --only-show-errors -o json; if ($lines) { ($lines -join "`n") | ConvertFrom-Json } }
function Template([string]$name) { Join-Path $templates "$name.bicep" }
$model = Cloud cognitiveservices account show -g $ModelGroup -n $ModelAccount
$d = Cloud cognitiveservices account deployment show -g $ModelGroup -n $ModelAccount --deployment-name $Deployment
if ($d.sku.name -ne 'GlobalStandard' -or $d.properties.model.name -ne 'gpt-5.6-luna' -or $d.properties.provisioningState -ne 'Succeeded') {
    throw 'Recalculate the test budget before using a different model or SKU.'
}
$profile = 'entra-synthetic-test-v1'
$owner = [guid](az ad signed-in-user show --query id -o tsv --only-show-errors)
if (!(Cloud group exists -n $Group)) {
    if ($Phase -ne 'Foundation') { throw 'Create the isolated foundation first.' }
    $expires = [DateTime]::UtcNow.AddHours(24).ToString('yyyy-MM-ddTHH:mm:ssZ')
    $null = Cloud group create -n $Group -l $model.location --tags "profile=$profile" "expiresUtc=$expires" "model=$($d.id)" "tester=$owner"
}
$g = Cloud group show -n $Group
if ($g.tags.profile -cne $profile -or $g.tags.model -ine $d.id -or $g.tags.tester -ine $owner.ToString() -or
    !$g.tags.expiresUtc -or $g.location -ne $model.location) { throw 'Refusing to reuse a different deployment or tester.' }
$end = [DateTimeOffset]$g.tags.expiresUtc
if ($end -le [DateTimeOffset]::UtcNow -or $end -gt [DateTimeOffset]::UtcNow.AddHours(24.1)) { throw 'The original test window is invalid or expired.' }
$expires = $end.UtcDateTime.ToString('yyyy-MM-ddTHH:mm:ssZ')
if ($Phase -eq 'Foundation') {
    $null = Cloud deployment group create -g $Group -n expiry --template-file (Template 'test-expiry') --parameters "expires=$expires"
    $rule = Cloud resource show --ids "$($g.id)/providers/Microsoft.Logic/workflows/expire-synthetic-test" --api-version 2019-05-01
    if ($rule.properties.state -ne 'Enabled' -or ([DateTimeOffset]$rule.properties.definition.triggers.expiry.recurrence.startTime) -ne $end -or
        $rule.properties.definition.actions.deleteOnlyThisTestGroup.inputs.uri -ine "https://management.azure.com$($g.id)?api-version=2022-09-01") {
        throw 'Refusing to provision before verifying scheduled cleanup.'
    }
    $foundation = Cloud deployment group create -g $Group -n foundation --template-file (Template 'test-foundation')
    $principal = [guid]$foundation.properties.outputs.principalId.value
    $plan = Cloud deployment group what-if -g $ModelGroup --no-pretty-print --template-file (Template 'test-inference') --parameters "accountName=$ModelAccount" "testPrincipalId=$principal"
    if ($null -eq $plan.changes) { throw 'No readable inference-access plan.' }
    foreach ($change in $plan.changes) {
        if ($change.changeType -notin 'NoChange','Ignore' -and ($change.changeType -ne 'Create' -or
            $change.resourceId -notmatch '/providers/Microsoft.Authorization/(roleAssignments|roleDefinitions)/[0-9a-f-]+$')) {
            throw 'Unexpected change to the shared model environment.'
        }
    }
    $null = Cloud deployment group create -g $ModelGroup -n "ip-inference-$principal" --template-file (Template 'test-inference') --parameters "accountName=$ModelAccount" "testPrincipalId=$principal"
    Write-Output "Isolated foundation ready. ACR: $($foundation.properties.outputs.registryName.value). Expires: $expires."
    return
}
if (!$Digest -or $WebClientId -eq [guid]::Empty -or !$WebClientId) { throw 'Launch needs the reviewed image digest and dedicated Entra web app registration.' }
$apps = @(Cloud containerapp list -g $Group)
if ($apps.Count) { throw 'The test app already exists. Launch cannot replace a running workspace.' }
$foundation = Cloud deployment group show -g $Group -n foundation
$hostName = $foundation.properties.outputs.host.value
if ($hostName -cnotmatch '^studio-test\.[a-z0-9.-]+\.azurecontainerapps\.io$') { throw 'Invalid staging hostname.' }
$image = Cloud acr repository show -n $foundation.properties.outputs.registryName.value --image "interview-prep@$Digest"
if ($image.digest -cne $Digest) { throw 'Image digest is missing from this test registry.' }
$appReg = (az ad app show --id $WebClientId -o json --only-show-errors | Out-String) | ConvertFrom-Json
if ($appReg.displayName -cne 'interview-prep-synthetic-test' -or $appReg.signInAudience -cne 'AzureADMyOrg' -or
    $appReg.passwordCredentials.Count -or $appReg.web.redirectUris.Count -or $appReg.api.oauth2PermissionScopes.Count) {
    throw 'Launch needs a fresh, dedicated, single-tenant app registration.'
}
function Token([string]$audience) {
    (az account get-access-token --subscription $SubscriptionId --resource $audience --query accessToken -o tsv --only-show-errors) | ConvertTo-SecureString -AsPlainText -Force
}
$graph = Token 'https://graph.microsoft.com/'
$appUri = "https://graph.microsoft.com/v1.0/applications/$([guid]$appReg.id)"
$scope = [guid]::NewGuid().ToString()
$redirect = "https://$hostName/signin-oidc"
$settings = @{
    identifierUris = @("api://$WebClientId")
    web = @{redirectUris = @($redirect)}
    api = @{
        requestedAccessTokenVersion = 2
        oauth2PermissionScopes = @(@{id=$scope;value='access_as_user';type='User';isEnabled=$true
            adminConsentDisplayName='Use the synthetic workspace';adminConsentDescription='Access this isolated test as the signed-in user.'
            userConsentDisplayName='Use the synthetic workspace';userConsentDescription='Access this isolated test as you.'})
    }
}
$null = Invoke-RestMethod $appUri -Method Patch -Authentication Bearer -Token $graph -ContentType application/json -Body ($settings | ConvertTo-Json -Depth 10)
# Graph validates preauthorization against already-persisted scopes, not sibling fields in a PATCH.
$preauthorize = @{api=@{preAuthorizedApplications=@(@{appId='04b07795-8ddb-461a-bbee-02f9e1bf7b46';delegatedPermissionIds=@($scope)})}} | ConvertTo-Json -Depth 8
for ($attempt=0; ; $attempt++) {
    try {
        $null = Invoke-RestMethod $appUri -Method Patch -Authentication Bearer -Token $graph -ContentType application/json -Body $preauthorize
        break
    } catch {
        if ($attempt -ge 5 -or $_.ErrorDetails.Message -notmatch 'Permission Id that cannot be found') { throw }
        Start-Sleep -Seconds 3
    }
}
$password = Invoke-RestMethod "$appUri/addPassword" -Method Post -Authentication Bearer -Token $graph -ContentType application/json -Body (
    @{passwordCredential=@{displayName='24-hour staging sign-in';endDateTime=$expires}} | ConvertTo-Json)
# Send secure parameters in-process, never through child-process arguments, parameter files, or GitHub.
$compiled = az bicep build --file (Template 'test-app') --stdout --only-show-errors | Out-String | ConvertFrom-Json -AsHashtable
$params = @{}
$inputValues = @{digest=$Digest;expires=$expires;testerOid=$owner.ToString();webClientId=$WebClientId.ToString();webClientSecret=$password.secretText
    modelEndpoint=$model.properties.endpoints.'Azure OpenAI Legacy API - Latest moniker';modelDeployment=$Deployment}
foreach ($key in $inputValues.Keys) { $params[$key] = @{value=$inputValues[$key]} }
$arm = Token 'https://management.azure.com/'
$uri = "https://management.azure.com$($g.id)/providers/Microsoft.Resources/deployments/private-app?api-version=2022-09-01"
$null = Invoke-RestMethod $uri -Method Put -Authentication Bearer -Token $arm -ContentType application/json -Body (
    @{properties=@{mode='Incremental';template=$compiled;parameters=$params}} | ConvertTo-Json -Depth 100 -Compress)
$null = Cloud deployment group wait --created -g $Group -n private-app --interval 5 --timeout 540
Write-Output "Private test: https://$hostName/ ; expires $expires."
