import { useEffect, useRef, useState } from "react";
import { api, assessorName, values, type Act, type Workspace } from "./client";
import { DocumentPreview } from "./ExperienceDocuments";

export type Target = { id: string; role: string; company: string; level: string; round: string; description: string; jobUrl?: string; interviewAt: string | null; interviewZone: string | null;
  researchStatus: string; researchedAt: string | null; sources: { kind: string; title: string; url: string; theme: string }[] };
type Block = { id: string; label: string; kind: string; startsAt: string; minutes: number; state: string; attemptId: string | null };
type Progress = { readiness: string; comparable: number; assessor:string | null; delta: number | null; competencies: { name: string; points: number; delta: number | null }[] | null;
  attempts: { id: string; startedAt: string; completedAt: string | null; assessor: string | null; score: number | null }[];
  plan: { interviewAt: string; zone: string; blocks: Block[] } | null };

export function TargetPicker({ targets, id, select }: { targets: Target[]; id: string; select: (s: string) => void }) {
  return <label>Saved interview target<select value={id} onChange={e => select(e.target.value)}>
    <option value="">Choose a target</option>{targets.map(t => <option key={t.id} value={t.id}>{t.role} / {t.company || "Any company"} / {t.level} / {t.round}</option>)}
  </select></label>;
}
const local = (s: string) => new Date(s).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
function instant(s: string) {
  const d = new Date(s);
  const adjusted = new Date(+d - d.getTimezoneOffset() * 60000);
  if (!Number.isFinite(+d) || adjusted.toISOString().slice(0,16) !== s)
    throw Error("That time does not exist in this timezone. Choose another time.");
  return d.toISOString();
}
function calendar(blocks: Block[]) {
  const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const events = blocks.filter(b => b.state === "planned").map(b => ["BEGIN:VEVENT",`UID:${b.id}@interview-prep.local`,
    `DTSTAMP:${stamp(new Date())}`,`DTSTART:${stamp(new Date(b.startsAt))}`,`DTEND:${stamp(new Date(+new Date(b.startsAt) + b.minutes * 60000))}`,
    `SUMMARY:Interview practice - ${b.label}`, "BEGIN:VALARM", "TRIGGER:-PT10M", "ACTION:DISPLAY", "DESCRIPTION:Interview practice",
    "END:VALARM", "END:VEVENT"].join("\r\n"));
  const url = URL.createObjectURL(new Blob([["BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Interview Prep//Practice//EN",...events,"END:VCALENDAR",""].join("\r\n")], { type: "text/calendar" }));
  const a = document.createElement("a"); a.href = url; a.download = "practice-reminders.ics"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 3000);
}

export function PreparationView({ data, act, busy, initialTarget }: { data: Workspace; act: Act; busy: boolean; initialTarget?: string }) {
  const [targets, setTargets] = useState<Target[]>([]), [id, select] = useState(""), [err, setErr] = useState("");
  const [jd, setJd] = useState("");
  const load = async () => { const rows = await api<Target[]>("targets"); setTargets(rows); return rows; };
  useEffect(() => { let live = true; api<Target[]>("targets").then(rows => { if (live) {
    setTargets(rows); select(initialTarget && rows.some(t=>t.id===initialTarget) ? initialTarget : rows[0]?.id ?? "");
  } }).catch(e => setErr(e.message)); return () => { live = false; }; }, [initialTarget]);
  const target = targets.find(t => t.id === id);
  return <><p className="eyebrow">Interview preparation</p><h1>Schedule</h1>
    <p className="intro">Work back from interview day. Set aside practice time for a specific role and round.</p>
    <div className="actions"><a className="button" href="#workspace/new/plan">Plan it with your coach</a><a className="button quiet" href="#workspace/live">Live reminders</a></div>
    {err && <p role="alert">{err}</p>}
    <section><h2>Interview targets</h2><p className="muted">Keep the role, company research, and practice blocks for each interview together.</p>
    <details><summary>Add an interview target</summary><form onSubmit={e => {
      e.preventDefault(); const form = e.currentTarget, input = values(form);
      void act(async () => { const result = await api<{ id: string }>("targets", "POST", input); await load(); select(result.id); setJd(""); form.reset(); });
    }}>
      <label>Target role<input required name="role" maxLength={160} /></label>
      <label>Public company name (optional)<input name="company" maxLength={100} /></label>
      <div className="columns"><label>Level<input required name="level" defaultValue="Mid-career" maxLength={80} /></label>
        <label>Interview round<input required name="round" defaultValue="Hiring manager" maxLength={80} /></label></div>
      <label>Job description or goal<textarea name="description" value={jd} onChange={e => setJd(e.target.value)} maxLength={12000} /></label>
      <DocumentPreview label="Load a job description from a file" maxLength={12000} disabled={busy} onUse={text=>setJd(text)}/>
      <label>Original job URL (optional bookmark, never fetched automatically)<input type="url" name="jobUrl" maxLength={1500} /></label>
      <button disabled={busy}>Save target</button>
    </form></details>
    {!!targets.length && <TargetPicker targets={targets} id={id} select={select} />}</section>
    {target && <TargetPanel key={target.id} target={target} data={data} act={act} busy={busy} reload={load} />}
  </>;
}

function TargetPanel({ target: t, data, act, busy, reload }: { target: Target; data: Workspace; act: Act; busy: boolean; reload: () => Promise<Target[]> }) {
  const [progress, setProgress] = useState<Progress | null>(null), [err, setErr] = useState("");
  const [date, setDate] = useState(""), [windows, setWindows] = useState([{start:"",end:""}]);
  const [preview, setPreview] = useState<Block[] | null>(null);
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const requestId=useRef(crypto.randomUUID());
  const path = `targets/${t.id}`;
  const refresh = async () => setProgress(await api<Progress>(`${path}/progress`));
  useEffect(() => { refresh().catch(e => setErr(e.message)); }, [path]);
  const request = () => ({ interviewAt: instant(date), zone,
    windows: windows.map(w => ({ start:instant(w.start), end:instant(w.end) })) });
  const move = (id: string, action: string, startsAt?: string) => act(async () => { await api(`blocks/${id}`, "POST", { action, startsAt }); await refresh(); });
  const start = (blockId?: string) => act(async () => {
    const m = await api<{id: string}>("chats","POST",{ kind:"mock", targetId:t.id, blockId, requestId:requestId.current }); requestId.current=crypto.randomUUID();location.hash = `workspace/chat/${m.id}`;
  });
  return <>{err && <p role="alert">{err}</p>}<section><h2>{t.role}</h2><p>{t.company} &middot; {t.level} &middot; {t.round}</p>
    {(progress?.plan?.interviewAt || t.interviewAt) && <p><strong>Interview:</strong> {local((progress?.plan?.interviewAt || t.interviewAt)!)} (your local time)</p>}
    <p>{t.description}</p>{t.jobUrl && <a href={t.jobUrl} rel="noopener noreferrer" target="_blank">Original job posting</a>}
    <h3>Research for this round</h3><p>{t.researchStatus}{t.researchedAt && ` / ${local(t.researchedAt)}`}</p>
    {t.sources.map(s => <div className="item" key={s.url + s.theme}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title}</a>
      <small> {s.kind}</small><p>{s.theme}</p></div>)}
    {t.company && <button className="quiet" disabled={busy} onClick={() => void act(async () => {
      await api(`${path}/research`,"POST",{publicCompanyLookup:true}); await reload();
    })}>Research this public company name</button>}
    <p className="muted">Only the company name may reach the configured public search provider. Glassdoor themes require a licensed source; the app never bypasses a login.
      {" "}<a href="https://www.glassdoor.com/Interview/index.htm" target="_blank" rel="noopener noreferrer">Open Glassdoor yourself</a>.</p>
    <button disabled={busy} onClick={() => void start()}>Practice this target</button></section>
    <section><h2>Preparation schedule</h2><p>Set your interview and the times you can practice ({zone}). Preview works backward; nothing is booked until you confirm.</p>
      <form onSubmit={e => {e.preventDefault(); setPreview(null); void act(async () => { const p = await api<{blocks:Block[]}>(`${path}/schedule/preview`, "POST", request()); setPreview(p.blocks); });}}>
        <label>Interview date and time<input type="datetime-local" required value={date} onChange={e => {setDate(e.target.value); setPreview(null);}} /></label>
        {windows.map((w,i) => <div className="columns" key={i}>{(["start","end"] as const).map(k => <label key={k}>Availability {i+1} {k}
          <input type="datetime-local" required value={w[k]} onChange={e => {setWindows(windows.map((v,j) => i === j ? {...v,[k]:e.target.value} : v)); setPreview(null);}} /></label>)}
          {windows.length > 1 && <button type="button" className="quiet" onClick={() => {setWindows(windows.filter((_,j) => i !== j)); setPreview(null);}}>Remove window</button>}</div>)}
        <div className="actions"><button type="button" className="quiet" disabled={windows.length >= 40} onClick={() => { setWindows([...windows,{start:"",end:""}]); setPreview(null); }}>Add availability</button>
          <button disabled={busy}>Preview schedule</button></div></form>
      {preview && <div className="callout"><strong>Proposed new blocks</strong>{preview.length ? <ol>{preview.map(b => <li key={b.id}>{local(b.startsAt)}: {b.label} ({b.minutes} min)</li>)}</ol> :
        <p>No new block fits. Add availability or keep the current plan.</p>}
        {!!preview.length && <button disabled={busy} onClick={() => void act(async () => { await api(`${path}/schedule/confirm`, "POST", request()); setPreview(null); await refresh(); })}>Confirm schedule</button>}</div>}
      {progress?.plan && <><h3>Scheduled before {local(progress.plan.interviewAt)}</h3>{progress.plan.blocks.map(b => <div className="item" key={b.id}>
        <strong>{b.label}</strong> &middot; {local(b.startsAt)} &middot; {b.minutes} min &middot; {b.state}
        {b.attemptId ? <p><a href={`#workspace/${b.attemptId}`}>{b.state === "done" ? "Open result" : "Resume mock"}</a></p> : b.state === "planned" && <>
          <div className="actions"><button disabled={busy} onClick={() => void (b.kind === "mock" ? start(b.id) : move(b.id,"done"))}>{b.kind === "mock" ? "Start scheduled mock" : "Mark done"}</button>
            <button className="quiet" disabled={busy} onClick={() => void move(b.id,"skip")}>Skip block</button></div>
          <details><summary>Move block</summary><form onSubmit={e => { e.preventDefault(); try { void move(b.id,"move",instant(String(values(e.currentTarget).move))); } catch(e) { setErr(String(e)); } }}>
            <label>New time within availability<input required type="datetime-local" name="move" /></label><button disabled={busy}>Save time</button></form></details></>}
      </div>)}<button className="quiet" onClick={() => calendar(progress.plan!.blocks)}>Export calendar with reminders</button></>}
    </section>
    {progress && <section><h2>Readiness: {progress.readiness}</h2><p>{progress.comparable} comparable rounds in the last 30 days{progress.assessor && ` using the ${assessorName(progress.assessor)}`}. Different assessors and self-ratings are not mixed.
      {progress.delta !== null && ` Change from the previous round: ${progress.delta > 0 ? "+" : ""}${progress.delta} points.`} Not an employer prediction.</p>
      {progress.competencies?.map(c => <p key={c.name}>{c.name}: {c.points}/4{c.delta !== null ? ` (change ${c.delta > 0 ? "+" : ""}${c.delta})` : ""}</p>)}
      <h3>Attempt history</h3>{progress.attempts.length ? <ul>{progress.attempts.map(a => <li key={a.id}><a href={`#workspace/${a.id}`}>{local(a.completedAt ?? a.startedAt)}</a> &middot; {a.score === null ? "Unfinished" : `${a.score}/100 (${assessorName(a.assessor)})`}</li>)}</ul> : <p>No attempts yet. Skipping a block does not count as a failed mock.</p>}
    </section>}
  </>;
}
