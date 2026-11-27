#requires -Version 7.3
[CmdletBinding()]
param(
    [ValidateSet('Plan','Foundation','JobAccess')][string]$Phase = 'Plan',
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][ValidatePattern('^[a-z0-9]+$')][string]$Location,
    [Parameter(Mandatory)][ValidatePattern('^[a-z][a-z0-9-]{2,28}$')][string]$Prefix,
    [ValidatePattern('^[\w.-]+/[\w.-]+$')][string]$Repository = 'k-rush/interview-prep',
    [string]$Reviewer
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
$shared = "$Prefix-shared"
$rings = 'staging','production'
$bicep = Join-Path $PSScriptRoot '..' 'infra' 'bicep'
if ($Phase -eq 'Plan') {
    Write-Output "No changes. Foundation creates $shared, $Prefix-staging and $Prefix-production in $Location, ACR Basic, receipt storage, scoped identities/RBAC, and protected environments in $Repository. It does not turn on release workflows. JobAccess binds job start permissions after protected infra apply."
    return
}
if (!$Reviewer) { throw 'Supply the GitHub login of the deployment reviewer; never a token.' }
function Cloud {
    $lines = & az @args --subscription $SubscriptionId --only-show-errors -o json
    if ($lines) { ($lines -join "`n") | ConvertFrom-Json }
}
function GitApi([string]$Path, [string]$Method = 'GET', [hashtable]$Body) {
    $lines = if ($null -ne $Body) {
        $Body | ConvertTo-Json -Depth 8 -Compress | gh api --method $Method $Path --input -
    } else { gh api --method $Method $Path }
    if ($lines) { ($lines -join "`n") | ConvertFrom-Json }
}
function Variable([string]$Name, [string]$Value, [string]$Environment) {
    $opts = if ($Environment) { @('--env', $Environment) } else { @() }
    gh variable set $Name --repo $Repository --body $Value @opts
}
function Grant($Identity, [string]$Role, [string]$Scope) {
    $key = [Text.Encoding]::UTF8.GetBytes("$($Identity.principalId)|$Role|$($Scope.ToLowerInvariant())")
    $name = [guid]::new([byte[]]([Security.Cryptography.SHA256]::HashData($key)[0..15]))
    $null = Cloud role assignment create --name $name --assignee-object-id $Identity.principalId --assignee-principal-type ServicePrincipal --role $Role --scope $Scope
}
function Identity([string]$Name) {
    # Select only from our tagged, dedicated group. Do not reuse an identity from another project.
    Cloud identity create -g $shared -n $Name -l $Location
}
function Boundary([string]$Name, [bool]$Approval = $false) {
    $path = "repos/$Repository/environments/$Name"
    if ($Name -notin $environments) {
        $body = @{ deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true }; can_admins_bypass = $false }
        if ($Approval) { $body.reviewers = @(@{ type = 'User'; id = $reviewerId }) }
        $null = GitApi $path PUT $body
        $null = GitApi "$path/deployment-branch-policies" POST @{ name = 'main'; type = 'branch' }
    }
    $boundary = GitApi $path
    $policies = (GitApi "$path/deployment-branch-policies").branch_policies
    if (!$boundary.deployment_branch_policy.custom_branch_policies -or @($policies).Count -ne 1 -or
        $policies[0].name -cne 'main' -or $policies[0].type -ne 'branch') {
        throw "Protect $Name for the main branch only. Existing rules were not overwritten."
    }
    if ($Approval -and $reviewerId -notin @($boundary.protection_rules | Where-Object type -eq 'required_reviewers' |
        ForEach-Object { $_.reviewers } | ForEach-Object { $_.reviewer.id })) { throw "Required reviewer missing on $Name." }
    $identity = Identity "gh-$Name"
    $subject = "${subjectPrefix}:environment:$Name"
    $creds = @(Cloud identity federated-credential list -g $shared --identity-name $identity.name)
    if ($creds.Count -eq 0) {
        $null = Cloud identity federated-credential create -g $shared --identity-name $identity.name -n github `
            --issuer 'https://token.actions.githubusercontent.com' --subject $subject --audiences 'api://AzureADTokenExchange'
    } elseif ($creds.Count -ne 1 -or $creds[0].issuer -cne 'https://token.actions.githubusercontent.com' -or
        $creds[0].subject -cne $subject -or ($creds[0].audiences -join ',') -cne 'api://AzureADTokenExchange') {
        throw "Unexpected federation on $($identity.name); refusing to reuse this identity."
    }
    Variable AZURE_CLIENT_ID $identity.clientId $Name
    return $identity
}
function OwnedGroup([string]$Name) {
    if ((Cloud group exists -n $Name) -eq $false) {
        if ($Phase -ne 'Foundation') { throw "Missing demo resource group: $Name" }
        $null = Cloud group create -n $Name -l $Location --tags "interviewPrepRepository=$Repository" 'profile=public-demo-v1'
    }
    $g = Cloud group show -n $Name
    if ($g.tags.interviewPrepRepository -cne $Repository -or $g.tags.profile -ne 'public-demo-v1' -or $g.location -ne $Location) {
        throw "Refusing to use a non-demo resource group: $Name"
    }
    return $g
}

$branch = GitApi "repos/$Repository/branches/main"
if (!$branch.protected) { throw 'Protect main and require Verify before binding OIDC identities.' }
$oidc = GitApi "repos/$Repository/actions/oidc/customization/sub"
if (!$oidc.use_default -or $oidc.sub_claim_prefix -notlike 'repo:*') {
    throw 'Expected the default repo/context OIDC subject. Review custom claims before creating federation.'
}
$subjectPrefix = $oidc.sub_claim_prefix
$reviewerId = (GitApi "users/$Reviewer").id
$environments = @((GitApi "repos/$Repository/environments?per_page=100").environments.name)
if ($Phase -eq 'JobAccess') {
    $null = OwnedGroup $shared
    foreach ($ring in $rings) {
        $null = OwnedGroup "$Prefix-$ring"
        if ($ring -eq 'staging') {
            $domain = (Cloud containerapp env show -g "$Prefix-$ring" -n "demo-$ring").properties.defaultDomain
            if ($domain -cnotmatch '^[a-z0-9.-]+\.azurecontainerapps\.io$') { throw 'Unexpected Azure public environment domain.' }
            Variable STAGING_DEMO_ORIGIN "https://studio-staging.$domain"
        }
        foreach ($purpose in 'deploy','monitor') {
            $boundary = if ($purpose -eq 'deploy') { $ring } else { "monitor-$ring" }
            $job = Cloud containerapp job show -g "$Prefix-$ring" -n "ops-$purpose"
            $identity = Cloud identity show -g $shared -n "gh-$boundary"
            Grant $identity 'Container Apps Jobs Operator' $job.id
            Grant $identity Reader $job.properties.environmentId
        }
    }
    Write-Output 'Job access configured. Release and monitoring flags remain operator-controlled.'
    return
}
foreach ($provider in 'Microsoft.App','Microsoft.ContainerRegistry','Microsoft.Storage','Microsoft.ManagedIdentity','Microsoft.OperationalInsights') {
    $null = Cloud provider register -n $provider --wait
}
$sharedGroup = OwnedGroup $shared
$outputs = (Cloud deployment group create -g $shared -n demo-foundation --template-file (Join-Path $bicep 'shared.bicep')).properties.outputs
$acr = Cloud acr show -n $outputs.acrName.value -g $shared
$store = Cloud storage account show -n $outputs.storageName.value -g $shared
$account = Cloud account show
Variable AZURE_SUBSCRIPTION_ID $SubscriptionId
Variable AZURE_TENANT_ID $account.tenantId
Variable ACR_NAME $acr.name
Variable SHARED_RESOURCE_GROUP $shared
Variable RELEASE_STORAGE_ACCOUNT $store.name
$builder = Boundary 'build'
Grant $builder Reader $acr.id
Grant $builder AcrPush $acr.id
foreach ($ring in $rings) {
    $g = OwnedGroup "$Prefix-$ring"
    $pull = Identity "$ring-pull"
    Grant $pull AcrPull $acr.id
    $plan = Boundary "infra-plan-$ring"
    $apply = Boundary "infra-apply-$ring" $true
    Grant $plan Reader $sharedGroup.id
    Grant $apply Reader $sharedGroup.id
    Grant $apply Contributor $g.id
    $null = Cloud deployment group create -g $g.name -n preview-rbac --template-file (Join-Path $bicep 'preview-access.bicep') --parameters "principalId=$($plan.principalId)"
    foreach ($envName in "infra-plan-$ring","infra-apply-$ring") { Variable AZURE_RESOURCE_GROUP $g.name $envName }
    foreach ($purpose in 'deploy','monitor') {
        $boundary = if ($purpose -eq 'deploy') { $ring } else { "monitor-$ring" }
        $runner = Boundary $boundary ($boundary -eq 'production')
        $ops = Identity "$ring-ops-$purpose"
        Grant $apply 'Managed Identity Operator' $ops.id
        Grant $ops AcrPull $acr.id
        $container = "$($store.id)/blobServices/default/containers/"
        Grant $ops 'Storage Blob Data Contributor' "$container$ring"
        if ($purpose -eq 'deploy') {
            Grant $ops 'Container Apps Contributor' $g.id
            Grant $ops 'Managed Identity Operator' $pull.id
            Grant $runner Reader $acr.id
            Grant $runner AcrPull $acr.id
            Grant $runner 'Storage Blob Data Reader' "$container$ring"
            if ($ring -eq 'production') {
                Grant $ops 'Storage Blob Data Reader' "${container}staging"
                Grant $runner 'Storage Blob Data Reader' "${container}staging"
            }
        } else { Grant $ops Reader $g.id }
        Variable AZURE_RESOURCE_GROUP $g.name $boundary
        Variable OPS_JOB "ops-$purpose" $boundary
        Variable OPS_CONTAINER 'control' $boundary
    }
}
Write-Output "Foundation ready: registry $($acr.loginServer), receipt store $($store.name). Follow docs/deploy-demo.md to publish the controller and preview each ring."
