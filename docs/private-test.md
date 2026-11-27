# Private Azure model test

This is a temporary staging environment for **one Microsoft Entra user and fictional inputs**, not a production hosting option. The signed-in Azure CLI user at bootstrap is the tester. The app checks tenant and object ID after verifying the OIDC session or a delegated access token issued **for this app**. Anonymous requests and identity headers do not create a workspace. Sign in at `/`, open the test workspace, and use Chat, Mock interview or Find jobs.

The coach sends the relevant synthetic conversation/context to Azure OpenAI. Mock grading uses only the role, questions and answers. The public scout sends only the selected public role title to Azure OpenAI web search; links aren't verified vacancies. No model request is stored through the Responses API. Background searches and billing are off. Do not upload a real resume or import an existing database.

## One-time, operator-controlled launch

Use PowerShell 7.3+, an authenticated `az`/`gh`, and a fresh group matching `rg-interview-prep-synthetic-*`. Choose an **explicitly authorized, existing, Global Standard GPT-5.6 Luna test deployment**. Set `$sub`, `$group`, `$modelGroup`, `$account`, `$deployment` locally; do not put account names or IDs into source. The operator needs rights to create isolated resources and narrowly scoped RBAC, and to create a single-tenant app registration. Do not reuse the model account's keys or give GitHub access to it.

```powershell
$test = @{SubscriptionId=$sub; Group=$group; ModelGroup=$modelGroup; ModelAccount=$account; Deployment=$deployment}
.\scripts\start-private-test.ps1 @test -Phase Foundation
.\scripts\connect-private-test.ps1 -SubscriptionId $sub -Group $group
gh workflow run private-test.yml --repo github.com/k-rush/interview-prep --ref main -f publish_only=true
```

Wait for the verified publish job; take the immutable digest from its summary. Register a **new** Entra web app, not an existing project identity:

```powershell
$web = az ad app create --display-name interview-prep-synthetic-test --sign-in-audience AzureADMyOrg --query appId -o tsv
az ad sp create --id $web -o none
.\scripts\start-private-test.ps1 @test -Phase Launch -WebClientId $web -Digest $digest
.\scripts\connect-private-test.ps1 -SubscriptionId $sub -Group $group -EnableRollout
```

Launch binds the HTTPS callback, creates a sign-in credential expiring with the test, and sends it directly to the Azure deployment as a secure parameter. GitHub never receives it. Only the app's managed identity gets `Microsoft.CognitiveServices/accounts/OpenAI/responses/write` on the selected account. Azure CLI is preauthorized for the test API scope, not for Graph or model inference; the same tester check applies. The manual **Private synthetic test** workflow can subsequently replace the app image with `publish_only=false` on `main`. It stops the old SQLite writer before switching digest. Leave `RELEASES_ENABLED` and `INFRA_ENABLED` unset.

## Cost, persistence and expiry

One Consumption replica at 0.25 vCPU / 0.5 GiB, even active all day, is about **$0.65** before free grants. A Basic registry is about $0.17/day; the small Standard LRS file share and one Logic Apps timer add little. The app reserves at most **80 model calls and 10 searches per window**, even across restarts or workspace deletion. Requests are limited to 32 KiB and 1,800 output tokens; searches can make one tool call. At this model's Global Standard rates this targets **under $5 total**, not a billing guarantee. Reprice before changing the region, model, quota or period.

SQLite runs on local disk. Each successful mutating API request checkpoints a consistent closed SQLite backup to the private share before returning success. A restarted replica restores it under a single-writer lease. Budget markers and session protection keys live separately on the share. Nothing is restored into a later test.

The original UTC expiry is on the group's `expiresUtc` tag. The application rejects access and model calls at expiry; an Azure Logic Apps timer deletes **only the dedicated test group** and retries hourly if necessary. Check that the group is gone. For early shutdown, verify the exact group, profile tag and resource list, then delete just that group. Do **not** delete the model group or deployment.

The disposable runtime principal loses access when deleted. After teardown, remove the now-orphaned inference assignment and custom role using the **exact** `assignmentId` and `definitionId` outputs of the `ip-inference-<test-principal-id>` deployment in the model group (`az role assignment delete --ids ...`, then `az role definition delete --name <definition-guid>`). Delete only the newly created web registration (`az ad app delete --id $web`) and retire the `private-test` GitHub environment if not using it again. These directory/RBAC records do not incur hosting costs. A new window needs fresh authorization and a fresh registration.
