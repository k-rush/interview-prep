import { useEffect, useState } from "react";
import { api, type Act, type Workspace } from "./client";

type Props = { data: Workspace; busy: boolean; act: Act };
type Memory = { id: string; chatId: string | null; factId: string | null; text: string };
type Daily = { enabled: boolean; role: string };

export function AgentMemory({ data, busy, act }: Props) {
  const [rows, setRows] = useState<Memory[] | null>(null), [error, setError] = useState("");
  const [edit, setEdit] = useState(""), [text, setText] = useState("");
  useEffect(() => {
    let live = true;
    api<Memory[]>("chats/memory").then(result => { if (live) { setRows(result); setError(""); } }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [data]);
  return <><p className="eyebrow">Your private workspace</p><h1>Agent memory</h1>
    <p className="intro">See what the coach can use for future conversations and job matches. Edit or delete a memory without changing your transcript, job history, or interview score.</p>
    {error && <p role="alert">{error}</p>}
    {rows === null ? !error && <p role="status">Loading memory…</p> : <section><h2>Saved memories</h2>
      {!rows.length && <p>No memories yet. Share a work example or say <strong>Remember: keep questions short.</strong></p>}
      {rows.map(n => <article key={n.id} className="item"><small>{n.factId ? "From your job history" : "Coaching note"}</small>
        {edit === n.id ? <form onSubmit={e => { e.preventDefault(); void act(async () => {
          const next = text.trim(); await api(`chats/memory/${n.id}`, "PUT", { text: next });
          setRows(rs => rs?.map(r => r.id === n.id ? { ...r, text: next } : r) ?? null); setEdit("");
        }); }}><label>Memory text<textarea value={text} onChange={e => setText(e.target.value)} required maxLength={2000} rows={3}/></label>
          <div className="actions"><button disabled={busy || !text.trim()}>Save memory</button>
            <button className="quiet" type="button" onClick={() => setEdit("")}>Cancel</button></div></form> :
          <><p>{n.text}</p><div className="actions"><button className="quiet" disabled={busy} onClick={() => { setText(n.text); setEdit(n.id); }}>Edit memory</button>
            <button className="text-button" disabled={busy} onClick={() => void act(async () => {
              await api(`chats/memory/${n.id}`, "DELETE"); setRows(rs => rs?.filter(r => r.id !== n.id) ?? null);
            })}>Delete memory</button></div></>}
      </article>)}</section>}</>;
}

export function DailySearchSetting({ data, busy, act }: Props) {
  const [daily, setDaily] = useState<Daily | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    api<Daily>("account/daily-search").then(s => { if (live) { setDaily(s); setError(""); } }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, [data]);
  return <section><h2>Daily job search</h2>
    <p>Repeat the public search from chat once a day while the app is running. Only the public role title is sent to the search provider; matching against your workspace happens here.</p>
    {error && <p role="alert">{error}</p>}
    {daily ? <><label><input type="checkbox" checked={daily.enabled} disabled={busy || !daily.role && !daily.enabled}
      onChange={e => { const enabled = e.currentTarget.checked; void act(async () => {
        setDaily({ ...daily, enabled });
        try { setDaily(await api<Daily>("account/daily-search","PUT",{ enabled, zone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC" })); }
        catch (failure) { setDaily(daily); throw failure; }
      }); }}/> Run my job search daily</label>
      {daily.role ? <small>Public title: {daily.role}</small> : <p><a href="#workspace/new/scout">Find matches in chat</a> to choose the public title for your search.</p>}</> :
      !error && <p role="status">Loading your setting…</p>}</section>;
}
