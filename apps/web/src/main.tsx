import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, assessorName, RequestError, values, type Act, type Fact, type Workspace } from "./client";
import { Round } from "./Round";
import { Experience } from "./Experience";
import { Discovery } from "./Discovery";
import { Accounts, LandingAccount } from "./Accounts";
import { LiveGuideView } from "./LiveGuide";
import { PreparationView } from "./Preparation";
import "./style.css";

function Sample() {
  const [pick, setPick] = useState("");
  return <><p className="eyebrow">Fictional sample / browser only</p><h1>Find the missing evidence</h1>
    <section><p>Avery answered the impact question: <q>The rollout went well.</q> Their project notes say that they piloted it with two teams and checked support tickets afterward.</p>
      <h2>What could Avery add?</h2>
      <div className="actions"><button onClick={() => setPick("source")}>How they checked the result</button>
        <button className="quiet" onClick={() => setPick("invented")}>An estimated percentage improvement</button></div>
      {pick && <div role="status" className="callout"><strong>{pick === "source" ? "Use the observation." : "A number needs evidence."}</strong>
        <p>Checking tickets explains how Avery looked for impact. It does not establish that tickets decreased. The original answer gets no credit for notes Avery didn't mention.</p>
        <button className="quiet" onClick={() => setPick("")}>Reset sample</button></div>}
    </section><a href="#">Back to start</a></>;
}

function Home() {
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  return <><p className="eyebrow">Practice studio / local alpha</p><h1>Prepare with your own evidence.</h1>
    <p className="intro">Build your experience library, plan for an interview, practice the round and find roles that fit your evidence.</p>
    <section><h2>Start without an account or card</h2>
      <p>The sample stays in this tab. Your local workspace saves on this computer and reopens in this browser. It is not a signed-in cloud account. Use non-confidential examples on a shared device.</p>
      <div className="actions"><a className="button quiet" href="#sample">Try a fictional sample</a>
        <button disabled={busy} onClick={async () => {
          setBusy(true); try { await api("workspace", "POST"); location.hash = "workspace"; }
          catch (e) { setError(String(e)); } finally { setBusy(false); }
        }}>Open my local workspace</button></div>
      {error && <p role="alert">{error}</p>}
    </section><section><h2>Use a verified account</h2><p>On a configured installation, sign in with an email link to use the Free plan or review Prep allowances. No card or automatic upgrade.</p>
      <a href="#signin">Sign in or check availability</a></section></>;
}

function Evidence({ fact, act, busy }: { fact: Fact; act: Act; busy: boolean }) {
  const notify = () => { if(typeof BroadcastChannel!=="undefined"){const ch=new BroadcastChannel("practice-library");ch.postMessage("changed");ch.close();}};
  const editor = <form onSubmit={e => {
    e.preventDefault(); const body = values(e.currentTarget);
    void act(async () => {await api(`evidence/${fact.id}/confirm`, "POST", {claim:body.claim,allowDrafts:body.drafts==="on",allowLive:body.live==="on"});notify();});
  }}>
    <p>Original statement:</p><blockquote>{fact.source}</blockquote>
    <label>Statement to keep<textarea name="claim" required maxLength={2000} defaultValue={fact.claim} /></label>
    <label><input type="checkbox" name="drafts" defaultChecked={fact.allowDrafts} /> May use this fact in resumes and cover letters</label>
    <label><input type="checkbox" name="live" defaultChecked={fact.allowLive} /> May use a separately approved project label in live reminders</label>
    <div className="actions"><button disabled={busy}>{fact.confirmed ? "Save correction" : "Confirm fact"}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(async()=>{await api(`evidence/${fact.id}`, "DELETE");notify();})}>
        {fact.confirmed ? "Forget fact" : "Discard proposal"}</button></div>
  </form>;
  return <article className="item"><p className="eyebrow">{fact.confirmed ? "Confirmed" : "Needs your review"} / {fact.origin}</p><h3>{fact.project}</h3>
    {fact.confirmed ? <><p>{fact.claim}</p><details><summary>Edit or forget this fact</summary>{editor}</details></> : editor}</article>;
}

function Today({data}:{data:Workspace}) {
  type Summary={next:{role:string;label:string;targetId:string;attemptId:string|null;startsAt:string}|null;digest:{localDate:string;status:string;nextStep:string}|null};
  const [summary,setSummary]=useState<Summary|null>(null);
  useEffect(()=>{let active=true;api<Summary>("today").then(result=>{if(active)setSummary(result);}).catch(()=>{});
    return ()=>{active=false;};},[data]);
  const unfinished=data.mocks.find(m=>!m.report), proposals=data.facts.filter(f=>!f.confirmed).length;
  return <section><h2>What to do next</h2>
    {summary?.next && <p><strong>{summary.next.label}</strong> for {summary.next.role}: {new Date(summary.next.startsAt).toLocaleString()}.{" "}
      <a href={`#workspace/${summary.next.attemptId ?? `prep/${summary.next.targetId}`}`}>Open scheduled practice</a></p>}
    {unfinished && <p><a href={`#workspace/${unfinished.id}`}>Continue your unfinished round</a> ({unfinished.answers.length} of 4 answers saved).</p>}
    {proposals>0 && <p><a href="#workspace/library">Review {proposals} proposed experience {proposals===1?"statement":"statements"}</a> before using them elsewhere.</p>}
    {summary?.digest && <p><a href="#workspace/jobs">Scout digest for {summary.digest.localDate}</a>: {summary.digest.status}. {summary.digest.nextStep}</p>}
    {!summary?.next && !unfinished && !proposals && !summary?.digest && <p>Start with <a href="#workspace/library">one project you know well</a>, then <a href="#workspace/prep">set the target for your first round</a>.</p>}
  </section>;
}

function Studio({ id, targetId }: { id?: string; targetId?: string }) {
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    let active = true;
    api<Workspace>("workspace").then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const act: Act = async action => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await action(); if (location.hash.startsWith("#workspace")) setData(await api<Workspace>("workspace")); }
    catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Try again.");
      if(e instanceof RequestError && e.status===409 && location.hash.startsWith("#workspace"))
        await api<Workspace>("workspace").then(setData).catch(()=>{});
    }
    finally { locked.current = false; setBusy(false); }
  };
  const mock = data?.mocks.find(m => m.id === id);
  const tools = data && {data,act,busy};
  const pages = {"library":"Experience builder","prep":"Targets & schedule","live":"Live reminders","jobs":"Job scout","account":"Account & usage"};
  return <>{error && <p className="error" role="alert">{error}</p>}{busy && <p role="status">Saving&hellip;</p>}
    {data && <nav aria-label="Workspace sections"><a href="#workspace" aria-current={!id?"page":undefined}>My practice</a>
      {Object.entries(pages).map(([key,name])=><a key={key} href={`#workspace/${key}`} aria-current={id===key?"page":undefined}>{name}</a>)}</nav>}
    {!data ? <p>{error ? <a href="#">Return home</a> : "Opening workspace..."}</p> :
      id==="library" && tools ? <><Experience {...tools}/><section><h2>Review and edit your facts</h2>{data.facts.map(f=><Evidence key={`${f.id}-${f.confirmed}-${f.claim}`} fact={f} act={act} busy={busy}/>)}</section></> :
      id==="prep" && tools ? <PreparationView key={targetId} {...tools} initialTarget={targetId}/> : id==="live" && tools ? <LiveGuideView {...tools}/> :
      id==="jobs" && tools ? <Discovery {...tools}/> : id==="account" && tools ? <Accounts {...tools}/> :
      id ? (mock ? <Round key={id} mock={mock} data={data} act={act} busy={busy} /> :
        <p>No such attempt in this workspace. <a href="#workspace">Back to workspace</a></p>) :
      <><p className="eyebrow">Interview preparation studio</p><h1>My practice</h1>
        <Today data={data}/>
        <section><h2>My experience</h2><p>What did you personally do on a project? Name your action or decision. Add an observed result if you know it.</p>
          <form onSubmit={e => {
            e.preventDefault(); const form = e.currentTarget, body = values(form);
            void act(async () => { await api("evidence", "POST", body); form.reset(); });
          }}>
            <label>Project name<input name="project" required maxLength={100} /></label>
            <label>Your statement<textarea name="statement" required maxLength={2000} /></label>
            <button disabled={busy}>Review proposed fact</button>
          </form>
          {data.facts.map(f => <Evidence key={`${f.id}-${f.confirmed}-${f.claim}`} fact={f} act={act} busy={busy} />)}
        </section>
        <section><h2>Practice a round</h2><p>Four behavioral questions. No hints during the round. A project is helpful, not required.</p>
          <form onSubmit={e => {
            e.preventDefault(); const body = values(e.currentTarget);
            void act(async () => {
              const m = await api<{ id: string }>("mocks", "POST", { target: body.target, tailor: body.tailor === "on",requestId:requestId.current });
              requestId.current=crypto.randomUUID();
              location.hash = `workspace/${m.id}`;
            });
          }}>
            <label>Role or short job description<textarea name="target" required maxLength={2000} /></label>
            {data.localCoachEnabled && <label><input type="checkbox" name="tailor" /> Use the local model to tailor the questions. Sends only this role or job description.</label>}
            <button disabled={busy}>Start text mock</button>
          </form>
          {data.mocks.map(m => <div className="item" key={m.id}><strong>{m.target}</strong>
            <p>{new Date(m.startedAt).toLocaleDateString()} &middot; {m.report ? `${m.report.score}/100 (${m.report.grade}) / ${assessorName(m.report.assessor)}` : `${m.answers.length}/4 answers saved`}</p>
            <a href={`#workspace/${m.id}`}>{m.report ? "View debrief" : "Resume mock"}</a></div>)}
        </section>
        <details><summary>Workspace privacy and deletion</summary><p>A local browser workspace expires in 30 days. Deleting a workspace removes its library, plans, scout inbox and practice history. A verified account requires a recent sign-in and cancellation of any test renewal first.</p>
          <button className="quiet" disabled={busy} onClick={() => {
            if (window.confirm("Permanently delete this local workspace and all its practice records?"))
              void act(async () => { await api("workspace", "DELETE"); location.hash = ""; });
          }}>Delete my workspace</button></details>
      </>}
  </>;
}

function App() {
  const [hash, setHash] = useState(()=>{
    const query=new URLSearchParams(location.search);
    return query.get("mode")==="signIn" || query.has("link") ? "#signin" : location.hash;
  });
  useEffect(() => {
    const changed = () => { setHash(location.hash); window.scrollTo(0, 0); };
    addEventListener("hashchange", changed); return () => removeEventListener("hashchange", changed);
  }, []);
  const [page, id, targetId] = hash.slice(1).split("/");
  return <><header><a href="#">Interview Prep</a><span>Practice studio</span></header><main>
    {page === "workspace" ? <Studio id={id} targetId={targetId} /> : page === "sample" ? <Sample /> :
      page === "signin" ? <><a href="#">Back to start</a><h1>Account sign-in</h1><LandingAccount/></> : <Home />}
  </main></>;
}

createRoot(document.getElementById("root")!).render(<App />);
