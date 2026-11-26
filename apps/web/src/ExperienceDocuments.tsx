import { useEffect, useRef, useState } from "react";
import type { Passage } from "./ExperienceDocumentReader";

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
      const localModule = new URL("./assets/experience-reader.js", document.baseURI).href;
      const reader: typeof import("./ExperienceDocumentReader") = await import(localModule);
      const pages = await reader.readDocument(file, op.signal);
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
