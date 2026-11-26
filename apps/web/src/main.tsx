import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, RequestError, values, type Act, type Fact, type Workspace } from "./client";
import { Chat, ChatHistory } from "./Chat";
import { Round } from "./Round";
import { ArchivedConversation, Experience } from "./Experience";
import { Discovery } from "./Discovery";
import { Accounts, LandingAccount } from "./Accounts";
import { LiveGuideView } from "./LiveGuide";
import { PreparationView } from "./Preparation";
import "./style.css";

function Sample() {
  const [pick, setPick] = useState("");
  return <><p className="eyebrow">Fictional sample / browser only</p><h1>Find the missing evidence</h1>
    <section><p>Avery answered the impact question: <q>The rollout went well.</q> Their project notes say that they piloted it with two teams and checked support tickets afterward.</p>
      <h2>What could Avery add?</h2><div className="actions"><button onClick={() => setPick("source")}>How they checked the result</button>
        <button className="quiet" onClick={() => setPick("invented")}>An estimated percentage improvement</button></div>
      {pick && <div role="status" className="callout"><strong>{pick === "source" ? "Use the observation." : "A number needs evidence."}</strong>
        <p>Checking tickets explains how Avery looked for impact. It does not establish that tickets decreased.</p>
        <button className="quiet" onClick={() => setPick("")}>Reset sample</button></div>}</section><a href="#">Back to start</a></>;
}

function Home() {
  const [error,setError] = useState(""), [busy,setBusy] = useState(false);
  return <div className="welcome"><p className="eyebrow"><span className="status-dot"/> Private interview studio</p>
    <h1>Your experience.<br/>Your next interview.</h1><p className="intro">Build your story, rehearse the hard questions, and make a plan with a coach who remembers your work.</p>
    <div className="actions"><button disabled={busy} onClick={async () => {
      setBusy(true); try { await api("workspace","POST"); location.hash = "workspace"; } catch(e) {setError(String(e));} finally {setBusy(false);}
    }}>Open my local workspace</button><a className="button quiet" href="#sample">Try a fictional sample</a></div>
    {error && <p role="alert">{error}</p>}<p className="privacy-line">No card. Saved in this browser’s workspace on this computer. Use non-confidential examples on a shared device.</p>
    <a className="minor-link" href="#signin">Sign in with a verified account</a></div>;
}

function Evidence({ fact, act, busy }: { fact: Fact; act: Act; busy: boolean }) {
  const notify = () => { if (typeof BroadcastChannel !== "undefined") {const ch = new BroadcastChannel("practice-library");ch.postMessage("changed");ch.close();} };
  const editor = <form onSubmit={e => { e.preventDefault(); const v = values(e.currentTarget);
    void act(async () => {await api(`evidence/${fact.id}/confirm`,"POST",{claim:v.claim,allowDrafts:v.drafts==="on",allowLive:v.live==="on"});notify();});
  }}><p>Original statement:</p><blockquote>{fact.source}</blockquote>
    <label>Statement to keep<textarea name="claim" required maxLength={2000} defaultValue={fact.claim}/></label>
    <label><input type="checkbox" name="drafts" defaultChecked={fact.allowDrafts}/> May use this fact in resumes and cover letters</label>
    <label><input type="checkbox" name="live" defaultChecked={fact.allowLive}/> May use a separately approved project label in live reminders</label>
    <div className="actions"><button disabled={busy}>{fact.confirmed ? "Save correction" : "Confirm fact"}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void act(async () => {await api(`evidence/${fact.id}`,"DELETE");notify();})}>
        {fact.confirmed ? "Forget fact" : "Discard proposal"}</button></div></form>;
  return <article className="item"><p className="eyebrow">{fact.confirmed ? "Confirmed" : "Needs your review"} / {fact.origin}</p><h3>{fact.project}</h3>
    {fact.confirmed ? <><p>{fact.claim}</p><details><summary>Edit or forget this fact</summary>{editor}</details></> : editor}</article>;
}

function Icon({ kind }: { kind: string }) {
  const paths: Record<string,string> = {library:"M3 7h7l2 2h9v10H3z M3 7V5h7l2 2h8",chat:"M4 4h16v12H9l-5 4z M8 9h8 M8 12h5",
    prep:"M4 6h16v14H4z M8 3v5 M16 3v5 M4 10h16 M8 14h3"};
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[kind]}/></svg>;
}

function Studio({ page = "chat", id }: { page?: string; id?: string }) {
  const [data,setData] = useState<Workspace | null>(null), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  const locked = useRef(false), lastChat = useRef("#workspace");
  useEffect(() => { let active = true; api<Workspace>("workspace").then(d => { if (active) setData(d); }).catch(e => { if (active) setError(e.message); });
    return () => {active=false;}; }, []);
  useEffect(() => { if (page === "chat") lastChat.current = id ? `#workspace/chat/${id}` : "#workspace"; }, [page,id]);
  const act: Act = async action => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await action(); if (location.hash.startsWith("#workspace")) setData(await api<Workspace>("workspace")); }
    catch(e) {setError(e instanceof Error ? e.message : "Could not save. Try again.");
      if (e instanceof RequestError && e.status === 409) await api<Workspace>("workspace").then(setData).catch(()=>{});}
    finally {locked.current = false; setBusy(false);}
  };
  if (!data) return <p role={error?"alert":"status"}>{error || "Opening your workspace…"} {error && <a href="#">Return home</a>}</p>;
  const props = {data,act,busy}, active = page === "library" ? "library" : page === "prep" || page === "live" ? "prep" : "chat";
  const mock = data.mocks.find(m => m.id === (page === "debrief" ? id : page));
  return <>{error && <p role="alert" className="error">{error}</p>}
    <nav aria-label="Workspace sections" className="tabs">{[["library","Job experience","#workspace/library"],["chat","Chat",lastChat.current],["prep","Schedule","#workspace/prep"]].map(([k,label,url]) =>
      <a key={k} aria-current={active === k ? "page" : undefined} href={url}><Icon kind={k}/>{label}</a>)}</nav>
    {page === "library" ? <><Experience {...props}/>{data.facts.length > 0 && <section><h2>Review your statements</h2>
      {data.facts.map(f => <Evidence key={`${f.id}-${f.confirmed}-${f.claim}`} fact={f} act={act} busy={busy}/>)}</section>}</> :
      page === "prep" ? <PreparationView {...props} key={id} initialTarget={id}/> : page === "live" ? <LiveGuideView {...props}/> :
      page === "jobs" ? <Discovery {...props}/> : page === "history" ? <ChatHistory {...props}/> :
      page === "archive" && id ? <ArchivedConversation key={id} id={id} act={act} busy={busy}/> :
      page === "account" ? <><Accounts {...props}/><details><summary>Workspace privacy and deletion</summary>
        <p>Deleting this workspace removes its library, chats, notes, plans, scout inbox and practice history. Local browser workspaces expire after 30 days.</p>
        <button className="quiet" disabled={busy} onClick={() => {if(confirm("Permanently delete this workspace and all its records?"))
          void act(async () => {await api("workspace","DELETE");location.hash="";});}}>Delete my workspace</button></details></> :
      mock ? (mock.chatSession && page !== "debrief" ? <Chat key={mock.id} {...props} id={mock.id}/> : <Round key={mock.id} mock={mock} {...props}/>) :
      page === "chat" || page === "new" ? <Chat key={`${page}-${id ?? ""}`} {...props} id={page === "chat" ? id : undefined} newKind={page === "new" ? id : undefined}/> :
      <p>Page not found. <a href="#workspace">Open Chat</a></p>}
  </>;
}

function App() {
  const [hash,setHash] = useState(() => { const q = new URLSearchParams(location.search);return q.get("mode")==="signIn" || q.has("link") ? "#signin" : location.hash; });
  useEffect(() => { const changed = () => {setHash(location.hash);window.scrollTo(0,0);}; addEventListener("hashchange",changed);return () => removeEventListener("hashchange",changed);},[]);
  const [root,page,id] = hash.slice(1).split("/"), studio = root === "workspace";
  return <><header><a className="brand" href={studio ? "#workspace" : "#"}><span className="brand-mark" aria-hidden="true">i.</span>Interview Prep</a>
    {studio ? <a className="account-link" href="#workspace/account">Account</a> : <span className="edition">Practice studio</span>}</header>
    <main className={studio ? "workspace" : ""}>{studio ? <Studio page={page} id={id}/> : root === "sample" ? <Sample/> :
      root === "signin" ? <><a href="#">Back to start</a><h1>Account sign-in</h1><LandingAccount/></> : <Home/>}</main></>;
}
createRoot(document.getElementById("root")!).render(<App/>);
