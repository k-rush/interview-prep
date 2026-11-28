# Running evals and releasing prompts

The [scenario plan](prompt-evaluation-plan.md) defines the behaviors. The source of instructions is `apps/api/Prompts`: one reviewable text file per stable ID and a `release.json` contract/version. These are **literal templates**. The app supplies role, transcript, excerpts or search results separately as structured user data, so a candidate's braces or template-looking text cannot execute. There are no loops, includes, helpers or filesystem access; Scriban would add capability none of these prompts need. Provider parameters, tools, authorizations, output schemas and validators remain in code.

## Run a candidate

```powershell
.\dev.ps1 eval replay                         # build Release, check contracts, run the matrix
.\dev.ps1 eval replay match-gap               # one scenario, all its variants
.\scripts\model.ps1 connect                   # opt in to the installed, authenticated loopback model
.\dev.ps1 eval live mock-strong               # actual model, disposable synthetic workspaces
```

For machine-readable evidence, after the Release build:

```powershell
node .\evals\run.mjs --lane replay --report "$env:TEMP\coach-replay.json"
# After connecting the bundled model, pin the installed weights for both live runs.
$weights = Join-Path $env:LOCALAPPDATA 'InterviewPrep\inference\qwen2.5-1.5b-instruct-q4_k_m.gguf'
$env:INTERVIEW_PREP_EVAL_MODEL_REVISION = (Get-FileHash -Algorithm SHA256 -LiteralPath $weights).Hash.ToLowerInvariant()
node .\evals\run.mjs --lane live --store $baselineStore --report "$env:TEMP\coach-baseline.json"
node .\evals\run.mjs --lane live --store $candidateStore --report "$env:TEMP\coach-candidate.json"
node .\evals\compare.mjs "$env:TEMP\coach-baseline.json" "$env:TEMP\coach-candidate.json"
```

Use the **same** corpus, API binary, case selection, provider/model build and decoding settings for baseline and candidate. Pin a different read-only scratch store for each (below); don't run the comparison against a moving serving pointer. For another loopback model, set `INTERVIEW_PREP_EVAL_MODEL_REVISION` to a lowercase SHA-256 for the loaded weights or immutable deployment revision and retain the runtime build ID alongside the reports. This is the operator's attestation, not a proof provided by the server. An unpinned comparison is exploratory: an alias can change behind the same port. An author's model or context tier is not the model under test. Both eval lanes use recorded job-search results and set `INTERVIEW_PREP_RESEARCH_OFFLINE=1` to deny company and job-page requests before DNS. Public search provider protocol is covered separately by `ScoutWebSearchChecks`, not measured as a live search-quality win.

**Read `stillFailing`, not just `regressions`.** In a two-conversation calibration of `1.0.0` versus `1.0.1` on the bundled Qwen2.5-1.5B model, the baseline passed neither case. The candidate filed the held role and both cited projects in `import-resume/two-work-orders`. It returned an accepted, cited scorecard for `mock-strong/shadow-ledger`, but at least one mark was outside its reference band. The comparator correctly reported *no new failures* and *one still failing*. This small run did not clear the candidate for promotion; an earlier provider timeout is not evidence that wording alone improved quality.

**Review what an assertion can't measure.** Reserve fresh synthetic examples outside the prompt-tuning loop. The automated reports deliberately omit transcripts. For each family, a coordinator runs the same held-out journey in two disposable workspaces on the pinned packs, captures the user-visible replies, and randomizes A/B per case. Give two reviewers the fictional source material and both replies, not the pack names or assignment key. Each independently marks **0** (wrong/unsupported), **1** (safe but generic or incomplete) or **2** (specific and useful) on the following axes. Record opaque case ID, axis, marks, rationale and adjudication in a private release receipt; do not copy private candidate conversations.

| Family | What separates 2 from 1 | Hard fail regardless of style |
| --- | --- | --- |
| Story | A listener can identify the candidate's decision, its context and observed outcome; if one is missing, the follow-up elicits that one detail. | Invented metric, swapped ownership, or a failure rewritten as a success. |
| Posting | A named example supports a particular job requirement; the coach explains a material gap instead of padding the match. | A preference or job-posting requirement presented as a qualification; another workspace's evidence. |
| Import | The candidate can trace each entry to its passage and resolve an actual ambiguity with one decision. | Invented title/date, unapproved merge or escalation of draft/live permissions. |
| Mock | A neutral question tests the next competency and feedback explains one attainable improvement using the corresponding answer. | Hint during scoring, outside evidence, unsupported quote, employer prediction or grading an incomplete attempt. |
| Prep | The candidate knows the next practice step, how it fits the available time, and exactly what must be confirmed. | Unapproved lookup/booking, guessing an ambiguous local time, or presenting a rehearsal question as an actual employer question. |

Review individual regressions and disagreement, not just mean scores. Follow the [operating thresholds](operations.md#feedback-and-model-quality) for a calibrated pilot; label small samples and unrun slices as such. A green replay alone never clears a new pack for model quality.

## Independent publication and rollback

The initial app release installs the loader and an embedded safe default. On a private practice host, configure `INTERVIEW_PREP_PROMPT_STORE` **once** to an absolute, trusted directory outside the web root and user data. Leave it unset to keep using the embedded pack. Mount a separate store per ring; give the service identity read access and only the release operator write access. Use a filesystem that supports exclusive create and atomic rename/replace within a directory. The public, backend-free demo does not load a pack.

1. Change an instruction and bump `release.json`'s `major.minor.patch` version. Keep ID set, wire shapes and authority compatible. Commit for review. A new ID, required variable, semantic change to a rubric/permission, or changed tool/output contract needs a matching app release. Never put secrets, private examples, or data URLs in a prompt.
2. Build the **artifact once** into a new file, install it into a scratch/test store and atomically select it. On `main` the [prompt-only workflow](../.github/workflows/prompt-pack.yml) runs the offline gate against that store and retains the exact pack and its replay report in `coach-prompts-<commit>` for 30 days. Wording/corpus-only pushes do not publish or deploy the app image. Download the evaluated file rather than rebuilding for a later ring. The equivalent local path below needs no Actions run. Installation alone does not affect a running reader:

   ```powershell
   $artifact = Join-Path $env:TEMP "coach-$([guid]::NewGuid()).json"
   $candidateStore = Join-Path $env:TEMP "coach-ring-$([guid]::NewGuid())"
   $release = node .\scripts\prompt-pack.mjs build $artifact | ConvertFrom-Json
   node .\scripts\prompt-pack.mjs install $artifact $candidateStore
   node .\scripts\prompt-pack.mjs activate $candidateStore $release.digest none
   node .\evals\run.mjs --lane replay --store $candidateStore
   ```

3. Run the paired live lane and review the evidence. The target ring's authorized operator records the previous **serving** digest from `/healthz`; verify it matches `prompt-pack.mjs status STORE` for a ring with an existing pointer. Keep its installed artifact for rollback. For first activation, install the current embedded default in the target store too, so it can be reselected explicitly.
4. Copy the same file to the operator's release environment, `install FILE STORE`, verify the reported digest against the reviewed receipt, then `activate STORE NEW_DIGEST PREVIOUS_DIGEST` (`none` only when there is no pointer). Check `/healthz` on each serving replica and exercise a synthetic workflow. A digest is content identity, **not authorization**: release approvals, artifact transport and mount ACLs are operator responsibilities. This is a local/mounted-store deployment path, not an unattended production publisher.
5. To roll back, `activate STORE PREVIOUS_DIGEST NEW_DIGEST`. No image rebuild, model update, database migration or app restart. Keep the same confirmation, per-replica check and synthetic smoke. Archive approved artifacts for the rollback window. No deployment here modifies an existing host, Azure resource or registry automatically.

**Failure semantics.** The active pointer is one digest, not a path or URL. The loader bounds and validates the whole artifact, and pins its immutable snapshot across all model calls in a request. Canonical content identity is SHA-256 over UTF-8 `interview-prep-prompts/1`, version and sorted ID/body pairs, each NUL-terminated (CRLF normalized, trailing line breaks removed). This makes a Windows checkout and a Linux image agree. A missing, corrupted or incompatible selection retains the last verified pack in the running process; after a cold start the embedded default is the safe fallback. Alert on a **serving digest mismatch**, not just HTTP 200. Publisher writes are serialized and activation checks the observed predecessor. If a publisher dies holding `.writer.lock`, confirm no other writer remains and inspect the pointer/installed artifacts before the operator removes that one lock. Never edit `active` or `releases` in place to promote.
