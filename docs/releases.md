# Release rings and GitHub Actions

**Staging → production.** Build once on protected `main`; promote the exact attested digest exercised in staging. Cloud operations are disabled until explicitly activated. The [deployment runbook](deploy-demo.md) provisions **only the public fictional demo**. No real accounts, private SQLite workspaces, model endpoints, Stripe or email are needed or enabled.

| Workflow | Trigger and responsibilities |
| --- | --- |
| [verify.yml](../.github/workflows/verify.yml) | PR, manual or called by release. Read-only workflow lint, Bicep compilation, release/controller and infrastructure fixtures, app tests and offline agent replays. No cloud identity or paid calls. |
| [release.yml](../.github/workflows/release.yml) | Protected `main` push or dispatch: verify, publish one Linux AMD64 image with SBOM/provenance, exercise that digest as a read-only demo, attest it, and call the ring workflow for **staging only**. |
| [ring.yml](../.github/workflows/ring.yml) | Promote or roll back one ring. Require merged source, provenance from the trusted hosted build, applicable receipt and protected environment approval. Check the public route from the runner; the environment link is the resulting demo URL. |
| [infra.yml](../.github/workflows/infra.yml) | Manual Bicep what-if, no apply by default. Protected apply repeats the preview for the same commit, group and subscription. Reject missing, changed, unsupported or destructive plans; publish counts and fingerprint, not payloads. |
| [checks.yml](../.github/workflows/checks.yml) | On-demand observation of one ring. No idle runner during bake and no scheduler in Actions. Paid staging evals are a separate future capability; keep `LIVE_EVALS_ENABLED` off for the demo. |

### What admits the demo

Single-revision Container Apps ingress retains the serving revision until the replacement passes readiness. The trusted [control job](../infra/control/controller.mjs) verifies **five demo checks**: correct commit and runtime mode, readiness, browser-only landing page, compiled assets, and denied private API routes. CI separately exercises the browser's fictional answer/reset journey. Production requires a **30-minute** bake and an observation no more than **two hours old**, for the currently staged digest; the runner also rechecks the staged public route. No "healthy" receipt is written for failed smoke. These checks **do not certify** the account-enabled app.

The [admission policy](../scripts/check-release.mjs) reads `rings/staging/current.json` in the **staging blob container** for production promotion. Rollback reads `history/<ring>/<commit>/<digest-hex>.json` in the **destination ring's container**. Receipts bind the profile, deployment ID, commit, digest and checks; rollback evidence must be no more than 30 days old. Retain the corresponding registry manifests and evidence for at least 30 days. The public profile has no database schema or private worker state to rewind.

The [job runner](../scripts/invoke-ops-job.ps1) copies the installed, digest-pinned control template, overrides only its arguments and observes **that execution**. The controller takes a renewable blob lease, rechecks admission/freeze, rejects older run IDs and records a pending generation before switching. After a failed check it restores and verifies the previous healthy digest or, for a first deployment, disables external ingress. Monitor jobs check the actual image and cannot deploy an app. Treat permission to start **either** trusted job as privileged: Azure execution overrides can use its identity. Deploy and monitor use distinct identities; neither has cross-ring write access.

### Incidents and future activation

Freeze promotions or request an explicit rollback as described in the [runbook](deploy-demo.md#operate-or-roll-back). If a job times out or routing cannot be restored, the operation is **unknown**, not successful. Inspect the actual revision, execution and receipt before replaying the same run. Never manufacture a passing receipt.

Before enabling **real candidates**, provide tenant isolation, verified identity, durable production storage with an exercised restore, compatible migrations and worker routing. Keep real data, credentials and notification destinations separate. The full-service staging journeys remain sample/reset; evidence through mock/debrief/retry; free cap and tenant isolation; Stripe **test** checkout/renewal/cancellation/webhook replay; and compatible migration/worker/notification delivery. Changed agent policy also needs an approved, budgeted staging evaluation. Do not reuse demo evidence for these gates. See [livesite objectives](operations.md#observability-alerts-and-livesite).

**References:** [GitHub environment protection](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [artifact attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations), [Azure job override permissions](https://learn.microsoft.com/en-us/azure/container-apps/jobs), [Understory CI and agent eval separation](https://github.com/k-rush/understory/tree/0534db053e986e88a4bf52637a3c154f4857ec78/.github/workflows), and [PatrolOps immutable release promotion](https://github.com/k-rush/patrolops/tree/9fc040ca45e08caf50d11a72c080847dc2886f78/.github/workflows).
