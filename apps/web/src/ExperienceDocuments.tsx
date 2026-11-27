import { useEffect, useRef, useState } from "react";
import { api, type Act } from "./client";
import type { Passage } from "./ExperienceDocumentReader";
import { Icon } from "./CareerUI";

async function readLocalDocument(file: File, signal: AbortSignal): Promise<Passage[]> {
  const localModule = new URL("./assets/experience-reader.js", document.baseURI).href;
  const reader: typeof import("./ExperienceDocumentReader") = await import(localModule);
  try { return await reader.readDocument(file, signal); }
  catch (e) {
    if (e instanceof Error && /paste|limits|cancelled/i.test(e.message)) throw e;
    throw new Error("Could not read this document. Paste readable text instead.");
  }
}

export function DocumentImport({ change, busy, compact = false }: { change: Act; busy: boolean; compact?: boolean }) {
  const picker = useRef<HTMLInputElement>(null), active = useRef<AbortController | null>(null);
  const [dragging, setDragging] = useState(false), [text, setText] = useState(""), [progress, setProgress] = useState("");
  const [result, setResult] = useState(""), [error, setError] = useState("");
  const region = useRef<HTMLElement>(null), submitRef = useRef<(items: (File | string)[]) => void>(() => {});
  useEffect(() => () => active.current?.abort(), []);
  useEffect(() => {
    if (!compact) return;
    const chat = region.current?.closest<HTMLElement>(".chat-page");
    const over = (e: DragEvent) => { if (e.dataTransfer?.types.includes("Files")) { e.preventDefault(); setDragging(true); } };
    const leave = (e: DragEvent) => { if (!(e.relatedTarget instanceof Node) || !chat?.contains(e.relatedTarget)) setDragging(false); };
    const drop = (e: DragEvent) => { setDragging(false); if (e.dataTransfer?.files.length) { e.preventDefault(); submitRef.current(Array.from(e.dataTransfer.files)); } };
    chat?.addEventListener("dragover", over); chat?.addEventListener("dragleave", leave); chat?.addEventListener("drop", drop);
    return () => { chat?.removeEventListener("dragover", over); chat?.removeEventListener("dragleave", leave); chat?.removeEventListener("drop", drop); };
  }, [compact]);
  function submit(items: (File | string)[]) {
    if (!items.length || busy || active.current) return;
    if (items.length > 1) { setError("Drop one file at a time. Each document opens its own chat."); return; }
    void change(async () => {
      const op = new AbortController(); active.current = op;
      setResult(""); setError("");
      try {
        const item = items[0], name = typeof item === "string" ? "Pasted text" : item.name;
        if (typeof item === "string" && /^https?:\/\/\S+$/i.test(item.trim())) {
          const url = new URL(item.trim());
          await api("experience/sources", "POST", { category: /(^|\.)linkedin\.com$/i.test(url.hostname) ? "linkedin-export" : "project-bookmark",
            title: url.hostname, url: url.href, reviewed: true, excerpts: [] }, op.signal);
          setResult("Bookmark saved. The link was not opened.");
        } else {
          setProgress(`Opening an import chat for ${name}...`);
          const passages = typeof item === "string" ? [{ location: "Pasted text", text: item.trim() }] : await readLocalDocument(item, op.signal);
          const saved = await api<{ id: string }>("experience/documents", "POST", {
            fileName: typeof item === "string" ? undefined : name, passages, requestId: crypto.randomUUID()
          }, op.signal);
          location.hash = `workspace/chat/${saved.id}`;
        }
        if (typeof item === "string") setText("");
      } catch (e) {
        if (!op.signal.aborted) setError(e instanceof Error ? e.message : "Import failed. Try again.");
      } finally {
        active.current = null;
        if (!op.signal.aborted) setProgress("");
      }
    });
  }
  submitRef.current = submit;
  return <section ref={region} className={compact ? "chat-attachment" : undefined} aria-label="Import experience">
    <div className={`document-drop${dragging ? " dragging" : ""}`} onDragOver={e => {
      e.preventDefault(); e.dataTransfer.dropEffect = busy ? "none" : "copy"; setDragging(!busy);
    }} onDragLeave={e => { if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setDragging(false); }}
      onDrop={e => {
        e.preventDefault(); e.stopPropagation(); setDragging(false);
        const files = Array.from(e.dataTransfer.files);
        const droppedText = e.dataTransfer.getData("text/plain") || e.dataTransfer.getData("text/uri-list");
        submit(files.length ? files : droppedText.trim() ? [droppedText] : []);
      }}>
      {!compact && <><span className="intent-icon builder"><Icon name="upload"/></span><h2>Drop a document here</h2>
      <p>A new chat will read it, search your job history, and show what was added or matched.</p></>}
      <button type="button" className={compact ? "composer-tool" : "quiet"} disabled={busy}
        aria-label={compact ? "Attach a document" : undefined} title={compact ? "Attach a document in a new chat" : undefined}
        onClick={() => picker.current?.click()}>{compact ? <><Icon name="attach"/>Attach</> : "Choose file"}</button>
      <input hidden ref={picker} type="file" aria-label="Choose an experience document" accept=".pdf,.docx,.txt,.md,.csv" disabled={busy}
        onChange={e => { const files = Array.from(e.currentTarget.files ?? []); e.currentTarget.value = ""; submit(files); }} />
      {!compact && <small>Text PDF, DOCX, TXT, Markdown or CSV. Up to 3 MiB and 100,000 characters.</small>}
    </div>
    {!compact && <><p className="privacy-line">Share only text you can use with the configured model. The original file is not kept. New statements need review before use in drafts or live reminders.</p>
    <details><summary>Paste text or a link instead</summary>
      <form onSubmit={e => { e.preventDefault(); submit([text]); }}>
        <label>Document text or bookmark<textarea value={text} disabled={busy} onChange={e => setText(e.target.value)} maxLength={100_000} rows={4}
          placeholder="Paste your notes, an email, or a plain HTTPS link..." /></label>
        <button disabled={busy || !text.trim()}>Add to Job experience</button>
      </form></details></>}
    {(progress || result) && <p role="status">{progress || result}</p>}{error && <p role="alert">{error}</p>}
  </section>;
}

// Reusable for private job descriptions as well as evidence. No file, URL, or text is posted here.
export function DocumentPreview({ onUse, label = "Preview a local document", maxLength = 1600, disabled = false }: {
  onUse: (text: string, location: string) => void; label?: string; maxLength?: number; disabled?: boolean;
}) {
  const [passages, setPassages] = useState<Passage[]>([]), [index, select] = useState(0), [draft, edit] = useState("");
  const [loading, setLoading] = useState(false), [message, setMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null), raw = useRef<HTMLTextAreaElement>(null), active = useRef<AbortController | null>(null);
  const passage = index < 0 ? { location: "Document text", text: passages.map(p => p.text).join("\n\n") } : passages[index];
  useEffect(() => () => active.current?.abort(), []);
  function clear() {
    active.current?.abort(); active.current = null;
    setPassages([]); edit(""); select(0); setLoading(false); setMessage("");
    if (fileInput.current) fileInput.current.value = "";
  }
  async function load(file?: File) {
    active.current?.abort(); setPassages([]); edit(""); select(0); setMessage(""); setLoading(false);
    if (!file) return;
    const op = new AbortController(); active.current = op; setLoading(true);
    try {
      const pages = await readLocalDocument(file, op.signal);
      if (!op.signal.aborted) setPassages(pages);
    } catch (e) {
      if (!op.signal.aborted) setMessage(e instanceof Error && /Paste|preview limits|cancelled/i.test(e.message) ? e.message :
        "Could not read this document locally. Paste an authorized excerpt instead.");
    } finally { if (!op.signal.aborted) setLoading(false); }
  }
  return <div className="item">
    <label>{label}<input type="file" ref={fileInput} accept=".pdf,.docx,.txt,.md,.csv" disabled={disabled} onChange={e => void load(e.target.files?.[0])} /></label>
    <p className="muted">PDF with selectable text (up to 40 pages), DOCX, or UTF-8 text/Markdown/CSV. Up to 3 MiB and 100,000 characters. Nothing is uploaded. No OCR, attachments, links or macros are opened.</p>
    {loading && <p role="status">Reading on this device…</p>}
    {passage && <><label>Source passage<select value={index} onChange={e => { select(Number(e.target.value)); edit(""); setMessage(""); }}>
      {passages.map((p, i) => <option key={p.location} value={i}>{p.location}</option>)}
      {passages.length > 1 && <option value={-1}>All document text</option>}
    </select></label>
      <label>Local preview (highlight the part to keep)<textarea ref={raw} value={passage.text} readOnly rows={6} /></label>
      <button type="button" className="quiet" disabled={disabled} onClick={() => {
        const area = raw.current!;
        const selection = area.selectionEnd > area.selectionStart ? passage.text.slice(area.selectionStart, area.selectionEnd) : passage.text;
        if (selection.length > maxLength) { setMessage(`Highlight a smaller passage (up to ${maxLength} characters).`); return; }
        edit(selection); setMessage("");
      }}>Copy selected text to redaction editor</button>
      <label>Redact or correct this excerpt before using it<textarea value={draft} onChange={e => edit(e.target.value)} maxLength={maxLength} rows={4} /></label>
      <button type="button" disabled={disabled || !draft.trim()} onClick={() => {
        onUse(draft.trim(), passage.location); clear();
      }}>Use reviewed excerpt</button></>}
    {(loading || passage || message) && <button type="button" className="quiet" onClick={clear}>Clear local preview</button>}
    {message && <p role="alert">{message}</p>}
  </div>;
}
