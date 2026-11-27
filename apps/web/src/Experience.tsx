import { useEffect, useState } from "react";
import { api, values, type Act, type Fact, type Workspace } from "./client";
import { DocumentImport } from "./ExperienceDocuments";

type Node = { id: string; kind: "role" | "project" | "situation"; label: string; employer: string; dates: string; parentRoleId: string | null; revision: number };
type Source = { id: string; category: string; title: string; description: string | null; url: string | null; nodeId: string | null; createdAt: string };
type Builder = { id: string; goal: string; minutes: number | null; stage: string; state: string; revision: number; useModel: boolean };
type Citation = { id: string; factId: string; nodeId: string | null; sourceId: string | null; turnId: string | null; location: string; attributedExcerpt: string };
type Library = { nodes: Node[]; sources: Source[]; builders: Builder[]; citations: Citation[] };
type Turn = { id: string; seq: number; stage: string; speaker: string; mode: string; text: string };
type Transcript = { session: Builder & { roleId: string | null; projectId: string | null }; turns: Turn[] };
type Props = { data: Workspace; act: Act; busy: boolean };
type ActionProps = { change: Act; busy: boolean };
const categories: Record<string, string> = { document: "Document", resume: "Resume", "performance-review": "Performance review", referral: "Written referral or recommendation",
  email: "Email correspondence", "linkedin-export": "My LinkedIn profile or export", "project-bookmark": "Project bookmark", "project-write-up": "Project documentation", "work-sample": "Work sample" };
const nameOf = (nodes: Node[], id: string | null) => nodes.find(n => n.id === id)?.label ?? "Unfiled";

export function Experience({ data, act, busy }: Props) {
  const [library, setLibrary] = useState<Library | null>(null), [error, setError] = useState("");
  const load = async () => { setLibrary(await api<Library>("experience")); setError(""); };
  useEffect(() => {
    let live = true;
    api<Library>("experience").then(s => { if (live) setLibrary(s); }).catch(e => { if (live) setError(e.message); });
    return () => { live = false; };
  }, []);
  const change: Act = action => act(async () => {
    await action();
    if (typeof BroadcastChannel !== "undefined") { const ch = new BroadcastChannel("practice-library"); ch.postMessage("changed"); ch.close(); }
    await load();
  });
  return <><p className="eyebrow">Career library</p><h1>Job experience</h1>
    <p className="intro">Keep the stories behind your resume. Bring a document, link a profile, or <a href="#workspace/new/builder">talk it through in Chat</a>.</p>
    {error && <p role="alert">{error}</p>}
    <DocumentImport change={change} busy={busy} />
    {data.facts.length > 0 && <section><h2>Review your statements</h2><p className="muted">Check the wording and choose where each fact can be used.</p>
      {data.facts.map(f => <Evidence key={`${f.id}-${f.confirmed}-${f.claim}`} fact={f} change={change} busy={busy}/>)}</section>}
    {!library ? <p role="status">{error ? "Unable to open the library." : "Opening your library…"}</p> : <>
      <section><h2>Jobs, projects &amp; situations</h2>
        {!library.nodes.length && <p className="muted">Drop a document or describe your work in Chat to start your job history.</p>}
        {library.nodes.map(n => {
          const facts = data.facts.filter(f => library.citations.some(c => c.nodeId === n.id && c.factId === f.id));
          return <details key={n.id} className="item"><summary>{n.kind === "role" ? "Role" : n.kind === "project" ? "Project" : "Situation"}: {n.label}</summary>
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
      {!!library.sources.length && <section><h2>Saved sources</h2>
        {library.sources.map(s => <details className="item" key={s.id}><summary>{s.title} · {s.category === "chat" ? "Conversation" : categories[s.category]}
          {s.description && <span className="source-description">AI summary: {s.description}</span>}</summary>
          <p>{s.nodeId && `${nameOf(library.nodes, s.nodeId)} · `}Saved {new Date(s.createdAt).toLocaleDateString()}</p>
          {s.url && <p>Bookmark only (not fetched): <code>{s.url}</code></p>}
          {library.citations.filter(c => c.sourceId === s.id).map(c => {
            const f = data.facts.find(f => f.id === c.factId);
            return f && <div key={c.id}><strong>{c.location} · {f.confirmed ? "Confirmed" : "Needs review"}</strong><blockquote>{c.attributedExcerpt}</blockquote></div>;
          })}
          <button className="quiet" disabled={busy} onClick={() => {
            if (window.confirm("Forget this source, its import chat, and statements originating here? Earlier history it only corroborates is kept. Previously downloaded files cannot be recalled."))
              void change(() => api(`experience/sources/${s.id}`, "DELETE"));
          }}>Forget source and linked facts</button>
        </details>)}
      </section>}
      <CompareFacts facts={data.facts.filter(f => library.citations.some(c => c.factId === f.id))} change={change} busy={busy} />
      <BaseResume data={data} act={act} busy={busy} />
    </>}
  </>;
}

function Evidence({ fact, change, busy }: ActionProps & { fact: Fact }) {
  const editor = <form onSubmit={e => { e.preventDefault(); const v = values(e.currentTarget);
    void change(() => api(`evidence/${fact.id}/confirm`,"POST",{claim:v.claim,allowDrafts:v.drafts==="on",allowLive:v.live==="on"}));
  }}><p>Original statement:</p><blockquote>{fact.source}</blockquote>
    <label>Statement to keep<textarea name="claim" required maxLength={2000} defaultValue={fact.claim}/></label>
    <label><input type="checkbox" name="drafts" defaultChecked={fact.allowDrafts}/> May use this fact in resumes and cover letters</label>
    <label><input type="checkbox" name="live" defaultChecked={fact.allowLive}/> May use a separately approved project label in live reminders</label>
    <div className="actions"><button disabled={busy}>{fact.confirmed ? "Save correction" : "Confirm fact"}</button>
      <button type="button" className="quiet" disabled={busy} onClick={() => void change(() => api(`evidence/${fact.id}`,"DELETE"))}>
        {fact.confirmed ? "Forget fact" : "Discard proposal"}</button></div></form>;
  return <article className="item"><p className="eyebrow">{fact.confirmed ? "Confirmed" : "Needs your review"} / {fact.origin}</p><h3>{fact.project}</h3>
    {fact.confirmed ? <><p>{fact.claim}</p><details><summary>Edit or forget this fact</summary>{editor}</details></> : editor}</article>;
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
          parentRoleId: kind !== "role" && v.parentRoleId || null, revision: node?.revision });
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

export function ArchivedConversation({ id, act, busy }: {id: string; act: Act; busy: boolean}) {
  const [detail, setDetail] = useState<Transcript | null>(null), [error, err] = useState("");
  const path = `experience/builders/${id}`;
  useEffect(() => { let live = true;
    api<Transcript>(path).then(d => { if (live) setDetail(d); }).catch(e => { if (live) err(e.message); });
    return () => { live = false; };
  }, [path]);
  if (!detail) return <p role={error ? "alert" : "status"}>{error || "Opening the saved transcript…"}</p>;
  return <><a href="#workspace/history">Chat history</a><p className="eyebrow">Earlier conversation</p><h1>{detail.session.goal}</h1>
    <ol className="transcript">{detail.turns.map(t => <li key={t.id} className={t.speaker === "coach" ? "assistant" : "user"}>
      <small>{t.speaker === "coach" ? "Coach" : "You"}</small><p>{t.text}</p></li>)}</ol>
    <a className="button" href="#workspace/new/builder">Continue in a new chat</a>{" "}
    <button className="quiet" disabled={busy} onClick={() => {
        if (window.confirm("Forget this conversation, its transcript and all its linked facts? Named role/project records remain; you can forget those separately."))
          void act(async () => { await api(path, "DELETE"); location.hash = "workspace/history"; });
      }}>Forget conversation</button></>;
}

function BaseResume({ data, act, busy }: Props) {
  const supported = data.facts.filter(f => f.confirmed && f.allowDrafts);
  return <section><h2>Base resume</h2><p>Only confirmed statements explicitly allowed in drafts appear here. Sources, unreviewed labels, third-party names in source metadata, and unknown outcomes are not added.</p>
    {supported.length ? <ul>{supported.map(f => <li key={f.id}>{f.claim}</li>)}</ul> : <p>Nothing approved for export yet. Confirm a statement and enable its draft permission in the review section.</p>}
    <button disabled={busy || !supported.length} onClick={() => void act(async () => {
      const resume = await api<{ text: string; factCount: number }>("experience/resume");
      if (!resume.factCount) throw new Error("No confirmed statements are currently allowed in drafts.");
      const url = URL.createObjectURL(new Blob([resume.text + "\n"], { type: "text/plain;charset=utf-8" }));
      const a = document.createElement("a"); a.href = url; a.download = "base-resume.txt"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    })}>Export base resume (.txt)</button>
  </section>;
}
