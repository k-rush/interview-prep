import { useCallback, useEffect, useRef, useState } from "react";
import { api, values, type Act, type Workspace } from "./client";

type Settings = { role: string; zone: string; localTime: string; enabled: boolean; autoDraft: boolean;
  remoteOnly: boolean; requireLocation: boolean; requirePay: boolean; nextDueUtc: string | null };
type Listing = { id: string; title: string; employer: string; mode: string; location: string; pay: string;
  excerpt: string; must: string; preferred: string; checkedUtc: string };
type Board = { key: string; permitted: boolean; coverage: string; rightsBasis: string; reuse: string; checkedUtc: string | null;
  refreshAfterUtc: string | null };
type Match = { id: string; rank: number; status: string; canDraft: boolean;
  listing: (Pick<Listing, "title" | "employer" | "location" | "mode" | "pay" | "checkedUtc"> &
    { fresh: boolean; source: string; url: string | null }) | null;
  fit: { earned: number; possible: number; reason: string; gaps: string[];
    lines: { term: string; priority: string; support: string; points: number; weight: number }[] } | null;
  packets: { id: string; current: boolean; approved: boolean; createdUtc: string }[] };
type Digest = { id: string; localDate: string; zone: string; targetRole: string; trigger: string; status: string;
  nextStep: string; draftNote: string; coverage: string[]; matches: Match[] };
type Scout = { scoutAllowed: boolean; settings: Settings; roster: string[]; replay: boolean; follows: Board[]; listings: Listing[]; digests: Digest[] };
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

function Schedule({ s, allowed, save, busy }: { s: Settings; allowed: boolean; busy: boolean; save: Save }) {
  const [daily, setDaily] = useState(s.enabled);
  return <section><h3>Target and schedule</h3><p>Save a role before running. The scout looks for shared words in job titles. It does not infer your location, salary or eligibility.</p>
    <form onSubmit={e => {
      e.preventDefault(); const v = values(e.currentTarget);
      save("settings", "PUT", { role: v.role, zone: v.zone, localTime: v.localTime, enabled: daily && allowed,
        autoDraft: daily && allowed && v.autoDraft === "on", remoteOnly: v.remoteOnly === "on",
        requireLocation: v.requireLocation === "on", requirePay: v.requirePay === "on" });
    }}>
      <label>Target role<input name="role" defaultValue={s.role} required maxLength={120} placeholder="e.g. Data analyst" /></label>
      <label><input type="checkbox" name="remoteOnly" defaultChecked={s.remoteOnly}/> Exclude explicitly on-site and hybrid jobs</label>
      <label><input type="checkbox" name="requireLocation" defaultChecked={s.requireLocation}/> Exclude listings with no stated location</label>
      <label><input type="checkbox" name="requirePay" defaultChecked={s.requirePay}/> Exclude listings with no stated pay</label>
      <label>Time zone (IANA)<input name="zone" defaultValue={s.role ? s.zone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"}
        required maxLength={80} placeholder="America/Los_Angeles" /></label>
      <label>Local digest time<input name="localTime" type="time" required defaultValue={s.localTime}/></label>
      <label><input type="checkbox" checked={daily && allowed} disabled={!allowed} onChange={e => setDaily(e.target.checked)} /> Enable daily scout</label>
      <label><input type="checkbox" name="autoDraft" disabled={!daily || !allowed} defaultChecked={s.autoDraft}/>
        Also prepare at most one eligible resume/letter pair per local day, using my draft allowance if metered</label>
      <button disabled={busy}>Save scout settings</button>
    </form>
    <p className="muted">{s.enabled ? `Next scheduled check: ${time(s.nextDueUtc)} (shown in your browser's zone).` : "Daily schedule paused. A manual run is still available if your plan permits."}
      {" "}If today’s time has passed, enabling the schedule catches up today. The local service must be running to deliver a digest.</p>
    <div className="actions"><button disabled={busy || !allowed || !s.role} onClick={() => save("run", "POST")}>Run scout now</button>
      {s.enabled && <button className="quiet" disabled={busy} onClick={() => save("pause", "POST")}>Pause daily scout</button>}</div>
    <p className="muted">Manual and scheduled runs share one digest per workspace and local date. Rerunning opens the same result, not another charge.</p>
  </section>;
}

function ListingForm({ listing, busy, save }: { listing?: Listing; busy: boolean; save: Save }) {
  return <form onSubmit={e => {
    e.preventDefault(); const v = values(e.currentTarget);
    save(listing ? `listings/${listing.id}` : "listings", listing ? "PUT" : "POST", { ...v, permitPrivateUse: v.permitPrivateUse === "on" });
  }}>
    <label>Job title<input name="title" required maxLength={180} defaultValue={listing?.title}/></label>
    <label>Employer<input name="employer" required maxLength={120} defaultValue={listing?.employer}/></label>
    <label>Location as posted<input name="location" maxLength={150} defaultValue={listing?.location}/></label>
    <label>Work arrangement<select name="mode" defaultValue={listing?.mode ?? "unknown"}>
      <option value="unknown">Not stated</option><option value="remote">Remote</option><option value="hybrid">Hybrid</option><option value="onsite">On-site</option>
    </select></label>
    <label>Pay as posted (optional)<input name="pay" maxLength={120} defaultValue={listing?.pay}/></label>
    <label>Required skills, comma-separated<input name="must" maxLength={650} defaultValue={listing?.must} placeholder="SQL, Data analysis"/></label>
    <label>Preferred skills, comma-separated<input name="preferred" maxLength={650} defaultValue={listing?.preferred}/></label>
    <label>Permitted excerpt (optional)<textarea name="excerpt" maxLength={4000} defaultValue={listing?.excerpt}/></label>
    <label><input type="checkbox" name="permitPrivateUse" required/> I have permission to use this excerpt privately and have checked this listing.</label>
    <button disabled={busy}>{listing ? "Save and reconfirm listing" : "Save private listing"}</button>
  </form>;
}

function Sources({ scout, busy, save }: { scout: Scout; busy: boolean; save: Save }) {
  const available = scout.roster.filter(k => !scout.follows.some(f => f.key === k && f.permitted));
  return <section><h3>Listings and source permissions</h3>
    <p>Paste a listing to work entirely offline. Private pastes and experience never enter the shared public catalog.</p>
    <details><summary>Add a private listing</summary><ListingForm save={save} busy={busy}/></details>
    {scout.listings.map(j => <details className="item" key={`${j.id}-${j.checkedUtc}`}><summary>{j.title} · {j.employer}</summary>
      <p>Private paste · last confirmed {time(j.checkedUtc)}. Remove a closed listing to invalidate its pairs.</p>
      <ListingForm listing={j} save={save} busy={busy}/>
      <button className="quiet" disabled={busy} onClick={() => save(`listings/${j.id}`, "DELETE")}>Remove private listing</button></details>)}
    <h4>Permitted employer boards</h4>
    <p>{scout.replay ? "Recorded fixture mode: no network calls or live vacancies." :
      "No public lookup until you follow a board. Only its public token goes to the fixed Greenhouse or Lever jobs API; no search terms, cookies or candidate facts."}</p>
    <p className="muted">Only operator-cleared boards are offered. A refresh checks at most 60 entries per board, normally once per 24 hours.
      Shared metadata is kept for up to three days. A failed or empty feed is not evidence a job closed.</p>
    {scout.follows.map(b => <div className="item" key={b.key}><strong>{b.key}</strong>
      <p>{b.permitted ? b.coverage : "Permission withdrawn; excluded"} · Last nonempty check: {time(b.checkedUtc)}</p>
      <p className="muted">{b.rightsBasis} {b.reuse} {b.refreshAfterUtc && `Next permitted refresh: ${time(b.refreshAfterUtc)}.`}</p>
      <button className="quiet" disabled={busy} onClick={() => save(`boards/${b.key.split(":").map(encodeURIComponent).join("/")}`, "DELETE")}>
        Stop using this board</button></div>)}
    {available.length > 0 ? <form onSubmit={e => { e.preventDefault(); const v = values(e.currentTarget);
      const [provider, slug] = String(v.board).split(":");
      save("boards", "POST", { provider, slug, permitPublicLookup: v.allow === "on" });
    }}><label>Employer board<select name="board">{available.map(k => <option key={k}>{k}</option>)}</select></label>
      <label><input type="checkbox" required name="allow"/> Allow lookups and local reuse of this board’s permitted public listing metadata.</label>
      <button disabled={busy || scout.follows.length >= 4}>Follow board</button></form>
      : scout.roster.length === 0 && <p>No rights-cleared boards are configured here. Private listings still work.</p>}
  </section>;
}

function MatchCard({ m, save, busy, allowed, review, prepare }: { m: Match; save: Save; busy: boolean; allowed: boolean;
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
      {m.canDraft && allowed && !m.packets.some(p => p.current) && <button disabled={busy} onClick={() => save(`matches/${m.id}/draft`, "POST")}>Prepare a resume and letter</button>}
      <button className="quiet" disabled={busy} onClick={() => save(`matches/${m.id}/dismiss`, "POST", { reason: "not relevant" })}>Dismiss: not relevant</button>
      <button className="quiet" disabled={busy} onClick={() => save(`matches/${m.id}/dismiss`, "POST", { reason: "stale listing" })}>Dismiss: stale listing</button>
    </div>
    {!m.canDraft && <p className="muted">A pair needs a fresh listing and directly matching wording in a confirmed, draft-permitted fact. Add or correct a fact in your library; don’t invent a missing skill.</p>}
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
  return <>{!digestId && <><a href="#workspace">Back to Chat</a><p className="eyebrow">Scout settings</p><h1>Job scout</h1>
    <p className="intro">Choose sources and set up daily reports. Nothing is sent to employers.</p></>}
    {error && <p role="alert">{error} <button className="quiet" onClick={() => setRefresh(n => n + 1)}>Retry</button></p>}
    {!scout ? !error && <p role="status">Loading your scout…</p> : <div inert={busy} aria-busy={busy}>
      {!scout.scoutAllowed && <p className="callout">Your plan does not currently permit new scouting. You can still review existing digests and approved exports.</p>}
      {!digestId && <><Schedule key={JSON.stringify(scout.settings)} s={scout.settings} allowed={scout.scoutAllowed} save={save} busy={busy}/>
      <Sources scout={scout} busy={busy} save={save}/></>}
      <section><h3>{digestId ? "Listings and application materials" : "Daily digests"}</h3><p>Up to three new matches per day. Reasons use your current permitted evidence, not hidden profile data.</p>
        {!scout.digests.length && <p>No digest yet. Save a target role, add a private listing or permitted board, then run the scout.</p>}
        {scout.digests.map((d, i) => <details className="item" key={d.id} open={i === 0}><summary>{d.localDate} · {d.matches.length} match(es) · {d.status}</summary>
          <p>{d.targetRole} · {d.zone} · {d.trigger} run</p>
          <h4>Source coverage</h4><ul>{d.coverage.map((s, n) => <li key={n}>{s}</li>)}</ul>
          <p>{d.draftNote}</p><p>{d.nextStep}</p>
          {d.matches.map(m => <MatchCard key={m.id} m={m} allowed={scout.scoutAllowed} busy={busy} save={save} review={review} prepare={prepare}/>)}
        </details>)}
      </section>
    </div>}
    <div ref={reviewRef}>{opened && <PairReview key={opened} id={opened} data={data} act={act} busy={busy} close={() => setOpened(null)}/>}</div>
  </>;
}
