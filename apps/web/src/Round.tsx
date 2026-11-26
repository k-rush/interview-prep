import { useEffect, useState } from "react";
import { api, values, type Act, type Mock, type Workspace } from "./client";
import { VoiceInput } from "./Voice";

export function Round({ mock, data, act, busy }: { mock: Mock; data: Workspace; act: Act; busy: boolean }) {
  const { probes } = data;
  const index = mock.answers.length;
  const report = mock.report;
  const [answer,setAnswer] = useState(""), [notice,setNotice] = useState("");
  const submit = (path: string, body: unknown) => act(() => api(`mocks/${mock.id}/${path}`, "POST", body));
  const transcript = mock.answers.join(" ").toLowerCase();
  const words = (s: string) => new Set(s.toLowerCase().match(/\b[a-z][a-z-]{3,}\b/g)?.filter(w => !["with","that","have","this","they","from","team","were","into","would","their"].includes(w)) ?? []);
  const terms = words(mock.target + " " + transcript);
  const examples = data.facts.filter(f => f.confirmed && !transcript.includes(f.claim.toLowerCase()))
    .map(f => ({f, fit:[...words(f.project+" "+f.claim)].filter(w=>terms.has(w)).length})).filter(x=>x.fit>0).sort((a,b)=>b.fit-a.fit).slice(0,3);
  const normalized=(s:string)=>s.trim().replace(/\s+/g," ").toLowerCase();
  const known=new Set(data.facts.flatMap(f=>[normalized(f.claim),normalized(f.source)]));
  const newDetails=mock.answers.map((text,i)=>({text,i})).filter(({text})=>text.length<=2000 && /\bI (?:personally )?(?:\w+ed|wrote|ran|built|led|chose|made|took)\b/i.test(text) && !known.has(normalized(text)))
    .filter(({text},i,all)=>all.findIndex(other=>normalized(other.text)===normalized(text))===i).slice(0,3);
  return <>
    <a href="#workspace">Back to workspace</a>
    <p className="eyebrow">Hiring-manager practice / {mock.rubric} / {mock.tailored ? "locally tailored questions" : "standard questions"}</p>
    <h1>{report ? "Your debrief" : "Practice round"}</h1>
    <p className="target">{mock.target}</p>
    {!report && index < probes.length && <section>
      <p className="eyebrow">Question {index + 1} of {probes.length} / {probes[index].name}</p>
      <h2>{mock.questions[index]}</h2>
      <form key={index} onSubmit={e => { e.preventDefault(); void act(async () => {
        await api(`mocks/${mock.id}/answers`, "POST", { index, text:answer, question:mock.questions[index] }); setAnswer("");
      }); }}>
        <VoiceInput value={answer} onChange={setAnswer} label="Your answer" required maxLength={3000} name="text" prompt={mock.questions[index]} />
        <button disabled={busy}>Save answer</button>
      </form>
      <p className="muted">Submitted answers are saved. {mock.adaptive && "The local coach may adapt the next probe to your answer. "}
        You can leave between questions and resume; an unfinished round has no grade.</p>
    </section>}
    {!report && index === probes.length && <section>
      <h2>Assess the transcript</h2>
      <p>Only these four answers count. Impact must reach 3/4 and the total must reach 75/100 for a simulated hire.</p>
      {data.localCoachEnabled && <div className="callout"><p>The local model will receive the role and four answers, not your experience library. No cloud model is configured.</p>
        <button disabled={busy} onClick={() => void submit("report", { assessor: "local" })}>Ask the local coach</button></div>}
      <h3>Offline wording screen</h3><p>Get immediate feedback without a model or self-ratings. This checklist looks for evidence in the wording of each answer. It can miss paraphrases, cannot judge truth, and awards at most 3/4 per answer.</p>
      <button disabled={busy} onClick={()=>void submit("report",{assessor:"wording-v1"})}>Run offline wording screen</button>
      <h3>Self-assessment</h3>
      <p>No model needed. Rate the evidence you actually gave: 0 = none, 1 = claim only, 2 = partial, 3 = meets the anchor, 4 = unusually strong.</p>
      <form onSubmit={e => {
        e.preventDefault(); const ratings = values(e.currentTarget);
        void submit("report", { assessor: "self", points: probes.map(p => Number(ratings[p.name])) });
      }}>
        {probes.map((p, i) => <div className="item" key={p.name}>
          <h3>{p.name}</h3><p>{mock.questions[i]}</p><blockquote>{mock.answers[i]}</blockquote>
          <p>{p.anchor}</p>
          <label>{p.name} rating<select name={p.name} required defaultValue="">
            <option disabled value="">Choose points</option>
            {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n} / 4</option>)}
          </select></label>
        </div>)}
        <button disabled={busy}>Save self-assessment</button>
      </form>
    </section>}
    {report && <>
      <section><p className="eyebrow">{report.assessor === "self" ? "Self-assessed / not an AI evaluation" : report.assessor === "local" ? "Local model assessment / not calibrated" : "Offline wording screen / limited confidence / not an AI evaluation"}</p>
        <h2>{report.score}/100 ({report.grade}) &middot; {report.verdict}</h2>
        <p>A practice decision, not an employer prediction. The pass line is 75 and impact must be at least 3/4.</p>
        {report.marks.map((m, i) => <div className="item" key={probes[i].name}>
          <h3>{probes[i].name}: {m.points}/4</h3><blockquote>{m.quote}</blockquote><p>{m.feedback}</p>
          <details><summary>Review answer and propose new experience</summary><p>{mock.questions[i]}</p><blockquote>{mock.answers[i]}</blockquote>
            <form onSubmit={e=>{e.preventDefault();const body=values(e.currentTarget);void act(async()=>{
              await api(`mocks/${mock.id}/proposals`,"POST",{index:i,...body});setNotice("Proposal saved for your review in My experience. It is not a confirmed fact.");
            });}}><label>Project for this proposal<input name="project" required maxLength={100} /></label>
            <label>Exact excerpt of your answer<textarea name="excerpt" required maxLength={2000} defaultValue={mock.answers[i].slice(0,2000)} /></label>
            <button disabled={busy}>Propose experience for review</button></form></details>
        </div>)}
      </section>
      {!!newDetails.length && <section><h2>New experience you mentioned</h2><p>These answers mention work in your own words. Nothing enters your library unless you choose it and confirm the resulting proposal.</p>
        {newDetails.map(({text,i})=><div className="item" key={i}><strong>Answer {i+1}: {probes[i].name}</strong><blockquote>{text}</blockquote>
          <form onSubmit={e=>{e.preventDefault();const {project}=values(e.currentTarget);void act(async()=>{await api(`mocks/${mock.id}/proposals`,"POST",{index:i,excerpt:text,project});setNotice("Proposal ready for review in your experience library.");});}}>
            <label>Project for answer {i+1}<input name="project" required maxLength={100} defaultValue="Unfiled mock example"/></label><button disabled={busy}>Review this as new experience</button>
          </form></div>)}
        <a href="#workspace/library">Open experience library</a></section>}
      <section><h2>Examples for next time</h2>
        <p>These are your confirmed statements to consider, not evidence used to raise this grade.</p>
        {examples.length ? <ul>{examples.map(({f}) =>
          <li key={f.id}><strong>{f.project}:</strong> {f.claim} <small>Source: {f.origin}.</small></li>)}</ul> :
          <p>No relevant, unused confirmed statement was found. Bring another example or tell the builder what evidence is missing.</p>}
        <h3>Practice framing, using only your words</h3>
        <p><strong>Decision:</strong> {mock.answers[1]} <strong>Observed result:</strong> {mock.answers[2]}</p>
        <p>{probes[report.retryIndex].drill} This is a rehearsal outline, not a new experience claim.</p>
      </section>
      <section><p className="eyebrow">Ungraded drill / {probes[report.retryIndex].name}</p><h2>Retry one answer</h2>
        <p>{probes[report.retryIndex].drill}</p><p>Original answer:</p><blockquote>{mock.answers[report.retryIndex]}</blockquote>
        {mock.retry ? <><h3>Saved retry</h3><blockquote>{mock.retry}</blockquote></> :
          <form onSubmit={e => { e.preventDefault(); void submit("retry", values(e.currentTarget)); }}>
            <label>Your revised answer<textarea name="text" required maxLength={3000} rows={4} /></label>
            <button disabled={busy}>Save ungraded retry</button>
          </form>}
        <p className="muted">The original transcript and verdict do not change.</p>
      </section>
      <Review mock={mock} data={data} act={act} busy={busy}/>
      {notice && <p role="status">{notice}</p>}
    </>}
    <details><summary>Forget this practice round</summary><p>Remove its transcript, grade, challenges and experience proposals, including facts you confirmed from this round. Its usage is not refunded.</p>
      <button type="button" className="quiet" disabled={busy} onClick={()=>{if(window.confirm("Permanently forget this round and its derived facts?"))
        void act(async()=>{await api(`mocks/${mock.id}`,"DELETE");if(typeof BroadcastChannel!=="undefined"){const ch=new BroadcastChannel("practice-library");ch.postMessage("changed");ch.close();}location.hash="workspace";});}}>Delete round and derived facts</button></details>
  </>;
}

type ReviewState = { votes:{item:string;vote:string;reason:string}[]; challenges:{turn:number;excerpt:string;note:string;secondOpinion:string|null}[];
  checks:{check:string;passed:boolean}[] };
function Review({mock,data,act,busy}:{mock:Mock;data:Workspace;act:Act;busy:boolean}) {
  const [review,setReview] = useState<ReviewState|null>(null), [turn,setTurn] = useState(0), [error,setError] = useState("");
  const path = `mocks/${mock.id}`;
  const refresh = async () => setReview(await api<ReviewState>(`${path}/review`));
  useEffect(()=>{refresh().catch(e=>setError(e.message));},[path]);
  return <section><h2>Rate this feedback</h2>{error && <p role="alert">{error}</p>}
    <form onSubmit={e=>{e.preventDefault();const body=values(e.currentTarget);void act(async()=>{
      await api(`${path}/feedback`,"POST",body);await refresh();
    });}}><label>Feedback item<select name="item"><option value="report">Whole report</option>{data.probes.map(p=><option key={p.name}>{p.name}</option>)}</select></label>
      <label>Rating<select name="vote"><option value="up">Thumbs up</option><option value="down">Thumbs down</option></select></label>
      <label>Reason (optional)<select name="reason"><option value="">No reason</option>{["helpful","wrong fact","unfair grade","irrelevant","unsupported"].map(s=><option key={s}>{s}</option>)}</select></label>
      <button disabled={busy}>Save feedback</button></form>
    {review?.votes.map(v=><p key={v.item}>Saved: {v.item} / thumbs {v.vote}{v.reason && ` / ${v.reason}`}</p>)}
    <details><summary>Challenge an assessment</summary><p>Attach your objection to the answer. The original result is preserved; there is no human review service.</p>
      <label>Competency to challenge<select value={turn} onChange={e=>setTurn(Number(e.target.value))}>{data.probes.map((p,i)=><option key={p.name} value={i}>{p.name}</option>)}</select></label>
      <p>Published anchor: {data.probes[turn].anchor}</p><blockquote>{mock.answers[turn]}</blockquote>
      <form key={turn} onSubmit={e=>{e.preventDefault();const body=values(e.currentTarget);void act(async()=>{
        await api(`${path}/challenges`,"POST",{turn,excerpt:body.excerpt,note:body.note,askLocalCoach:body.second==="on"});await refresh();
      });}}><label>Passage from your answer<textarea name="excerpt" required maxLength={320} defaultValue={mock.report!.marks[turn].quote}/></label>
        <label>Why you disagree<textarea name="note" required maxLength={600}/></label>
        {data.localCoachEnabled && <label><input type="checkbox" name="second"/> Request a second local scoring pass on the original transcript</label>}
        <button disabled={busy}>Save challenge</button></form>
      {review?.challenges.map(c=><div className="item" key={c.turn}><strong>{data.probes[c.turn].name} challenge</strong><blockquote>{c.excerpt}</blockquote>
        <p>{c.note}</p><p>{c.secondOpinion ?? "No validated second opinion recorded."}</p></div>)}</details>
    {!!review?.checks.length && <details><summary>Online assessment checks</summary>{review.checks.map((c,i)=><p key={i}>{c.check}: {c.passed?"passed":"rejected"}</p>)}</details>}
    <small>Votes and challenges do not change the grade or grant training consent.</small>
  </section>;
}
