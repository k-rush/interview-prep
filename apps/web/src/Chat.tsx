import { useEffect, useRef, useState } from "react";
import { api, RequestError, type Act, type Workspace } from "./client";
import { Discovery } from "./Discovery";
import { VoiceInput } from "./Voice";

type Kind = "builder" | "mock" | "scout" | "plan";
type Session = { id: string; kind: Kind; title: string; state: string; revision: number; stage: string; updatedAt: string; targetId: string | null; digestId: string | null };
type Message = { id: string; speaker: string; text: string; mode: string; vote: string | null; nextChatId: string | null };
type Detail = { session: Session; messages: Message[]; pendingSearch: string | null };
type Props = { data: Workspace; act: Act; busy: boolean };
const modes: Record<Kind, [string, string]> = {
  builder: ["Build experience", "Turn a story into evidence"], mock: ["Mock interview", "Practice a hiring-manager round"],
  scout: ["Find jobs", "Match roles to your experience"], plan: ["Plan an interview", "Make time for the right practice"]
};
const date = (s: string) => new Date(s).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const chatUrl = (id: string) => `#workspace/chat/${id}`;

function Starters({ small = false }: { small?: boolean }) {
  return <div className={small ? "utility-links" : "starters"}>{(Object.entries(modes) as [Kind, [string, string]][]).map(([kind, [title, subtitle]]) =>
    <a href={`#workspace/new/${kind}`} key={kind}>{!small && <span className={`mode-dot ${kind}`} aria-hidden="true"/>}
      <strong>{title}</strong>{!small && <small>{subtitle}</small>}</a>)}</div>;
}

export function Chat({ data, act, busy, id, newKind }: Props & { id?: string; newKind?: string }) {
  const [detail, setDetail] = useState<Detail | null>(null), [text, setText] = useState(""), [error, setError] = useState("");
  const [sending, setSending] = useState(false), [recent, setRecent] = useState<Session[]>([]);
  const startKey = useRef(crypto.randomUUID()), turnKey = useRef(crypto.randomUUID());
  const last = useRef<HTMLLIElement>(null), scrollNext = useRef(false);
  const kind: Kind = newKind && Object.hasOwn(modes, newKind) ? newKind as Kind : "builder";
  useEffect(() => {
    let live = true;
    if (id) api<Detail>(`chats/${id}`).then(x => { if (live) { scrollNext.current = x.messages.length > 1; setDetail(x); if (x.pendingSearch) setText(x.pendingSearch); } }).catch(e => { if (live) setError(e.message); });
    else if (newKind) api<{id: string}>("chats", "POST", {kind, requestId: startKey.current}).then(x => {
      if (live) location.replace(chatUrl(x.id));
    }).catch(e => { if (live) setError(e.message); });
    else api<Session[]>("chats").then(x => { if (live) setRecent(x.slice(0, 3)); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [id, newKind, kind]);
  useEffect(() => {
    if (scrollNext.current && detail) { scrollNext.current = false; last.current?.scrollIntoView({block: "nearest"}); }
  }, [detail]);
  const session = detail?.session;
  const send = (action: "say" | "finish") => {
    if (sending || busy || action === "say" && !text.trim()) return;
    void act(async () => {
      setError(""); setSending(true);
      let active = id;
      try {
        if (!active) active = (await api<{id:string}>("chats", "POST", { kind, requestId: startKey.current })).id;
        const answer = await api<{id:string}>(`chats/${active}/turns`, "POST", { text, action, requestId: turnKey.current,
          revision: session?.revision ?? 0, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" });
        turnKey.current = crypto.randomUUID(); setText("");
        if (id !== answer.id) location.hash = chatUrl(answer.id);
        else { scrollNext.current = true; setDetail(await api<Detail>(`chats/${id}`)); }
      } catch (e) {
        if (active && id && e instanceof RequestError && e.status === 409) {
          setDetail(await api<Detail>(`chats/${active}`)); turnKey.current = crypto.randomUUID();
        }
        throw e;
      } finally { setSending(false); }
    });
  };
  const lastMsg = detail?.messages.at(-1);
  const rating = (m: Message, vote: string) => void act(async () => {
    await api(`chats/${id}/feedback/${m.id}`, "PUT", { vote: m.vote === vote ? null : vote });
    setDetail(await api<Detail>(`chats/${id}`));
  });
  const composer = <form className={session ? "composer in-session" : "composer"} onSubmit={e => { e.preventDefault(); send("say"); }}>
    <fieldset disabled={busy}>{sending ? <p role="status" className="muted">Working on your reply…</p> : <VoiceInput compact key={session?.revision ?? 0} label="Message your coach" maxLength={session?.kind === "mock" ? 3000 : 8000}
      required value={text} onChange={setText} prompt={lastMsg?.text} />}
      <button className="send" disabled={!text.trim() || busy}>{sending ? "Sending…" : "Send"}</button></fieldset>
  </form>;
  return <div className="chat-page"><div className="section-line"><p className="eyebrow">Coach studio</p>
    <div className="utility-links"><a href="#workspace/history">History</a>{id && <a href="#workspace">New chat</a>}</div></div>
    {error && <p role="alert" className="error">{error}</p>}
    {!id && !newKind ? <>
      <div className="chat-hero"><span className="coach-mark" aria-hidden="true">✳</span><h1>What are you preparing for?</h1>
        <p className="intro">Tell me about your work, or pick a place to start.</p></div>
      {composer}<Starters/><p className="privacy-line">{data.localCoachEnabled ? "Local AI" : "Offline guide"} · Chat can recall your saved conversations and evidence. Only reviewed facts can go into applications.</p>
      {recent.length > 0 && <div className="recents"><h2>Pick up where you left off</h2>{recent.map(s => <a key={s.id} href={chatUrl(s.id)}>
        <span>{s.title}</span><small>{date(s.updatedAt)}</small></a>)}</div>}
    </> : !detail ? !error && <p role="status">Opening your conversation…</p> : session && <>
      <h1 className="session-title">{session.title}</h1>
      <div className="session-info"><span className="badge">{modes[session.kind][0]}</span>
        <span>{session.state === "closed" ? "Finished" : data.localCoachEnabled ? "Local AI · private session" : "Offline guide"}</span></div>
      {session.kind === "scout" && <a className="minor-link" href="#workspace/jobs">Sources &amp; daily search settings</a>}
      <ol className="transcript" aria-label="Chat transcript">{detail.messages.map((m,i) =>
        <li key={m.id} ref={i === detail.messages.length - 1 ? last : null} className={`${m.speaker} ${m.mode === "scorecard" || m.mode === "report" ? "artifact" : ""}`}>
          <small>{m.speaker === "user" ? "You" : `Coach · ${m.mode}`}</small><p>{m.text}</p>
          {m.nextChatId && <a href={chatUrl(m.nextChatId)}>Open that session</a>}</li>)}</ol>
      {session.digestId && <Discovery data={data} act={act} busy={busy} digestId={session.digestId}/>}
      {session.targetId && <a className="minor-link" href={`#workspace/prep/${session.targetId}`}>View interview packet &amp; schedule</a>}
      {session.state === "closed" && session.kind === "mock" && data.mocks.find(m => m.id === id)?.report &&
        <a className="button quiet" href={`#workspace/debrief/${id}`}>Review scorecard, examples &amp; next drill</a>}
      {session.state !== "closed" && composer}
      <div className="session-tools">{session.state !== "closed" && <button className="text-button" disabled={busy} onClick={() => send("finish")}>Finish session</button>}
        {lastMsg?.speaker === "assistant" && <details><summary>Rate reply</summary><div className="actions">{["up","down"].map(v =>
          <button key={v} className="quiet" disabled={busy} aria-pressed={lastMsg.vote === v} onClick={() => rating(lastMsg,v)}>{v === "up" ? "Helpful" : "Unhelpful"}</button>)}</div></details>}
        <details><summary>Session options</summary><Starters small/><button className="text-button" disabled={busy} onClick={() => {
          if (confirm("Forget this conversation, its private notes, and facts sourced from it? Job and project labels, interview plans and scout reports are managed separately."))
            void act(async () => { await api(`chats/${id}`, "DELETE"); location.hash = "workspace/history"; });
        }}>Delete this conversation</button></details></div>
    </>}
  </div>;
}

type Hit = { id: string; kind: string; label: string; text: string; sessionId: string | null };
type Note = { id: string; text: string };
export function ChatHistory({ data, busy, act }: Props) {
  const [rows,setRows] = useState<Session[]>([]), [notes,setNotes] = useState<Note[]>([]), [old,setOld] = useState<{id:string;goal:string}[]>([]);
  const [query,setQuery] = useState(""), [hits,setHits] = useState<Hit[] | null>(null), [error,setError] = useState("");
  useEffect(() => { let live = true;
    Promise.all([api<Session[]>("chats"),api<Note[]>("chats/memory"),api<typeof old>("chats/archive")]).then(([s,n,o]) => {
      if (live) { setRows(s); setNotes(n); setOld(o); }
    }).catch(e => { if (live) setError(e.message); }); return () => { live = false; };
  }, [data]);
  const earlier = data.mocks.filter(m => !rows.some(s => s.id === m.id));
  return <><a href="#workspace">Back to Chat</a><p className="eyebrow">Your workspace</p><h1>Chat history</h1>{error && <p role="alert">{error}</p>}
    <form className="search-field" onSubmit={e => { e.preventDefault(); void act(async () => setHits(await api<Hit[]>("chats/search","POST",{query}))); }}>
      <label className="sr-only" htmlFor="recall">Search conversations and experience</label><input id="recall" type="search" placeholder="Search conversations and experience" maxLength={500} required value={query} onChange={e => {setQuery(e.target.value); setHits(null);}}/>
      <button disabled={busy}>Search</button></form>
    {hits !== null && <section aria-label="Search results"><h2>Search results</h2>{hits.length ? hits.map(h => <article className="item" key={h.kind+h.id}><small>{h.kind}</small>
      <h3><a href={h.kind === "interview target" ? `#workspace/prep/${h.id}` : !h.sessionId ? "#workspace/library" : h.kind === "earlier builder" ? `#workspace/archive/${h.sessionId}` : h.kind === "earlier mock" ?
        `#workspace/${h.sessionId}` : chatUrl(h.sessionId)}>{h.label}</a></h3><p>{h.text}</p></article>) : <p>No matching evidence or conversation found.</p>}</section>}
    <section className="recents"><h2>Sessions</h2>{rows.map(s => <a key={s.id} href={chatUrl(s.id)}><span><strong>{s.title}</strong><small>{modes[s.kind][0]} · {s.state}</small></span><small>{date(s.updatedAt)}</small></a>)}
      {old.map(b => <a key={b.id} href={`#workspace/archive/${b.id}`}>{b.goal}<small>Earlier builder</small></a>)}
      {earlier.map(m => <a key={m.id} href={`#workspace/${m.id}`}>{m.target}<small>Earlier mock</small></a>)}
      {!rows.length && !old.length && !earlier.length && <p>No saved sessions yet.</p>}</section>
    <details><summary>Chat memory</summary><p>Say <strong>Remember: …</strong> in an experience conversation to save a short preference. Notes are for coaching, never resume claims. Deleting a note stops its use as a preference; the conversation itself has a separate delete control.</p>
      {notes.map(n => <div className="item" key={n.id}><p>{n.text}</p><button disabled={busy} className="quiet" onClick={() => void act(async () => {await api(`chats/memory/${n.id}`,"DELETE");setHits(null);})}>Forget note</button></div>)}
      {!notes.length && <small>No private notes saved.</small>}</details></>;
}
