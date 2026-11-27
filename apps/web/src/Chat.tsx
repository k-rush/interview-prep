import { useEffect, useRef, useState } from "react";
import { api, RequestError, streamTurn, type Act, type ChatSession, type Workspace } from "./client";
import { Discovery } from "./Discovery";
import { VoiceInput } from "./Voice";
import { DocumentImport } from "./ExperienceDocuments";
import { Compass, Icon, StarterLabel, chatUrl, modeName, modeIcon, starts } from "./CareerUI";

type Message = { id: string; speaker: string; text: string; mode: string; vote: string | null; nextChatId: string | null; requestId: string | null };
type Detail = { session: ChatSession; messages: Message[]; pendingSearch: string | null };
type Reply = { prompt: string; text: string; state: "writing" | "saved" | "stopped" };
type Props = { data: Workspace; act: Act; busy: boolean };
const date = (s: string) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });

export function Chat({ data, act, busy, id, newKind }: Props & { id?: string; newKind?: string }) {
  const [detail, setDetail] = useState<Detail | null>(null), [text, setText] = useState<string>(() => starts.find(s => s.slug === newKind)?.text ?? ""), [error, setError] = useState("");
  const [reply, setReply] = useState<Reply | null>(null);
  const pending = !!reply && reply.state !== "stopped";
  const generation = useRef<AbortController | null>(null), thread = useRef<HTMLDivElement>(null);
  const [attempt, retry] = useState(0);
  const documentRead = useRef<AbortController | null>(null), [readStopped, setReadStopped] = useState(false);
  const startKey = useRef(crypto.randomUUID()), turnKey = useRef(crypto.randomUUID());
  const mounted = useRef(true), last = useRef<HTMLLIElement>(null), scrollNext = useRef(false), form = useRef<HTMLFormElement>(null), refocus = useRef(false);
  const startMock = newKind === "mock";
  useEffect(() => {
    mounted.current = true;
    if (id) api<Detail>(`chats/${id}`).then(x => { if (mounted.current) { scrollNext.current = x.messages.length > 1; setDetail(x); if (x.pendingSearch) setText(x.pendingSearch); } }).catch(e => { if (mounted.current) setError(e.message); });
    else if (startMock) api<{id: string}>("chats", "POST", {kind:"mock", requestId: startKey.current}).then(x => {
      if (mounted.current) location.replace(chatUrl(x.id));
    }).catch(e => { if (mounted.current) setError(e.message); });
    else if (matchMedia("(pointer: fine)").matches) form.current?.querySelector("textarea")?.focus({ preventScroll: true });
    return () => { mounted.current = false; generation.current?.abort(); };
  }, [id, startMock]);
  useEffect(() => {
    if (scrollNext.current && last.current) { scrollNext.current = false; last.current.scrollIntoView({block: reply?.text ? "end" : "nearest"}); }
  }, [detail, reply]);
  useEffect(() => {
    if (!busy && refocus.current) {
      refocus.current = false;
      if (document.activeElement === document.body || form.current?.contains(document.activeElement))
        form.current?.querySelector("textarea")?.focus({preventScroll:true});
    }
  }, [busy]);
  const session = detail?.session;
  const pendingImport = session?.stage === "document:pending";
  useEffect(() => {
    if (!id || !pendingImport) return;
    let live = true; setError(""); setReadStopped(false);
    const controller = new AbortController(); documentRead.current = controller;
    api(`chats/${id}/import`, "POST", undefined, controller.signal).catch(e => {
      if (!controller.signal.aborted) throw e;
      if (live) setReadStopped(true);
    }).then(() => live ? api<Detail>(`chats/${id}`) : null).then(d => {
      if (live && d) { setDetail(d); if (d.session.stage !== "document:pending") void act(async () => {}); }
    }).catch(e => {if (live) setError(e.message);});
    return () => {live=false; controller.abort();};
  }, [id, pendingImport, attempt]);
  const send = (action: "say" | "finish") => {
    if (generation.current || pending || busy || action === "say" && !text.trim()) return;
    void act(async () => {
      const from = location.hash, current = () => mounted.current && location.hash === from;
      const controller = new AbortController(), { signal } = controller, requestId = turnKey.current;
      generation.current = controller;
      refocus.current = action === "say"; scrollNext.current = true;
      setError(""); setReply({prompt: action === "say" ? text.trim() : "Finish session", text: "", state: "writing"});
      let active = id;
      try {
        if (!active) active = (await api<{id:string}>("chats", "POST", { requestId: startKey.current }, signal)).id;
        const answer = await streamTurn(active, { text, action, requestId, revision: session?.revision ?? 0,
          zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" }, signal, delta => {
          if (!current() || signal.aborted) return;
          if (last.current && thread.current && last.current.getBoundingClientRect().bottom <= thread.current.getBoundingClientRect().bottom + 32)
            scrollNext.current = true;
          setReply(r => r && {...r, text: r.text + delta});
        });
        if (!current()) return;
        setReply(r => r && {...r, text: answer.text, state: "saved"});
        if (id !== answer.id) { location.hash = chatUrl(answer.id); return; }
        const latest = await api<Detail>(`chats/${id}`, "GET", undefined, signal);
        if (!current()) return;
        scrollNext.current = true; setDetail(latest);
        turnKey.current = crypto.randomUUID(); setText(""); setReply(null);
      } catch (e) {
        if (!current()) return;
        if (signal.aborted) {
          setReply(r => r && {...r, state: "stopped"});
          // Stop can race the commit. The saved transcript, not the preview, wins.
          if (active) {
            const latest = await api<Detail>(`chats/${active}`);
            if (!current()) return;
            const saved = latest.messages.find(m => m.requestId === requestId);
            if (id) setDetail(latest);
            if (saved) {
              setReply(null); setText(""); turnKey.current = crypto.randomUUID();
              if (id !== (saved.nextChatId ?? active)) location.hash = chatUrl(saved.nextChatId ?? active);
            }
          }
          return;
        }
        setReply(null);
        if (active && e instanceof RequestError && e.status === 409) {
          const latest = await api<Detail>(`chats/${active}`);
          if (!current()) return;
          if (id) setDetail(latest); else location.hash = chatUrl(active);
          turnKey.current = crypto.randomUUID();
        }
        throw e;
      } finally { generation.current = null; }
    });
  };
  const lastMsg = detail?.messages.at(-1);
  const rating = (m: Message, vote: string) => void act(async () => {
    await api(`chats/${id}/feedback/${m.id}`, "PUT", { vote: m.vote === vote ? null : vote });
    setDetail(await api<Detail>(`chats/${id}`));
  });
  const attachment = <DocumentImport compact change={act} busy={busy}/>;
  const composer = <form ref={form} className="composer" onSubmit={e => { e.preventDefault(); send("say"); }}>
    {pending ? <div className="composer-toolbar reply-controls"><span role="status">{reply.state === "saved" ? "Reply saved." : reply.text ? "Coach is replying…" : "Waiting for your coach…"}</span>
      {reply.state === "writing" && <button autoFocus className="quiet" type="button" onClick={() => generation.current?.abort()}>Stop reply</button>}</div> :
    <fieldset disabled={busy}><VoiceInput key={session?.revision ?? 0} label="Message your coach" maxLength={session?.kind === "mock" ? 3000 : 8000}
      required value={text} onChange={setText} prompt={lastMsg?.text}
      placeholder={session ? "Reply to your coach…" : "Ask about your job search…"}
      composer={{ attachment, send: <button className="send" type="submit" aria-label="Send" title="Send (Enter). Shift+Enter for a new line." disabled={!text.trim() || busy}><Icon name="send"/></button> }}/></fieldset>}
  </form>;
  if (!id && !startMock && !reply) return <div className="chat-page start-canvas"><div className="chat-start">
    <div className="chat-hero"><Compass/><p className="eyebrow">Your job search coach</p><h1>What’s your next move?</h1>
      <p className="intro">Tell me about a role, a project, or an interview on your calendar.</p></div>
    {composer}<p className="composer-note">Drop a resume or work sample to start a document chat.</p>
    <div className="starter-heading"><span/>Try a prompt · edit it or send it<span/></div>
    <div className="starters">{starts.map(s => <button key={s.slug} className="intent" type="button" onClick={() => {
      setText(s.text); form.current?.querySelector("textarea")?.focus();
    }}><StarterLabel {...s}/></button>)}</div>
    <p className="privacy-line"><span>Want a scored round instead? <a href="#workspace/new/mock">Start a mock interview</a>.</span></p>
    <p className="composer-note">Work examples can update your job history and <a href="#workspace/memory">agent memory</a>. Only approved facts can go into applications.</p>
  </div></div>;
  if (!detail && !reply) return <div className="opening"><Compass/>{error ? <p role="alert">{error} <a href="#workspace">Back to Chat</a></p> :
    <p role="status">Opening your conversation…</p>}</div>;
  return <div className="chat-page chat-thread"><div className="thread-scroll" ref={thread}><div className="thread-column">
    {error && <p role="alert" className="error">{error}</p>}
    <div className="thread-heading"><div className="session-info">{session && (session.kind === "mock" || session.kind === "import") && <span className={`badge ${session.kind}`}>
      <Icon name={modeIcon(session.kind)}/>{modeName(session.kind)}</span>}
      {session?.state === "closed" && <small>Finished session</small>}</div>
      <h1>{session?.title ?? "Your conversation"}</h1></div>
    <ol className="transcript" aria-label="Chat transcript" aria-live="polite" aria-busy={pending}>{detail?.messages.map((m,i) =>
      <li key={m.id} ref={!reply && i === detail.messages.length - 1 ? last : null}
        className={`${m.speaker} ${m.mode === "scorecard" || m.mode === "report" ? "artifact" : ""}`}>
        {m.speaker === "user" ? <small className="sr-only">You</small> : <div className="speaker"><Compass/>Coach <small>{m.mode}</small></div>}
        <p>{m.text}</p>{m.nextChatId && <a href={chatUrl(m.nextChatId)}>Open that session</a>}</li>)}
      {reply && <><li className="user"><small className="sr-only">You</small><p>{reply.prompt}</p></li>
        <li ref={last} className="assistant"><div className="speaker"><Compass/>Coach</div>{reply.text && <p>{reply.text}</p>}
          {reply.state === "stopped" && <small role="status">Reply stopped. This preview isn’t part of the saved conversation.</small>}</li></>}
    </ol>
    {session && <>{session.digestId && <Discovery data={data} act={act} busy={busy} digestId={session.digestId}/>}
      {session.targetId && <a className="button quiet" href={`#workspace/prep/${session.targetId}`}>View interview packet &amp; schedule</a>}
      {session.state === "closed" && session.kind === "mock" && data.mocks.find(m => m.id === id)?.report &&
        <a className="button quiet" href={`#workspace/debrief/${id}`}>Review scorecard, examples &amp; next drill</a>}
      {session.kind === "import" && (pendingImport ? <>
        {!error && <p role="status">{readStopped ? "Document analysis stopped. Your attachment is here to retry." : "Reading the attachment and searching your job history..."}</p>}
        {error || readStopped ? <button onClick={() => retry(n => n + 1)}>Retry document analysis</button> :
          <button className="quiet" onClick={() => documentRead.current?.abort()}>Stop document analysis</button>}</> :
        <a className="button quiet" href="#workspace/library">Review updated job history</a>)}
      <div className="session-tools">{session.state !== "closed" && !pendingImport && <button className="text-button" disabled={busy} onClick={() => send("finish")}>Finish session</button>}
        {!reply && lastMsg?.speaker === "assistant" && <details><summary>Rate reply</summary><div className="actions">{["up","down"].map(v =>
          <button key={v} className="quiet" disabled={busy} aria-pressed={lastMsg.vote === v} onClick={() => rating(lastMsg,v)}>{v === "up" ? "Helpful" : "Unhelpful"}</button>)}</div></details>}
        <details><summary>Session options</summary><a href="#workspace/new/mock">Start a scored mock interview</a>{" · "}<button className="text-button" disabled={busy} onClick={() => {
          if (confirm(session.kind === "import" ? "Forget this chat and any pending attachment or match questions? Filed document evidence stays in Job experience. Follow-up facts sourced only from this chat are removed." :
            "Forget this conversation, its notes, and statements supported only by this conversation? Project labels, plans and saved job searches stay in your workspace."))
            void act(async () => { await api(`chats/${id}`, "DELETE"); location.hash = "workspace/history"; });
        }}>Delete this conversation</button></details></div></>}
    </div></div>
    <div className="compose-dock"><div className="dock-column">
      {session?.state === "closed" || pendingImport ? <div className="closed-actions">
        <a className="button quiet" href="#workspace"><Icon name="newChat"/>Start a new chat</a>{attachment}</div> : composer}
      <small className="composer-note">{session?.kind === "mock" ? "Only this interview is scored. Work examples also update your history and memory. " : ""}Attachments start a separate document chat.</small>
    </div></div>
  </div>;
}

type Hit = { id: string; kind: string; label: string; text: string; sessionId: string | null };
export function ChatHistory({ data, busy, act, rows, listError }: Props & {rows: ChatSession[] | null; listError: string}) {
  const [old,setOld] = useState<{id:string;goal:string}[]>([]);
  const [query,setQuery] = useState(""), [hits,setHits] = useState<Hit[] | null>(null), [error,setError] = useState("");
  useEffect(() => { let live = true;
    api<typeof old>("chats/archive").then(o => { if (live) setOld(o); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [data]);
  const earlier = rows ? data.mocks.filter(m => !rows.some(s => s.id === m.id)) : [];
  return <><p className="eyebrow">Conversations &amp; memory</p><h1>Chat history</h1>
    <p className="intro">Pick up a conversation, or search for something in your experience library.</p>
    {(error || listError) && <p role="alert">{error || listError}</p>}
    <form className="search-field" onSubmit={e => { e.preventDefault(); void act(async () => setHits(await api<Hit[]>("chats/search","POST",{query}))); }}>
      <label className="sr-only" htmlFor="recall">Search conversations and experience</label><input id="recall" type="search" placeholder="Search conversations and experience" maxLength={500} required value={query} onChange={e => {setQuery(e.target.value); setHits(null);}}/>
      <button disabled={busy}><Icon name="search"/>Search</button></form>
    {hits !== null && <section aria-label="Search results"><h2>Search results</h2>{hits.length ? hits.map(h => <article className="item" key={h.kind+h.id}><small>{h.kind}</small>
      <h3><a href={h.kind === "agent memory" ? "#workspace/memory" : h.kind === "interview target" ? `#workspace/prep/${h.id}` : !h.sessionId ? "#workspace/library" : h.kind === "earlier builder" ? `#workspace/archive/${h.sessionId}` : h.kind === "earlier mock" ?
        `#workspace/${h.sessionId}` : chatUrl(h.sessionId)}>{h.label}</a></h3><p>{h.text}</p></article>) : <p>No matching evidence or conversation found.</p>}</section>}
    <section className="recents" aria-label="Sessions"><h2>Sessions</h2>{rows?.map(s => <a key={s.id} href={chatUrl(s.id)}>
      <span className={`intent-icon ${modeIcon(s.kind)}`}><Icon name={modeIcon(s.kind)}/></span>
      <span><strong>{s.title}</strong><small>{modeName(s.kind)} · {s.state}</small></span><small>{date(s.updatedAt)}</small></a>)}
      {old.map(b => <a key={b.id} href={`#workspace/archive/${b.id}`}>{b.goal}<small>Earlier builder</small></a>)}
      {earlier.map(m => <a key={m.id} href={`#workspace/${m.id}`}>{m.target}<small>Earlier mock</small></a>)}
      {!listError && (rows === null ? <p role="status">Loading conversations...</p> : !rows.length && !old.length && !earlier.length && <p>No saved sessions yet. <a href="#workspace">Start a chat</a></p>)}</section>
    <a href="#workspace/memory">Manage agent memory</a>{" · "}<a href="#workspace/jobs">Saved job searches</a></>;
}
