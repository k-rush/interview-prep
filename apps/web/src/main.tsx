import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { api, RequestError, type Act, type ChatSession, type Workspace } from "./client";
import { Chat, ChatHistory } from "./Chat";
import { Brand, Compass, Icon, StarterLabel, starts } from "./CareerUI";
import { WorkspaceShell } from "./WorkspaceShell";
import { AgentMemory, DailySearchSetting } from "./AccountPreferences";
import { Round } from "./Round";
import { ArchivedConversation, Experience } from "./Experience";
import { Discovery } from "./Discovery";
import { Accounts, LandingAccount } from "./Accounts";
import { LiveGuideView } from "./LiveGuide";
import { PreparationView } from "./Preparation";
import "./style.css";

function Sample({ standalone = false }: { standalone?: boolean }) {
  const [pick, setPick] = useState("");
  return <div className="public-page">{!standalone && <a className="back-link" href="#">Back to start</a>}<p className="eyebrow">Fictional sample / browser only</p><h1>Find the missing evidence</h1>
    <section><div className="speaker"><Compass/>Job search coach</div><p>Avery answered the impact question: <q>The rollout went well.</q> Their project notes say that they piloted it with two teams and checked support tickets afterward.</p>
      <h2>What could Avery add?</h2><div className="actions"><button onClick={() => setPick("source")}>How they checked the result</button>
        <button className="quiet" onClick={() => setPick("invented")}>An estimated percentage improvement</button></div>
      {pick && <div role="status" className="callout"><strong>{pick === "source" ? "Use the observation." : "A number needs evidence."}</strong>
        <p>Checking tickets explains how Avery looked for impact. It does not establish that tickets decreased.</p>
        <button className="quiet" onClick={() => setPick("")}>Reset sample</button></div>}</section></div>;
}

function Home({ privateTest, customer }: { privateTest: boolean; customer: boolean }) {
  const [error,setError] = useState(""), [busy,setBusy] = useState(false);
  async function open(prompt?: string) {
    if (busy) return;
    const from = location.hash;
    setBusy(true); setError("");
    try {
      await api("workspace","POST");
      if (location.hash === from) location.hash = prompt ? `workspace/new/${prompt}` : "workspace";
    } catch(e) {
      if (customer && e instanceof RequestError && e.status === 401) location.hash = "signin";
      else setError(e instanceof Error ? e.message : "Could not open the workspace.");
    }
    finally { setBusy(false); }
  }
  return <div className="welcome">
    <div className="welcome-copy"><p className="eyebrow"><span className="short-rule"/>Your job search workspace</p>
      <h1>Let’s work on<br/><em>your next move.</em></h1>
      <p className="intro">Find roles that fit, turn your experience into a stronger resume, and walk into interviews prepared. Start with a conversation.</p>
      <div className="actions"><button disabled={busy} onClick={() => void open()}>{customer ? "Open my workspace" : `Open my ${privateTest ? "test" : "local"} workspace`} <Icon name="arrow"/></button>
        <a className="button quiet" href="#sample">Try a fictional sample</a></div>
      {error && <p role="alert">{error}</p>}
      <p className="welcome-note"><Icon name="lock"/>{customer ? "Your workspace is private. Sign in with Apple, Google, Microsoft, or an Interview Prep account. No card required." : privateTest ? "Private Azure test. Use fictional examples only. Chats and relevant saved context go to Azure OpenAI; test data is deleted when staging expires." : "No card or account needed. Your local workspace is stored on this computer. Use non-confidential examples on a shared device."}</p>
    </div>
    <section className="start-panel"><div className="panel-heading"><Compass/><span>Job search coach</span></div>
      <h2>Where would you like to start?</h2><div className="start-list">{starts.map(s =>
        <button className="intent" key={s.slug} disabled={busy} onClick={() => void open(s.slug)}><StarterLabel {...s}/></button>)}</div>
      <small>Choose a prompt to edit or send in your workspace.</small>
    </section></div>;
}

function Studio({ page = "chat", id }: { page?: string; id?: string }) {
  const [data,setData] = useState<Workspace | null>(null), [error,setError] = useState(""), [busy,setBusy] = useState(false);
  const [sessions,setSessions] = useState<ChatSession[] | null>(null), [listError,setListError] = useState("");
  const [blankChat, setBlankChat] = useState(0);
  const locked = useRef(false);
  useEffect(() => { let active = true; api<Workspace>("workspace").then(d => { if (active) setData(d); }).catch(e => {
    if (!active) return;
    if (e instanceof RequestError && e.status === 401 && document.querySelector('meta[name="customer-sign-in"]')) location.hash = "signin";
    else setError(e.message);
  });
    return () => {active=false;}; }, []);
  const liveGuide = page === "live", historyPage = page === "history";
  useEffect(() => {
    if (!data || liveGuide) return;
    let active = true;
    api<ChatSession[]>("chats").then(rows => { if (active) {setSessions(rows); setListError("");} })
      .catch(e => { if (active) setListError(e.message); });
    return () => { active = false; };
  }, [data, id, liveGuide, historyPage]);
  const act: Act = async action => {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError("");
    try { await action(); if (location.hash.startsWith("#workspace")) setData(await api<Workspace>("workspace")); }
    catch(e) {setError(e instanceof Error ? e.message : "Could not save. Try again.");
      if (e instanceof RequestError && e.status === 409) await api<Workspace>("workspace").then(setData).catch(()=>{});}
    finally {locked.current = false; setBusy(false);}
  };
  if (!data) return <main className="opening"><Compass/><p role={error?"alert":"status"}>{error || "Opening your workspace…"} {error && <a href="#">Return home</a>}</p></main>;
  const props = {data,act,busy};
  const mock = data.mocks.find(m => m.id === (page === "debrief" ? id : page));
  const chatId = page === "chat" ? id : mock?.chatSession && page !== "debrief" ? mock.id : undefined;
  return <WorkspaceShell page={page} routeId={id} chatId={chatId} sessions={sessions} listError={listError}
    onNewChat={e => { if (page === "chat" && !id && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) setBlankChat(n => n + 1); }}
    localAI={data.localCoachEnabled} privateTest={data.privateTest} inChat={page === "chat" || page === "new" || !!chatId}>
    {error && <p role="alert" className="error">{error}</p>}
    {page === "library" ? <Experience {...props}/> :
      page === "prep" ? <PreparationView {...props} key={id} initialTarget={id}/> : page === "live" ? <LiveGuideView {...props}/> :
      page === "jobs" ? <Discovery {...props}/> : page === "history" ? <ChatHistory {...props} rows={sessions} listError={listError}/> :
      page === "archive" && id ? <ArchivedConversation key={id} id={id} act={act} busy={busy}/> :
      page === "memory" ? <AgentMemory {...props}/> :
      page === "account" ? <><p className="eyebrow">Settings &amp; privacy</p><h1>Your account</h1><DailySearchSetting {...props}/><Accounts {...props}/><details><summary>Workspace privacy and deletion</summary>
        <p>Deleting this workspace removes its job history, chats, agent memory, interview plans, saved job searches and practice history. Local browser workspaces expire after 30 days.</p>
        <button className="quiet" disabled={busy} onClick={() => {if(confirm("Permanently delete this workspace and all its records?"))
          void act(async () => {await api("workspace","DELETE");location.hash="";});}}>Delete my workspace</button></details></> :
      mock ? (mock.chatSession && page !== "debrief" ? <Chat key={mock.id} {...props} id={mock.id}/> : <Round key={mock.id} mock={mock} {...props}/>) :
      page === "chat" || page === "new" ? <Chat key={`${page}-${id ?? blankChat}`} {...props} id={page === "chat" ? id : undefined} newKind={page === "new" ? id : undefined}/> :
      <p>Page not found. <a href="#workspace">Open Chat</a></p>}
  </WorkspaceShell>;
}

function App() {
  const privateTest = !!document.querySelector('meta[name="private-synthetic-test"]');
  const customer = !!document.querySelector('meta[name="customer-sign-in"]');
  const [hash,setHash] = useState(() => { const q = new URLSearchParams(location.search);return q.get("mode")==="signIn" || q.has("link") ? "#signin" : location.hash; });
  useEffect(() => { const changed = () => {setHash(location.hash);window.scrollTo(0,0);}; addEventListener("hashchange",changed);return () => removeEventListener("hashchange",changed);},[]);
  const [root,page,id] = hash.slice(1).split("/"), studio = root === "workspace";
  if (studio) return <Studio page={page || undefined} id={id}/>;
  return <div className="public-shell"><header className="public-bar"><Brand href="#"/>
    {!privateTest && root !== "signin" && <a className="button quiet" href="#signin">Sign in <Icon name="arrow"/></a>}</header>
    <main>{root === "sample" ? <Sample/> : root === "signin" ? <div className="public-page"><a className="back-link" href="#">Back to start</a>
      <p className="eyebrow">Your workspace</p><h1>Account sign-in</h1><LandingAccount/></div> : <Home privateTest={privateTest} customer={customer}/>}</main></div>;
}
createRoot(document.getElementById("root")!).render(location.pathname === "/demo"
  ? <div className="public-shell"><main><Sample standalone/></main></div> : <App/>);
