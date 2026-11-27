# Deploy the fictional demo to Azure

The release profile is `public-demo-v1`. A visitor can try and reset the fictional exercise at `/demo`; **all** `/api` routes return 401. In this profile the server does not even initialize the workspace database or workers. Do not mount a data volume, configure Firebase/Stripe/OpenAI, or deploy the desktop process behind public ingress.

The default setup makes **no changes**. Activation below is an operator action, not part of local development. ACR Basic, blob storage, container execution, egress and Actions can incur charges even at low traffic. The two Consumption apps scale from zero to one replica; the controller jobs run only on demand. Set an Azure budget alert before provisioning (an alert is **not** a spending cap).

### 1. Prepare the boundaries

Use a reviewed, merged checkout of `main` and a **dedicated** prefix in a chosen Azure public-cloud subscription/region supporting Container Apps. The operator needs resource group/provider, managed identity and scoped role-definition/assignment permissions, plus registry image push for the controller. GitHub needs Actions, artifact attestations, deployment environments and a repo administrator for initial configuration. Use `gh`, Azure CLI 2.76+ with Bicep, PowerShell 7.3+ and Docker Buildx. Authenticate interactively to your own accounts; never put cloud passwords or runtime keys in the repo or Actions.

Protect `main` (Settings → Rules → Rulesets): require pull requests and passing **Verify**, restrict force pushes/deletion and review changes to workflows, deployment scripts and `infra/`. Run Verify once if its check isn't listed. Confirm the intended reviewer can approve deployments under your GitHub plan. Do not run bootstrap over another application's resources.

```powershell
$repo = 'k-rush/interview-prep'
$setup = @{
    SubscriptionId = '<your Azure subscription GUID>'
    Location = '<your Azure region>'
    Prefix = '<dedicated lowercase prefix>'
    Repository = $repo
    Reviewer = '<GitHub deployment reviewer login>'
}
.\scripts\bootstrap-demo.ps1 @setup                    # Plan only; no login or side effects
.\scripts\bootstrap-demo.ps1 @setup -Phase Foundation  # Explicit: creates resources and GitHub config
```

Foundation tags and owns `<prefix>-shared`, `<prefix>-staging`, `<prefix>-production`. It creates an admin-disabled registry, TLS-only storage with private per-ring containers and no shared keys, managed identities, and main-branch-only GitHub environments. `build` gets registry push; deploy identities get registry/receipt read; preview gets read + what-if, and apply is privileged only for its ring and its job identities. Production and both infra applies require a reviewer. Existing protection rules are checked rather than replaced. Inspect them in Settings → Environments; disable admin bypass and select independent reviewers where available. It reads the repo's actual default OIDC subject prefix, including immutable IDs when enabled, and never creates a client secret. Bootstrap is rerunnable; allow time for Azure RBAC propagation.

### 2. Install the trusted controller and preview infrastructure

The controller is **not the app image**. Publish it only from a clean, reviewed checkout; the per-ring infrastructure approvals pin its digest. `.dockerignore` for the control build admits only its runtime and release policy. `$acr` below is the name created by Foundation. The operator doing this push must have `AcrPush` on that registry.

```powershell
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
if (git status --porcelain) { throw 'Use a clean reviewed checkout for the controller.' }
$acr = gh variable get ACR_NAME --repo $repo
$registry = az acr show --subscription $setup.SubscriptionId -n $acr --query loginServer -o tsv
az acr login --subscription $setup.SubscriptionId -n $acr
$meta = New-TemporaryFile
try {
    docker buildx build --platform linux/amd64 --file infra\control\Dockerfile --push `
        --tag "$registry/interview-prep-control:$(git rev-parse HEAD)" --metadata-file $meta.FullName .
    $control = (Get-Content $meta.FullName -Raw | ConvertFrom-Json).'containerimage.digest'
    if ($control -cnotmatch '^sha256:[0-9a-f]{64}$') { throw 'Missing controller digest.' }
    gh variable set CONTROLLER_DIGEST --repo $repo --body $control
} finally { Remove-Item -LiteralPath $meta.FullName }
gh variable set INFRA_ENABLED --repo $repo --body true
gh workflow run infra.yml --repo $repo --ref main -f plane=staging -f apply=true
gh workflow run infra.yml --repo $repo --ref main -f plane=production -f apply=true
```

Each dispatch previews first. Inspect the proposed environment and manual jobs, then approve the corresponding apply. Use `-f apply=false` for **preview only**. A changed plan is rejected; inspect privately and start a new preview, never bypass a mismatch. Wait for **both applies** to succeed. At this point **there is no public application**. Reapplying this template does not change a serving app's image or traffic.

### 3. Release staging, then production

```powershell
.\scripts\bootstrap-demo.ps1 @setup -Phase JobAccess  # Job start scoped to the installed job, not the group
gh variable set MONITORING_ENABLED --repo $repo --body true
gh variable set RELEASES_ENABLED --repo $repo --body true
gh workflow run release.yml --repo $repo --ref main
```

Inspect Actions → **Verify, publish and deploy staging**. It tests and attests the exact image digest, then starts the isolated staging controller. Use the **staging environment URL** to try the fictional sample. Keep `LIVE_EVALS_ENABLED` unset. Save `$commit` and `$digest` from the build summary (full 40-hex SHA and `sha256:...` respectively).

After staging has been healthy for **at least 30 minutes**, run the observation, wait for success, then request production within two hours:

```powershell
gh workflow run checks.yml --repo $repo --ref main -f task=monitor -f ring=staging
# After the observation succeeds:
gh workflow run ring.yml --repo $repo --ref main -f operation=promote -f ring=production -f commit=$commit -f digest=$digest
```

Approve the production environment after checking the digest. The same signed image is used without rebuilding. The successful run publishes an **HTTPS demo URL** in its summary and GitHub environment; smoke checks verify the commit, assets and private API denial. TLS uses the Azure-assigned hostname; no custom domain or DNS credentials are required. A skipped workflow means a flag, branch or prerequisite isn't satisfied, **not** that it deployed.

### Operate or roll back

- Observe a ring with `checks.yml`, `task=monitor`, `ring=staging|production`. No ongoing Actions schedule or paid model calls are enabled.
- Freeze new releases by disabling `RELEASES_ENABLED`. To block **promotion** but allow incident rollback, an authorized operator can upload `{}` as `freeze.json` to the chosen ring's receipt container using Entra data-plane auth. Remove that blob deliberately to unfreeze.
- For a known-good deployment in the **same ring**, dispatch `ring.yml` with `operation=rollback`, `ring`, the historical `commit` and `digest`, and `reason` (an incident reference, no customer data). Approval and provenance still apply. Keep the previous working image and receipt for at least 30 days.
- If a job failed, check its execution in Azure and the ring's `rings/<ring>/current.json` blob. A `deploying` receipt means **unknown/pending**. Do not start competing releases, break a live lease or edit evidence to green. Reconcile the actual serving image and retry the same Actions run once the lease expires. If the external smoke fails, freeze promotion and roll back; an unsuccessful first deployment may need ingress disabled by an operator.
- Turning off flags does **not** deprovision resources. To retire the demo, disable release/monitor/infra flags and review the three tagged groups, retention needs, federated identities and GitHub environments before removing anything. There is no automatic teardown or data migration.

Local, no-cloud checks: `node --test scripts/check-release.test.mjs infra/control/controller.test.mjs`, `az bicep build --file infra/bicep/main.bicep --stdout`, and `docker build --build-arg SOURCE_REVISION=$(git rev-parse HEAD) -t interview-prep:demo-check .` followed by `.\scripts\test-demo.ps1 -Image interview-prep:demo-check -Commit (git rev-parse HEAD)`. **Live** ARM what-if, OIDC exchange, managed-identity image pulls, ingress and rollback must still be exercised in the operator's staging subscription; local checks cannot prove those permissions or region quotas.
