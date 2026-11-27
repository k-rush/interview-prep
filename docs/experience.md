# Candidate experience

The workspace opens on **New chat** with editable starters for building job history, practicing a question, finding matching jobs and planning an interview. They are examples, not categories. **Job experience**, **Agent memory** and **Schedule** are reachable from the sidebar or mobile drawer. **Account** owns the daily-search toggle.

### User stories and acceptance criteria

| As a candidate, I want to... | Done when... |
| --- | --- |
| Try the coach before sharing my resume or card | **Try a sample** opens a fictional, resettable mock and debrief with no signup. **Use my experience** starts a separate free account: I can confirm a fact, take a real text mock, read the whole report and retry one weak answer before deciding whether to pay. |
| Start with a resume, my LinkedIn, or neither | PDF/DOCX import proposes editable fields with source locations. A LinkedIn URL can be saved; without an approved history integration I can upload my own profile export or paste my experience. "Talk me through it" works with no document. |
| Bring evidence my resume leaves out | From any role or project I can add a performance review, written referral or recommendation, project write-up, portfolio/repository link, or other work sample. I see where each proposed fact came from and choose which uses to allow. Adding a link alone doesn't claim I authored the project. |
| Build a resume from a conversation | The builder asks about the role I'm seeking, employers, dates, projects, my own actions, trade-offs and outcomes. It asks one useful follow-up at a time. I can skip, mark an outcome unknown, and export a base resume from approved details. |
| See and control what the agent remembers | I can edit or delete individual entries in **Agent memory** without rewriting a transcript. Separately I can inspect, edit, merge, reject or forget a claim in **Job experience** and choose whether to use it in applications. |
| Prepare for a specific round | I can paste, upload or link a JD, or just describe the job. I see the company's sourced context, missing information, round type, duration and competencies before I start. A generic role still works without a company. |
| Plan backward from my interview and see whether I'm improving | I enter my interview date and availability. The coach proposes dedicated mock, feedback-review and drill blocks that I can move or skip. From my plan I can start a mock, open its results, and compare completed attempts to see what's improving and what still needs practice. |
| Practice under realistic conditions | The coach plays a **simulated hiring manager** in text or voice, asks one question at a time, follows up on my actual answer and tracks time. No suggested answers mid-mock. An explicitly assisted drill is separate from a scored attempt. |
| Learn from an uncomfortable result | A completed mock shows a grade, hire/no-hire decision, confidence, answer evidence, better framing, unused examples and gaps. I can challenge an assessment or retry without erasing the original. |
| Reuse something I said during practice | Work examples from a normal question or a scored mock add to job history and agent memory. A repeated statement can gain a source instead of a duplicate. New claims need my approval before reuse in drafts. Reviewing or editing them never changes a grade. |
| Remember my best examples during a real interview | I can preview a handful of short reminders and open them when notes are permitted. One bold cue is visible at a time; I can choose a topic, mark it covered, or pause without missing the conversation. The guide never supplies an answer or grades the real interview. |
| Delegate discovery, not my identity | I confirm the public title in chat. Search results are compared against my workspace locally. I can ask for daily results or keep the search as a one-off. No application is sent. |

### A first visit and a returning visit

The public landing page has two choices: **Try a sample** (about 90 seconds, labeled fictional) and **Start free** (verified account, no card). Keep sample selections in this tab; never copy them into the candidate's history. After the free debrief, offer **Keep my library free** alongside **Explore Prep**. Until a price is chosen, show the tier differences, not a purchase button. When billing launches, show the actual price, renewal date and cancellation terms before purchase. See [proposed allowances](operations.md#billing-and-unit-economics).

```text
TODAY                                      MY EXPERIENCE
Next round: [Add a job or describe it]     Roles > Platform engineer > Release tooling
Start with what you have:                  Confirmed: Piloted rollout with two teams.
[Upload resume] [Link LinkedIn] [Talk]     Source: builder, turn 4   [View] [Edit]
                                           New from practice: "I wrote the rollback guide."
Returning: Practice your impact example    [Confirm] [Edit first] [Reject]
[Resume mock] [Review 1 suggested fact]    Include in drafts [yes]     [Forget]
```

The builder first asks what job the candidate wants and how much time they have. It turns "we migrated the release process" into a useful follow-up: **"Which decision was yours, and how did you know the rollout was safe?"** If they don't know a metric, record that gap rather than proposing a plausible number. On exit, show what changed, what remains unclear, and a preview of the base resume. Returning candidates can go straight to practice; a complete profile is not a prerequisite.

### Supporting documents and project links

In **Job experience** or **Chat**, drop a document or use the file picker. A new, resumable import chat reads it and searches the candidate's existing history. No title, category, project or excerpt selection is required. The local AI produces a short description under **Saved sources** and proposes cited roles, projects, situations and statements. The chat reports new and corroborating evidence; when two records might represent the same project or job, the candidate can link them, keep them separate, or skip. To leave out private details, paste an edited copy instead. A project or LinkedIn URL stays a bookmark, not an assertion of authorship. Reviews and referrals stay private unless the candidate confirms individual statements and permits a specific use.

For example, a review credits *the team* with a safer rollout. The project page describes its rollback checklist. Neither says who wrote it. The builder asks **"Which part was yours?"** The candidate can confirm *"I wrote the checklist,"* link both sources and their own clarification, and approve the short label *rollback pilot* for live reminders. The source card shows the page or link and date; a reviewer's praise isn't converted into a metric, and the referrer's name never appears on the reminder.

### Interview prep schedule and readiness

**Today > Plan for this interview** asks: *When is the round, and when can you realistically practice?* The coach works backward from the interview time in the candidate's timezone. Where time permits, it proposes a baseline mock, time to act on the feedback, and a fresh follow-up mock. The candidate approves the blocks and can opt in to reminders. If a full mock won't fit, show the conflict and offer a shorter drill; don't book outside the available windows.

Example: **Senior platform engineer, hiring-manager round | Fri Dec 11, 2026 at 14:00 | America/Chicago**

| Local time | Reserved prep time | What the candidate sees |
| --- | --- | --- |
| Mon Dec 7, 18:00-18:25 | Baseline mock | **75/100 (C), simulated no-hire.** Impact 2/4 missed the required 3. Open report. |
| Tue Dec 8, 18:00-18:15 | Review feedback and drill impact | Find one observed outcome from the rollout. Practice explaining how you know it happened. |
| Wed Dec 9, 18:00-18:25 | Follow-up mock, fresh questions, same rubric | **81.25/100 (B), simulated hire.** Impact rose to 3/4; the other three scores held steady. Open report. |
| Thu Dec 10, 18:00-18:10 | Final rehearsal | Try a different example of impact. **Start drill** or **Move block**. |

**Progress** shows dated mock results and competency changes, not a count of calendar checkmarks. In this example the gain is **6.25 points** and the candidate now meets the impact floor. The readiness label is **On track: one passing mock**, not a prediction of a job offer. Compare only full, unassisted mocks for the same target version, level, round and rubric. Within the last 30 days: no comparable mock means **Not assessed**; a latest miss means **Needs practice** with the limiting competency; two consecutive passing mocks mean **Consistent in practice**. A single result is a baseline, not a trend. Show drills, incomplete attempts and older or different-rubric results separately, never as zeroes.

If the candidate misses a block or the interview moves, keep completed results on their actual dates and propose new times for unfinished blocks only. Changing a plan never starts a paid mock. Candidates can opt to keep score history beyond detailed report expiry without retaining their answers.

### Preparing and practicing a round

```text
PREPARE A ROUND                            MOCK IN PROGRESS
Senior platform engineer | Hiring manager  Q3 of 4                08:24 remaining
[Paste JD] [Upload] [Link] [Describe]       How did you decide the pilot was ready
Focus: ownership, judgment, impact, clarity to expand?
Impact is a must-have for this round.      [Speak] [Type instead] [Repeat question]
Research: 2 official sources; no verified  Transcript: You chose a two-team pilot...
candidate reports. [Inspect sources]       [Correct transcription] [Pause] [End]
[20 minutes] [Voice / Text] [Start]        Private practice. Microphone: off.
```

**Voice is a mode, not a different agent.** Both sessions support push-to-talk, visible mic state, editable captions before submission, optional spoken replies, interruption of playback and switching to text without losing the turn. Explain speech processing before requesting mic access; no raw recording saved by default. If recognition is uncertain, ask the candidate to confirm the words. After an interruption or reconnect, replay the *committed transcript*, never manufacture the missing audio. Use keyboard controls, screen-reader status announcements, transcript-first feedback and an untimed option. No scoring of accent, speaking speed, pauses or disability-related characteristics.

### What an honest debrief looks like

At setup, pin four role-specific competencies, equal weights for this first rubric, and any must-have floors. For each competency score 0-4: **0** no relevant evidence after a fair probe; **1** claim only; **2** partially supported; **3** specific, role-level evidence; **4** unusually strong evidence against that competency's published anchor. For example, senior-level impact at 3 requires an observed outcome and an explanation of how the candidate knows, not necessarily a number. *Not asked* is not zero.

For a completed mock, `score = 100 * sum(points) / 16`. Letter cutoffs: A >=90, B >=80, C >=70, D >=60, otherwise F. **Hire** requires score >=75 **and** all predeclared must-haves >=3; otherwise **no-hire**. Compare unrounded scores. A full attempt needs at least three substantive answers and a fair probe of every required competency. Early exits, substantial transcription loss or an interviewer that missed a required probe get an **incomplete** report and a resume action, not a fabricated verdict. Confidence reflects coverage and evidence quality, not a hiring probability.

```text
SENIOR PLATFORM ENGINEER | hiring-manager practice | rubric v1
75/100 (C)   SIMULATED NO-HIRE   Confidence: moderate
Ownership 3/4 | Judgment 3/4 | Impact 2/4 (must reach 3) | Clarity 4/4

What you said [Q3, turn 8]: "We rolled it out and it went well."
Why it mattered: You explained the decision, but not what changed for users.
Better framing: Name the risk, your decision, the signal you watched,
and what actually happened. If you don't know the outcome, say so.

Example you didn't use: Release tooling > Two-team pilot [view source].
It establishes scope, not success. We didn't add points for it.
Still missing: One observed outcome, qualitative or quantitative.
Next drill: Explain how you knew it was safe to expand, in 90 seconds.
[Retry this answer] [Review 1 new fact] [Thumbs up] [Thumbs down / challenge]
```

Show strengths as well as misses, and a side-by-side answer rewrite using **only** what the candidate actually said or separately confirmed. For the example above: *"I chose to start with two teams rather than migrate everyone at once. That limited the scope of a rollback. I can explain that decision; I don't have a measured success rate."* Label this **practice phrasing**, not a quote or new evidence. If there is no suitable library example, ask for one rather than inventing it. A retry is a new attempt; compare the same competency and rubric, not grades from unrelated roles. Never present the simulation as a hiring decision by the real company.

### Live interview guide

Before the real round, open **Practice > Prepare live reminders**, pick the target role, and preview up to five cards. Choose a short project label instead of a client name; remove, reorder, or rehearse any card. If the interview doesn't allow notes or assistance, use the deck beforehand only. Starting the guide does **not** start a mock, mic, recording, or timer that bills for voice.

| During the conversation | The entire cue, in large bold type |
| --- | --- |
| The interviewer asks about ownership; the candidate taps **Ownership** | **Mention the rollback pilot.** |
| The candidate finishes describing the action and taps **Result** | **What changed as a result?** |
| The conversation turns to collaboration; no approved project fits | **Separate your contribution from the team's.** |

Show one line of at most eight words with **Covered**, **Later**, **Pause**, and **End** controls. No paragraphs to read aloud, invented results, audible prompts, or screen-share-hiding overlay. Make controls keyboard accessible, high contrast, and quiet by default. In manual mode the app does not listen. On supported devices, a separately enabled **adaptive mode** can select an already approved card at a topic change or pause. Use it only with interview permission and the consent of everyone whose speech could be heard. Keep **Listening on this device** and **Stop listening** visible. If consent changes, stop immediately; manual cards remain available if notes are allowed.

Ending clears the live view. Covered cards are a personal checklist, not evidence of what the candidate said. No transcript, score, hire/no-hire call or automatic memory update follows a real interview. If desired, the candidate can later tell the builder their own recollection.

### Job search in a conversation

```text
Candidate: Find jobs that match my experience.
Coach:     Search for "Platform engineer"? Confirm it or type another public title.
Candidate: Yes.
Coach:     Here are public links, ordered by role and overlap with your workspace.
           Would you like me to run this search daily?
Candidate: Not now.
```

Each link identifies its source. Wording overlap is a reason to read the posting, not proof of an opening, qualification, pay or eligibility. Empty results are distinct from an unavailable source. An opted-in search repeats while the host runs; turning it off in Account does not delete past results.
