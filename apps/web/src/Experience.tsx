import { useEffect, useRef, useState } from "react";
import { api, values, type Act, type Fact, type Workspace } from "./client";
import { DocumentPreview } from "./ExperienceDocuments";
import { VoiceInput } from "./Voice";

type Node = { id: string; kind: "role" | "project"; label: string; employer: string; dates: string; parentRoleId: string | null; revision: number };
type Source = { id: string; category: string; title: string; url: string | null; nodeId: string | null; createdAt: string };
type Builder = { id: string; goal: string; minutes: number | null; stage: string; state: string; revision: number; useModel: boolean };
type Citation = { id: string; factId: string; nodeId: string | null; sourceId: string | null; turnId: string | null; location: string; attributedExcerpt: string };
type Library = { nodes: Node[]; sources: Source[]; builders: Builder[]; citations: Citation[] };
type Turn = { id: string; seq: number; stage: string; speaker: string; mode: string; text: string };
type Transcript = { session: Builder & { roleId: string | null; projectId: string | null }; turns: Turn[] };
type Props = { data: Workspace; act: Act; busy: boolean };
type ActionProps = { change: Act; busy: boolean };
const categories: Record<string, string> = { resume: "Resume", "performance-review": "Performance review", referral: "Written referral or recommendation",
  "linkedin-export": "My LinkedIn export", "project-bookmark": "Project bookmark", "project-write-up": "Project write-up", "work-sample": "Work sample" };
const nameOf = (nodes: Node[], id: string | null) => nodes.find(n => n.id === id)?.label ?? "Unfiled";

export function Experience({ data, act, busy }: Props) {
  const [library, setLibrary] = useState<Library | null>(null), [selected, select] = useState(""), [error, setError] = useState("");
  const load = async () => { setLibrary(await api<Library>("experience")); setError(""); };
  useEffect(() => {
    let live = true;
    api<Library>("experience").then(s => { if (live) setLibrary(s); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  const change: Act = action => act(async () => {
    await action(); await load();
    if (typeof BroadcastChannel !== "undefined") { const ch = new BroadcastChannel("practice-library"); ch.postMessage("changed"); ch.close(); }
  });
  const current = library?.builders.find(b => b.id === selected) ?? library?.builders[0];
  return <><p className="eyebrow">My experience / private library</p><h1>Build your experience library</h1>
    <p>Start with a conversation or bring a source. A project link, someone else’s praise, and a team outcome are not proof of your personal contribution.</p>
    {error && <p role="alert">{error}</p>}
    <button className="quiet" disabled={busy} onClick={() => void act(load)}>Refresh library</button>
    {!library ? <p role="status">{error ? "Unable to open the library." : "Opening your library…"}</p> : <>
      <section><h2>Talk through your experience</h2>
        <details open={!library.builders.length}><summary>Start a context-building conversation</summary>
          <form onSubmit={e => {
            e.preventDefault(); const form = e.currentTarget, v = values(form);
            void change(async () => {
              const { id } = await api<{ id: string }>("experience/builders", "POST",
                { goal: v.goal, minutes: v.minutes ? Number(v.minutes) : null, useModel: v.model === "on" });
              select(id); form.reset();
            });
          }}>
            <label>What role are you seeking?<input name="goal" required maxLength={240} /></label>
            <label>How many minutes do you have? (optional)<input name="minutes" type="number" min={1} max={120} /></label>
            <p className="muted">Five minutes or less gives a shorter conversation. Role and project names organize the library; they are not approved resume claims.</p>
            {data.localCoachEnabled && <label><input type="checkbox" name="model" /> Let the configured local model choose a follow-up and suggest an exact excerpt from my submitted answer. Only my goal and that answer are shared.</label>}
            <button disabled={busy}>Start context builder</button>
          </form>
        </details>
        {current && <><label>Saved conversations<select value={current.id} onChange={e => select(e.target.value)}>
          {library.builders.map(b => <option key={b.id} value={b.id}>{b.goal} · {b.state}</option>)}
        </select></label>
          <Conversation key={`${current.id}:${current.revision}`} builder={current} library={library} data={data} change={change} busy={busy} /></>}
      </section>
      <section><h2>Roles and projects</h2><p>Browse or correct the labels you supplied, with or without a conversation.</p>
        <details><summary>Add a role or project</summary><NodeEditor nodes={library.nodes} change={change} busy={busy} /></details>
        {library.nodes.map(n => {
          const facts = data.facts.filter(f => library.citations.some(c => c.nodeId === n.id && c.factId === f.id));
          return <details key={n.id} className="item"><summary>{n.kind === "role" ? "Role" : "Project"}: {n.label}</summary>
            {n.parentRoleId && <p>Role: {nameOf(library.nodes, n.parentRoleId)}</p>}
            {(n.employer || n.dates) && <p>{[n.employer, n.dates].filter(Boolean).join(" · ")}</p>}
            {facts.length > 0 ? <ul>{facts.map(f => <li key={f.id}>{f.claim} <small>({f.confirmed ? "confirmed" : "needs review"})</small></li>)}</ul>
              : <p>No statements filed here yet.</p>}
            <NodeEditor key={[n.id, n.label, n.employer, n.dates, n.parentRoleId].join(":")} node={n} nodes={library.nodes} change={change} busy={busy} />
            <button className="quiet" disabled={busy} onClick={() => {
              if (window.confirm("Forget this record, child projects, and all associated sources and facts? Saved conversation transcripts remain until separately deleted."))
                void change(() => api(`experience/nodes/${n.id}`, "DELETE"));
            }}>Forget {n.kind} and linked evidence</button>
          </details>;
        })}
      </section>
      <section><h2>Add evidence</h2><EvidenceImport nodes={library.nodes} change={change} busy={busy} model={data.localCoachEnabled} />
        {!!library.sources.length && <h3>Saved sources</h3>}
        {library.sources.map(s => <details className="item" key={s.id}><summary>{s.title} · {categories[s.category]}</summary>
          <p>{nameOf(library.nodes, s.nodeId)} · Saved {new Date(s.createdAt).toLocaleDateString()}</p>
          {s.url && <p>Bookmark only (not fetched): <code>{s.url}</code></p>}
          {library.citations.filter(c => c.sourceId === s.id).map(c => {
            const f = data.facts.find(f => f.id === c.factId);
            return f && <div key={c.id}><strong>{c.location} · {f.confirmed ? "Confirmed" : "Needs review"}</strong><blockquote>{c.attributedExcerpt}</blockquote></div>;
          })}
          <button className="quiet" disabled={busy} onClick={() => {
            if (window.confirm("Forget this source and all its linked facts, including confirmed ones? Previously downloaded files cannot be recalled."))
              void change(() => api(`experience/sources/${s.id}`, "DELETE"));
          }}>Forget source and linked facts</button>
        </details>)}
      </section>
      <CompareFacts facts={data.facts.filter(f => library.citations.some(c => c.factId === f.id))} change={change} busy={busy} />
      <BaseResume data={data} act={act} busy={busy} />
    </>}
  </>;
}

function CompareFacts({ facts, change, busy }: ActionProps & { facts: Fact[] }) {
  const [left, pickLeft] = useState(""), [right, pickRight] = useState(""), [wording, edit] = useState("");
  if (facts.length < 2) return null;
  const a = facts.find(f => f.id === left), b = facts.find(f => f.id === right);
  const choose = (label: string, id: string, select: (id: string) => void, exclude: string, fact?: Fact) =>
    <div><label>{label}<select value={id} onChange={e => { select(e.target.value); edit(""); }}>
      <option value="">Choose a statement</option>{facts.filter(f => f.id !== exclude).map(f => <option key={f.id} value={f.id}>{f.project}: {f.claim.slice(0, 75)}</option>)}
    </select></label>{fact && <><p><strong>{fact.confirmed ? "Confirmed" : "Not confirmed"}:</strong> {fact.claim}</p><blockquote>{fact.source}</blockquote></>}</div>;
  const snapshot = (f: Fact) => ({ id: f.id, claim: f.claim, confirmed: f.confirmed, allowDrafts: f.allowDrafts, allowLive: f.allowLive });
  return <section><details><summary>Compare or merge two sourced statements</summary>
    <p>When sources disagree about ownership, timing or outcomes, compare what each actually says. Keep both if you are unsure.</p>
    <div className="columns">{choose("First statement", left, pickLeft, right, a)}{choose("Second statement", right, pickRight, left, b)}</div>
    {a && b && <form onSubmit={e => {
      e.preventDefault();
      if (!window.confirm("Replace both statements with one unconfirmed proposal? All supporting passages remain; draft and live permissions reset."))
        return;
      void change(async () => {
        await api("experience/merge", "POST", { left: snapshot(a), right: snapshot(b), claim: wording });
        pickLeft(""); pickRight(""); edit("");
      });
    }}><label>Wording you want to review<textarea required maxLength={2000} value={wording} onChange={e => edit(e.target.value)} /></label>
      <p>This replaces the originals with one unconfirmed proposal and retains up to four source passages. Existing draft and live permissions do not carry over.</p>
      <button disabled={busy}>Merge into a proposal</button></form>}
  </details></section>;
}

function NodeEditor({ node, nodes, change, busy }: ActionProps & { node?: Node; nodes: Node[] }) {
  const [kind, setKind] = useState(node?.kind ?? "role");
  return <form onSubmit={e => {
    e.preventDefault(); const form = e.currentTarget, v = values(form);
    void change(async () => {
      await api(node ? `experience/nodes/${node.id}` : "experience/nodes", node ? "PUT" : "POST",
        { kind, label: v.label, employer: kind === "role" ? v.employer : "", dates: v.dates,
          parentRoleId: kind === "project" && v.parentRoleId || null, revision: node?.revision });
      if (!node) { form.reset(); setKind("role"); }
    });
  }}>
    {!node && <label>Record type<select value={kind} onChange={e => setKind(e.target.value as Node["kind"])}><option value="role">Role</option><option value="project">Project</option></select></label>}
    <label>{kind === "role" ? "Role title" : "Project label"}<input name="label" required maxLength={100} defaultValue={node?.label} /></label>
    {kind === "role" ? <label>Employer or organization (optional)<input name="employer" maxLength={120} defaultValue={node?.employer} /></label> :
      <label>Associated role<select name="parentRoleId" defaultValue={node?.parentRoleId ?? ""}><option value="">Independent project</option>
        {nodes.filter(n => n.kind === "role").map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>}
    <label>Dates, including approximate dates (optional)<input name="dates" maxLength={100} defaultValue={node?.dates} /></label>
    <button disabled={busy}>{node ? "Save label and details" : "Add record"}</button>
  </form>;
}

function Conversation({ builder, library, data, change, busy }: ActionProps & { builder: Builder; library: Library; data: Workspace }) {
  const [detail, setDetail] = useState<Transcript | null>(null), [error, err] = useState(""), [text, setText] = useState(""), [nodeId, pick] = useState("");
  const clientId = useRef(crypto.randomUUID()), path = `experience/builders/${builder.id}`;
  useEffect(() => { let live = true;
    api<Transcript>(path).then(d => { if (live) setDetail(d); }).catch(e => { if (live) err(e.message); });
    return () => { live = false; };
  }, [path]);
  if (!detail) return <p role={error ? "alert" : "status"}>{error || "Opening the saved transcript…"}</p>;
  const { session: b, turns } = detail, last = turns[turns.length - 1];
  const possible = library.nodes.filter(n => n.kind === b.stage && (b.stage !== "project" || !b.roleId || b.roleId === n.parentRoleId));
  const gaps = turns.filter(t => t.speaker === "candidate" && t.mode !== "answer").map(t => `${t.stage} (${t.mode === "skip" ? "skipped" : "unknown"})`);
  const ids = library.citations.filter(c => turns.some(t => t.id === c.turnId)).map(c => c.factId);
  const facts = data.facts.filter(f => ids.includes(f.id));
  function send(mode: string) {
    return change(() => api(`${path}/turns`, "POST", { clientTurnId: clientId.current, revision: b.revision, mode, text: mode === "answer" ? text : null,
      nodeId: mode === "answer" && nodeId ? nodeId : null }));
  }
  const state = (s: string) => change(() => api(`${path}/state`, "POST", { revision: b.revision, state: s }));
  return <article className="item"><p className="eyebrow">{b.state} · {b.useModel ? "Local coach with guided fallback" : "Guided prompts"}</p>
    <h3>{b.goal}</h3>
    {b.state === "active" && <><p className="callout"><strong>{last.text}</strong></p>
      <form onSubmit={e => { e.preventDefault(); void send("answer"); }}>
        {!!possible.length && <label>Use an existing {b.stage} (optional)<select value={nodeId} onChange={e => {
          pick(e.target.value); setText(possible.find(n => n.id === e.target.value)?.label ?? "");
        }}><option value="">Enter a new label</option>{possible.map(n => <option key={n.id} value={n.id}>{n.label}</option>)}</select></label>}
        <VoiceInput label="Your builder answer" required value={text} onChange={v => { setText(v); if (nodeId && v !== nameOf(library.nodes, nodeId)) pick(""); }}
          maxLength={["role","project","dates"].includes(b.stage) ? 100 : b.stage === "employer" ? 120 : 1500} prompt={last.text} />
        <div className="actions"><button disabled={busy}>Save builder answer</button>
          <button type="button" className="quiet" disabled={busy} onClick={() => void send("skip")}>Skip this question</button>
          <button type="button" className="quiet" disabled={busy} onClick={() => void send("unknown")}>Mark unknown</button></div>
      </form></>}
    <p>{facts.filter(f => !f.confirmed).length} statements awaiting review · {facts.filter(f => f.confirmed).length} confirmed from this conversation.</p>
    {gaps.length > 0 && <p>Not established: {gaps.join(", ")}. No facts were created for these gaps.</p>}
    <details><summary>Read committed transcript ({turns.length} turns)</summary>
      <ol>{turns.map(t => <li key={t.id}><strong>{t.speaker === "coach" ? "Coach" : "You"} · {t.stage}</strong><p>{t.text}</p></li>)}</ol>
    </details>
    <div className="actions">{b.state === "active" && <button className="quiet" disabled={busy} onClick={() => void state("paused")}>Pause builder</button>}
      {b.state === "paused" && <button disabled={busy} onClick={() => void state("active")}>Resume conversation</button>}
      {b.state !== "closed" && <button className="quiet" disabled={busy} onClick={() => void state("closed")}>Finish and review facts</button>}
      <button className="quiet" disabled={busy} onClick={() => {
        if (window.confirm("Forget this conversation, its transcript and all its linked facts? Named role/project records remain; you can forget those separately."))
          void change(() => api(path, "DELETE"));
      }}>Forget conversation</button></div>
  </article>;
}

type Excerpt = { text: string; location: string };
function EvidenceImport({ nodes, change, busy, model }: ActionProps & { nodes: Node[]; model: boolean }) {
  const [category, setCategory] = useState("resume"), [paste, setPaste] = useState(""), [snips, setSnips] = useState<Excerpt[]>([]);
  const [message, setMessage] = useState(""), [generation, resetReader] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  function add(text: string, location: string) {
    if (snips.length >= 4 || !text.trim() || text.length > 1600) { setMessage("Select up to four passages of 1–1,600 characters each."); return; }
    setSnips([...snips, { text: text.trim(), location }]); setMessage("");
  }
  return <form onSubmit={e => {
    e.preventDefault(); const form = e.currentTarget, v = values(form);
    if (!snips.length && !v.url) { setMessage("Select an excerpt or enter a bookmark before saving."); return; }
    void change(async () => {
      await api("experience/sources", "POST", { category, title: v.title, nodeId: v.nodeId || null, url: v.url || null, excerpts: snips,
        reviewed: v.reviewed === "on", useModel: v.model === "on" && snips.length > 0 });
      setSnips([]); setPaste(""); setCategory("resume"); resetReader(n => n + 1); form.reset();
      setMessage("Saved. Review any proposed statements in the fact editor below; none were confirmed.");
    });
  }}>
    <label>Evidence category<select value={category} onChange={e => setCategory(e.target.value)}>
      {Object.entries(categories).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
    </select></label>
    <label>Private source title<input name="title" required maxLength={120} /></label>
    <label>File under a role or project<select name="nodeId"><option value="">Unfiled</option>{nodes.map(n => <option key={n.id} value={n.id}>{n.kind}: {n.label}</option>)}</select></label>
    <label>HTTPS bookmark (never fetched)<input name="url" type="url" required={category === "project-bookmark"} maxLength={1000} /></label>
    <p className="muted">Save a plain link without credentials or query parameters. For LinkedIn, use your own profile PDF, unzipped CSV export, or paste. A bookmark alone creates no fact.</p>
    {snips.length < 4 && <><DocumentPreview key={generation} onUse={add} disabled={busy} />
      <label>Or paste text for a private preview<textarea ref={area} value={paste} maxLength={32_000} onChange={e => setPaste(e.target.value)} rows={4} /></label>
      <button type="button" className="quiet" disabled={busy || !paste.trim()} onClick={() => {
        const { selectionStart: start, selectionEnd: end } = area.current!, selected = end > start;
        const text = selected ? paste.slice(start, end) : paste;
        add(text, selected ? `Pasted characters ${start + 1}–${end}` : "Pasted excerpt");
        if (text.trim() && text.length <= 1600) setPaste("");
      }}>Select pasted passage for redaction</button></>}
    {snips.map((s, i) => <div key={i} className="item">
      <label>Source location {i + 1}<input required maxLength={100} value={s.location} onChange={e => setSnips(snips.map((p, k) => k === i ? { ...p, location: e.target.value } : p))} /></label>
      <label>Selected excerpt {i + 1} (remove names and confidential details)<textarea required maxLength={1600} value={s.text} rows={4}
        onChange={e => setSnips(snips.map((p, k) => k === i ? { ...p, text: e.target.value } : p))} /></label>
      <button className="quiet" type="button" onClick={() => setSnips(snips.filter((_, k) => k !== i))}>Remove excerpt {i + 1}</button>
    </div>)}
    {model && !!snips.length && <label><input type="checkbox" name="model" /> Ask the configured local model to suggest verbatim quotes from only these reviewed passages.</label>}
    <label><input required type="checkbox" name="reviewed" /> I have permission to use this material and reviewed the title, link and excerpts for private information.</label>
    <p>Only the displayed title, bookmark, and selected excerpts are saved. Reviewers’ opinions remain attributed to the source. Drafts and live reminders are off until you explicitly allow them.</p>
    <button disabled={busy}>Save reviewed evidence</button>{message && <p role="status">{message}</p>}
  </form>;
}

function BaseResume({ data, act, busy }: Props) {
  const supported = data.facts.filter(f => f.confirmed && f.allowDrafts);
  return <section><h2>Base resume</h2><p>Only confirmed statements explicitly allowed in drafts appear here. Sources, unreviewed labels, third-party names in source metadata, and unknown outcomes are not added.</p>
    {supported.length ? <ul>{supported.map(f => <li key={f.id}>{f.claim}</li>)}</ul> : <p>Nothing approved for export yet. Confirm a statement and enable its draft permission below.</p>}
    <button disabled={busy || !supported.length} onClick={() => void act(async () => {
      const resume = await api<{ text: string; factCount: number }>("experience/resume");
      if (!resume.factCount) throw new Error("No confirmed statements are currently allowed in drafts.");
      const url = URL.createObjectURL(new Blob([resume.text + "\n"], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = "base-resume.txt"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}>Export base resume (.txt)</button>
  </section>;
}
