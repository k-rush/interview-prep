import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, values, type Act, type Fact, type Workspace } from "./client";
import { Round } from "./Round";
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
    <p className="intro">Save what you actually did. Practice a hiring-manager round, then revisit the answer that needs work.</p>
    <section><h2>Start without an account or card</h2>
      <p>The sample stays in this tab. Your local workspace saves on this computer and reopens in this browser. It is not a signed-in cloud account. Use non-confidential examples on a shared device.</p>
      <div className="actions"><a className="button quiet" href="#sample">Try a fictional sample</a>
        <button disabled={busy} onClick={async () => {
          setBusy(true); try { await api("workspace", "POST"); location.hash = "workspace"; }
          catch (e) { setError(String(e)); } finally { setBusy(false); }
        }}>Open my local workspace</button></div>
      {error && <p role="alert">{error}</p>}
    </section></>;
}

function Evidence({ fact, act, busy }: { fact: Fact; act: Act; busy: boolean }) {
  const editor = <form onSubmit={e => {
    e.preventDefault(); const body = values(e.currentTarget);
    void act(() => api(`evidence/${fact.id}/confirm`, "POST", body));
  }}>
    <p>Original statement:</p><blockquote>{fact.source}</blockquote>
    <label>Statement to keep<textarea name="claim" required maxLength={2000} defaultValue={fact.claim} /></label>
    <div className="actions"><button disabled={busy}>{fact.confirmed ? "Save correction" : "Confirm fact"}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(() => api(`evidence/${fact.id}`, "DELETE"))}>
        {fact.confirmed ? "Forget fact" : "Discard proposal"}</button></div>
  </form>;
  return <article className="item"><p className="eyebrow">{fact.confirmed ? "Confirmed" : "Needs your review"} / candidate statement</p><h3>{fact.project}</h3>
    {fact.confirmed ? <><p>{fact.claim}</p><details><summary>Edit or forget this fact</summary>{editor}</details></> : editor}</article>;
}

function Studio({ id }: { id?: string }) {
  const [data, setData] = useState<Workspace | null>(null);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  const locked = useRef(false);
  useEffect(() => {
    let active = true;
    api<Workspace>("workspace").then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); });
    return () => { active = false; };
  }, []);
  const act: Act = async action => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await action(); if (location.hash.startsWith("#workspace")) setData(await api<Workspace>("workspace")); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save. Try again."); }
    finally { locked.current = false; setBusy(false); }
  };
  const mock = data?.mocks.find(m => m.id === id);
  return <>{error && <p className="error" role="alert">{error}</p>}{busy && <p role="status">Saving&hellip;</p>}
    {!data ? <p>{error ? <a href="#">Return home</a> : "Opening workspace..."}</p> :
      id ? (mock ? <Round key={id} mock={mock} data={data} act={act} busy={busy} /> :
        <p>No such attempt in this workspace. <a href="#workspace">Back to workspace</a></p>) :
      <><p className="eyebrow">Local workspace / no billing</p><h1>My practice</h1>
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
              const m = await api<{ id: string }>("mocks", "POST", { target: body.target, tailor: body.tailor === "on" });
              location.hash = `workspace/${m.id}`;
            });
          }}>
            <label>Role or short job description<textarea name="target" required maxLength={2000} /></label>
            {data.localCoachEnabled && <label><input type="checkbox" name="tailor" /> Use the local model to tailor the questions. Sends only this role or job description.</label>}
            <button disabled={busy}>Start text mock</button>
          </form>
          {data.mocks.map(m => <div className="item" key={m.id}><strong>{m.target}</strong>
            <p>{new Date(m.startedAt).toLocaleDateString()} &middot; {m.report ? `${m.report.score}/100 (${m.report.grade}) / ${m.report.assessor === "self" ? "self-assessed" : "local coach"}` : `${m.answers.length}/4 answers saved`}</p>
            <a href={`#workspace/${m.id}`}>{m.report ? "View debrief" : "Resume mock"}</a></div>)}
        </section>
        <details><summary>Workspace privacy and deletion</summary><p>This browser token lasts 30 days. Delete the workspace to remove its facts, transcripts, debriefs and retries from the app.</p>
          <button className="quiet" disabled={busy} onClick={() => {
            if (window.confirm("Permanently delete this local workspace and all its practice records?"))
              void act(async () => { await api("workspace", "DELETE"); location.hash = ""; });
          }}>Delete my workspace</button></details>
      </>}
  </>;
}

function App() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const changed = () => { setHash(location.hash); window.scrollTo(0, 0); };
    addEventListener("hashchange", changed); return () => removeEventListener("hashchange", changed);
  }, []);
  const [page, id] = hash.slice(1).split("/");
  return <><header><a href="#">Interview Prep</a><span>Practice studio</span></header><main>
    {page === "workspace" ? <Studio id={id} /> : page === "sample" ? <Sample /> : <Home />}
  </main></>;
}

createRoot(document.getElementById("root")!).render(<App />);
