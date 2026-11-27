import { useCallback, useEffect, useRef, useState } from "react";
import { api, type Act, type Workspace } from "./client";

type Match = { id: string; rank: number; status: string;
  listing: { title: string; employer: string; location: string; mode: string; pay: string; checkedUtc: string;
    fresh: boolean; source: string; url: string | null } | null;
  fit: { earned: number; possible: number; reason: string; gaps: string[];
    lines: { term: string; priority: string; support: string; points: number; weight: number }[] } | null;
  packets: { id: string; current: boolean; approved: boolean; createdUtc: string }[] };
type Digest = { id: string; localDate: string; zone: string; targetRole: string; trigger: string; status: string;
  nextStep: string; coverage: string[]; matches: Match[];
  webSearch: { links: { title: string; url: string; reason: string }[]; status: string; incomplete: boolean } };
type Scout = { scoutAllowed: boolean; digests: Digest[] };
type Pair = { id: string; version: string; approved: boolean; resume: string; letter: string;
  evidence: { id: string; project: string; claim: string; resumeClaim: number; letterClaim: number }[] };
type PrepPosting = { role: string; company: string; level: string; round: string; description: string; jobUrl: string | null };
type Save = (path: string, method: string, body?: unknown) => void;
const time = (value: string | null) => value ? new Date(value).toLocaleString() : "not yet checked";
function notifyDiscovery() {
  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel("practice-discovery"); channel.postMessage("changed"); channel.close();
}
function listenChanges(onChange: () => void) {
  const channels = typeof BroadcastChannel === "undefined" ? [] :
    ["practice-library", "practice-discovery"].map(name => new BroadcastChannel(name));
  channels.forEach(c => { c.onmessage = onChange; });
  return () => channels.forEach(c => c.close());
}

function MatchCard({ m, save, busy, review, prepare }: { m: Match; save: Save; busy: boolean;
  review: (id: string) => void; prepare: (id: string) => void }) {
  const j = m.listing, fit = m.fit;
  if (!j || !fit) return <article className="item"><strong>Match {m.rank}</strong><p>{m.status}. This version cannot be drafted or exported.</p></article>;
  return <article className="item"><p className="eyebrow">Match {m.rank} / {m.status}</p><h4>{j.title} · {j.employer}</h4>
    <p>{j.location || "Location not stated"} · {j.mode} · {j.pay || "Pay not stated"}</p>
    <p className="muted">{j.source}. Last checked {time(j.checkedUtc)}.</p>
    {j.url && <a href={j.url} target="_blank" rel="noopener noreferrer">Open employer posting yourself</a>}
    <p><strong>Documented term coverage: {fit.possible ? `${fit.earned} / ${fit.possible}` : "unknown"}</strong></p>
    <details><summary>Why this job? Evidence and gaps</summary><p>{fit.reason}</p>
      <ul>{fit.lines.map(l => <li key={l.term}>{l.term} ({l.priority}): {l.support}, {l.points}/{l.weight}</li>)}</ul>
      {fit.gaps.length > 0 && <><h4>Check before applying</h4><ul>{fit.gaps.map(g => <li key={g}>{g}</li>)}</ul></>}
    </details>
    <div className="actions">
      {j.fresh && <button className="quiet" disabled={busy} onClick={() => prepare(m.id)}>Prepare for this job</button>}
      <button className="quiet" disabled={busy} onClick={() => save(`matches/${m.id}/dismiss`, "POST", { reason: "not relevant" })}>Dismiss: not relevant</button>
      <button className="quiet" disabled={busy} onClick={() => save(`matches/${m.id}/dismiss`, "POST", { reason: "stale listing" })}>Dismiss: stale listing</button>
    </div>
    {m.packets.map(p => <div key={p.id}>{p.current ? <button className="quiet" disabled={busy}
      onClick={() => review(p.id)}>{p.approved ? "Open approved pair" : "Review resume and letter"}</button> :
      <p className="muted">Previous pair invalidated. Changed or forgotten claims are not displayed.</p>}</div>)}
  </article>;
}

function PairReview({ id, data, act, busy, close }: { id: string; data: Workspace; act: Act; busy: boolean; close: () => void }) {
  const [view, setView] = useState<{ data: Workspace; id: string; pair: Pair } | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let active = true, foreground = !document.hidden, seq = 0;
    const load = () => {
      const request = ++seq;
      if (document.hidden || !foreground) { setView(null); return; }
      api<Pair>(`discovery/drafts/${id}`).then(pair => {
        if (active && request === seq) { setView({ data, id, pair }); setError(""); }
      }).catch(e => { if (active && request === seq) { setView(null); setError(e.message); } });
    };
    const hide = () => { foreground = false; seq++; setView(null); };
    const focus = () => { foreground = true; load(); };
    const visible = () => { if (document.hidden) hide(); else focus(); };
    const unlisten = listenChanges(() => { setView(null); load(); });
    load(); const interval = window.setInterval(load, 15000);
    window.addEventListener("focus", focus); window.addEventListener("blur", hide); document.addEventListener("visibilitychange", visible);
    return () => { active = false; unlisten(); window.clearInterval(interval); window.removeEventListener("focus", focus);
      window.removeEventListener("blur", hide); document.removeEventListener("visibilitychange", visible); };
  }, [id, data]);
  const pair = view?.data === data && view.id === id && !busy ? view.pair : null;
  const download = (format: "txt" | "docx") => void act(async () => {
    const res = await fetch(`/api/discovery/drafts/${id}/export?format=${format}`, { cache: "no-store" });
    if (!res.ok) { setView(null); const reason = await res.json().catch(() => null);
      throw new Error(typeof reason === "string" ? reason : "Export unavailable. Reopen the current pair."); }
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement("a"); a.href = url; a.download = `reviewed-application-pair.${format}`;
    document.body.appendChild(a); a.click(); a.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 500);
  });
  return <section aria-label="Review application pair"><p className="eyebrow">Private review / no employer delivery</p><h3>Resume and cover letter</h3>
    {error && <p role="alert">{error}</p>}
    {!pair ? <p>No document is displayed until its evidence and listing can be revalidated.</p> : <>
      <h4>Tailored resume</h4><blockquote>{pair.resume}</blockquote>
      <h4>Cover letter</h4><blockquote>{pair.letter}</blockquote>
      <h4>Claim-by-claim evidence (not exported)</h4>
      <ol>{pair.evidence.map(e => <li key={e.id}><strong>{e.project}</strong> · resume statement {e.resumeClaim}, letter example {e.letterClaim}
        <p>{e.claim}</p></li>)}</ol>
      <p>These examples are quoted from your permitted facts. Correct the fact in your library if needed; a changed fact invalidates this version.</p>
      {pair.approved ? <div className="actions"><button disabled={busy} onClick={() => download("txt")}>Download text pair</button>
        <button className="quiet" disabled={busy} onClick={() => download("docx")}>Download Word pair</button>
        <a href={`/api/discovery/drafts/${id}/export?format=print`} target="_blank" rel="noopener noreferrer">Print / save as PDF</a></div> :
        <button disabled={busy} onClick={() => void act(async () => { await api(`discovery/drafts/${id}/approve`, "POST", { version: pair.version }); notifyDiscovery(); })}>
          I reviewed both documents · approve for export</button>}
    </>}
    <p><button className="quiet" onClick={close}>Close private review</button></p>
  </section>;
}

export function Discovery({ data, act, busy, digestId }: { data: Workspace; act: Act; busy: boolean; digestId?: string }) {
  const [state, setState] = useState<{ data: Workspace; scout: Scout } | null>(null);
  const [error, setError] = useState(""), [opened, setOpened] = useState<string | null>(null), [refresh, setRefresh] = useState(0);
  const reviewRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let active = true, seq = 0;
    const load = () => { const n = ++seq; api<Scout>(digestId ? `discovery?digestId=${encodeURIComponent(digestId)}` : "discovery").then(scout => {
      if (active && seq === n) { setState({ data, scout }); setError(""); }
    }).catch(e => { if (active && seq === n) { setState(null); setError(e.message); } }); };
    const visible = () => { if (!document.hidden) load(); };
    const unlisten = listenChanges(load);
    load(); window.addEventListener("focus", load); const timer = window.setInterval(visible, 60000);
    return () => { active = false; unlisten(); window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [data, refresh, digestId]);
  const save: Save = (path, method, body) => {
    setOpened(null); void act(async () => { await api(`discovery/${path}`, method, body); notifyDiscovery(); setRefresh(n => n + 1); });
  };
  const review = useCallback((id: string) => { setOpened(id); requestAnimationFrame(() => reviewRef.current?.scrollIntoView({ block: "start" })); }, []);
  const prepare = (id: string) => void act(async () => {
    const posting = await api<PrepPosting>(`discovery/matches/${id}/prep`);
    const target = await api<{ id: string }>("targets", "POST", posting);
    location.hash = `workspace/prep/${target.id}`;
  });
  const scout = state?.data === data ? state.scout : null;
  return <>{!digestId && <><p className="eyebrow">Job search history</p><h1>Saved job searches</h1>
    <p className="intro">Revisit public links and earlier reports. Start a new search in a conversation.</p>
    <a className="button" href="#workspace/new/scout">Find jobs in chat</a></>}
    {error && <p role="alert">{error} <button className="quiet" onClick={() => setRefresh(n => n + 1)}>Retry</button></p>}
    {!scout ? !error && <p role="status">Loading saved results…</p> : <div inert={busy} aria-busy={busy}>
      {!scout.scoutAllowed && <p className="callout">New searches are unavailable on your plan. Your existing results remain accessible.</p>}
      <section><h3>{digestId ? "Search results" : "Past searches"}</h3>
        {!scout.digests.length && <p>No saved results yet.</p>}
        {scout.digests.map((d, i) => <details className="item" key={d.id} open={i === 0}><summary>{d.localDate} · {d.targetRole} · {d.status}</summary>
          <p>{d.targetRole} · {d.zone} · {d.trigger} run</p>
          <h4>Source coverage</h4><ul>{d.coverage.map((s, n) => <li key={n}>{s}</li>)}</ul>
          <p>{d.nextStep}</p>
          {d.webSearch.links.length > 0 && <><h4>Public web results · verify with the employer</h4>
            <p className="muted">Ranked locally against your workspace. These links do not confirm a vacancy, pay or eligibility.</p>
            <ol>{d.webSearch.links.map(link => <li key={link.url}>
              <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a><p className="muted">{link.reason}</p>
            </li>)}</ol></>}
          {d.matches.map(m => <MatchCard key={m.id} m={m} busy={busy} save={save} review={review} prepare={prepare}/>)}
        </details>)}
      </section>
    </div>}
    <div ref={reviewRef}>{opened && <PairReview key={opened} id={opened} data={data} act={act} busy={busy} close={() => setOpened(null)}/>}</div>
  </>;
}
