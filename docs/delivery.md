# Delivery plan for one person or a small team

Build one thin, deployable candidate journey at a time. Keep product behavior, prompt/tool versions, data migrations, evaluations, infrastructure and runbooks under review together. The design packet, [GitHub Actions and release-policy checks](releases.md#the-workflow-inventory) exist. The application, infrastructure, contributor skills and local `dev.ps1` commands below are **planned**, not already implemented.

### Proposed monorepo

```text
apps\
  web\                      React/TypeScript: screens, accessible voice/text UI
  api\                      ASP.NET Core host: auth, streaming, billing, static web
  worker\                   Queue consumer and timer/maintenance entry points
src\
  Core\                     Evidence, Sessions, Assessment, Discovery, Entitlements
  Adapters\                 Postgres, object store, queue, model, speech, sources
contracts\                  OpenAPI, stream events, JSON tool/output schemas
agents\                     Product prompts, capability manifests, rubric versions
db\migrations\              Schema, tenant policies, indexes, reversible rollout notes
evals\                      Synthetic cases, expected evidence, replays, comparison runner
tests\                      Domain, two-tenant integration, web journey, recovery fixtures
infra\bicep\                Staging/production resources, identities, alerts, budgets
ops\runbooks\               Incident, recovery, provider outage, cost spike, deletion
scripts\                    Bootstrap, synthetic checks, migrations and release tasks
docs\                       Design, source policy, architecture decisions
.github\workflows\          CI, offline eval, guarded live eval, deploy and rollback
.github\skills\<skill>\     SKILL.md plus safe helper scripts/fixtures as needed
AGENTS.md                   Repo map, invariants, commands and permission boundaries
dev.ps1                     One entry point for common contributor tasks
```

`Core` doesn't import cloud SDKs or a chat framework. Put adapter interfaces on the consuming side. Both hosts run the same policy and domain logic; never duplicate fact approval in a worker prompt. Generate typed client bindings from contracts. One Postgres migration history and one versioned artifact manifest per release. Avoid generic shared utility packages and independently deployed "agents" until there is an ownership or scaling reason.

**Local path:** target a fresh clone -> `.\dev.ps1 up` (local Postgres, blob emulator, in-process queue and fake identity/model) -> `.\dev.ps1 seed` (two synthetic candidates) -> open the web app. `.\dev.ps1 test` is deterministic; `.\dev.ps1 eval replay` needs no API key. A live eval is a separate opt-in command against a test account with an explicit case set and spend ceiling. Test real queue locks, email/webhook signing, identity, object grants and speech in isolated staging; local fakes do not prove cloud wiring.

### AI skills: contributor workflows, not runtime permissions

Author each contributor skill as a short `SKILL.md`: trigger, required inputs, allowed commands/environments, output artifact, stop condition and actions requiring approval. Default to local synthetic data or read-only diagnostics. No unattended deploy, production mutation, customer-content access, or paid evaluation just because a contributor invoked a skill.

| Proposed skill | Input -> useful output | Guardrail |
| --- | --- | --- |
| `ship-slice` | Acceptance story + relevant contract -> smallest vertical diff, migration impact, targeted tests and preview steps | One user journey; no new service without an architecture decision. |
| `change-agent` | Prompt/tool/rubric change + failing fixture -> version bump, replay diff, blind live comparison plan and cost delta | Synthetic/licensed cases only. Explicit approval and spend cap for live calls; no self-approval of grading changes. |
| `review-memory-migration` | Proposed schema/retention change -> two-tenant, correction, erasure, reindex and restore tests; expand/contract plan | Block cross-owner references or a destructive migration in the deploy step. |
| `onboard-source` | Source type and allowed uses -> adapter contract, redaction/TTL policy, provenance fixture and denied-link fallback | Distinguish private candidate evidence from public catalogs. Read-only, no bypassing an access denial or sharing private imports. |
| `trace-run` | Redacted operation ID + environment -> stage timeline, latency/cost attribution, probable cause and safe next check | Metadata only; no raw prompts, credentials or transcripts in a PR/issue. |
| `release-or-rollback` | Candidate version + environment -> deployment diff, gate results, smoke checklist and previous compatible revision | Read-only diagnosis by default; named human approval for prod/prompt promotion. Never roll data back with app code. |
| `recover-work` | Queue/ledger alert + effect key -> dry-run of affected steps, deduplication checks and narrowly scoped replay command | Show environment, blast radius and notification/charge effects; operator authorizes execution. No blanket DLQ drain. |

The **runtime** capability manifests under `agents` are different: context extraction, source research, interviewing, grading, evidence-backed writing. They are bound to typed application tools and tenant scope, not developer tools, shells, deploy credentials or operator skills. The [runtime table](architecture.md#runtime-capabilities) defines their actual authority.

### CI/CD and safe change

The [release runbook](releases.md) is authoritative for triggers, permissions, bake times and rollback. PRs get credential-free checks. A protected `main` build produces **one signed digest** for staging -> production. Only staging deploys automatically; production requires fresh staging evidence and approval. Infrastructure and paid live evals have separate approvals. Keep cloud flags off until their prerequisites exist.

On a solo team, minimize approvals but not evidence: deterministic gates, a protected production action, explicit release notes and a rollback target. A second person is most valuable calibrating blind grades, reviewing privacy/rights changes and acting as backup incident owner, not maintaining additional services.

### Milestones and exit criteria

Indicative weeks are sequencing assumptions for an experienced solo builder, not delivery commitments. Start with a single role family, US English, one region and one payment currency.

| Milestone | Ship | Gate to proceed |
| --- | --- | --- |
| 0. Prove the promise (week 1) | Click-through of the [wireframes](experience.md), concierge review with synthetic examples, small human-authored rubric and source/processor policy. | Candidates understand the difference between "you said" and "you could have used"; two reviewers can apply the same rubric. Recruit 20 consented pilot candidates. |
| 1. Private text alpha (weeks 2-4) | Auth, tenant isolation, builder, inspectable library and base resume, pasted/described JD, text mock, report, challenge and retry. Add an interview-date prep plan and comparable mock history once scorecards exist. Fake external providers in CI; deploy to staging from day one. | Same accepted fact survives a new session but can't raise a grade if unused. Finish a mock after disconnect, reschedule the next one, and see both completed results without counting skipped blocks. Verify correction/deletion and run the chatbot comparison before widening scope. |
| 2a. Evidence and interview pilot (weeks 5-7) | Resume/JD import, LinkedIn export, reviews, referrals, work samples and permitted project links; redaction, source-backed proposals, sourced mock prep, both practice voice modes, quotas and evals. | A review and project link can support the same story without claiming team accomplishments as personal ones. Denied links still work as bookmarks. A mic-denied candidate finishes a mock in text; calibration, latency and cost gates pass. |
| 2b. Live reminder pilot (before paid discovery) | Prepared, candidate-approved cards, target/topic selection, single bold cue, covered/later/pause and manual mode with no mic. Gate optional on-device adaptive selection separately by device capability and consent. | Rehearse a complete round with no cloud speech or answer generation. Revoking mic consent leaves manual cards usable; withdrawing a fact removes its personalized cue. No scorecard is created. Compare distraction and recall against paper notes. |
| 3. Paid discovery beta (weeks 8-10) | Checkout/Portal, permitted board roster, daily local-time runs, evidence-scored matches, draft pair/diff/export, inbox/email, pause/cancel. | Duplicate timer ticks, DST, provider timeouts and webhook disorder produce no duplicate digest or debit. Confirm coverage and paid conversion using the [market experiments](market.md). |
| 4. Launch hardening (before public GA) | Restore/deletion drill, pressure test expected concurrency, accessibility and privacy review, rights sign-off, support coverage, dunning and incident processes. | Record measured p95 latency/spend, timed recovery and calibrated verdict agreement. If quality or economics miss, cap invitations and iterate instead of launching unlimited usage. |

**Defer:** native apps, full-duplex voice, global job crawling, employer dashboards, autonomous applications, custom model training and multiple active regions. Generated answers during real interviews and covert meeting capture are not part of the live guide. Reopen infrastructure decisions when there is a measured trigger: e.g. add vector retrieval only when full-text plus typed links misses labeled examples, add a paid feed only when useful digests justify its minimum, and split the worker only when batch load threatens report latency despite separate queues and capacity.
