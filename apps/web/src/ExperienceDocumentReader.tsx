import { Unzip, UnzipInflate } from "fflate";
import { getDocument, PDFWorker } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";

export type Passage = { location: string; text: string };
const maxBytes = 3 * 1024 * 1024, maxText = 100_000, maxXml = 2 * 1024 * 1024;
const tooLarge = () => new Error("This document exceeds the local preview limits. Paste a shorter authorized excerpt instead.");
const unsupported = () => new Error("No readable text was found. Paste an excerpt instead; scans, encrypted files and older .doc files are not supported.");

async function pdf(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal): Promise<Passage[]> {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-")) throw unsupported();
  const port = new Worker(new URL("./experience-pdf.worker.js", import.meta.url), { type: "module" });
  const worker = PDFWorker.create({ port, verbosity: 0 });
  const task = getDocument({ data: bytes, worker, verbosity: 0, useWorkerFetch: false, useWasm: false, disableFontFace: true,
    useSystemFonts: false, stopAtErrors: true, maxImageSize: 1, isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    enableXfa: false, disableRange: true, disableStream: true, disableAutoFetch: true });
  let timeout: number | undefined, abort: (() => void) | undefined;
  try {
    const stop = new Promise<never>((_, reject) => {
      abort = () => reject(new Error("Preview cancelled."));
      signal.addEventListener("abort", abort, { once: true });
      timeout = window.setTimeout(() => reject(new Error("Preview timed out. Paste a shorter excerpt instead.")), 10_000);
      port.addEventListener("error", () => reject(unsupported()), { once: true });
      task.onPassword = () => reject(unsupported());
      if (signal.aborted) abort();
    });
    const extract = async () => {
      const doc = await task.promise;
      if (doc.numPages > 40) throw tooLarge();
      const pages: Passage[] = [];
      let count = 0, spans = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        const page = await doc.getPage(p), reader = page.streamTextContent({}).getReader();
        const pieces: string[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const item of (value as TextContent).items) {
            if (++spans > 40_000) throw tooLarge();
            if (!("str" in item)) continue;
            count += item.str.length + 1;
            if (count > maxText) throw tooLarge();
            pieces.push(item.str, item.hasEOL ? "\n" : " ");
          }
        }
        const text = pieces.join("").trim();
        if (text) pages.push({ location: `Page ${p}`, text });
        page.cleanup();
      }
      return pages;
    };
    return await Promise.race([extract(), stop]);
  } finally {
    window.clearTimeout(timeout);
    if (abort) signal.removeEventListener("abort", abort);
    // Terminate the dedicated worker even if a malformed PDF never acknowledges a cleanup message.
    void task.destroy().catch(() => {});
    worker.destroy();
    port.terminate();
  }
}

function docx(bytes: Uint8Array): Passage[] {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b || bytes[2] !== 3 || bytes[3] !== 4) throw unsupported();
  let entries = 0, declared = 0, actual = 0, found = false, complete = false;
  const chunks: Uint8Array[] = [], started = performance.now();
  const archive = new Unzip(file => {
    if (++entries > 256 || (declared += file.originalSize ?? 0) > 16 * 1024 * 1024) throw tooLarge();
    if (file.name !== "word/document.xml") return;
    if (found || (file.originalSize ?? 0) > maxXml) throw tooLarge();
    found = true;
    file.ondata = (err, chunk, final) => {
      if (err) throw unsupported();
      if ((actual += chunk.length) > maxXml) throw tooLarge();
      chunks.push(chunk); complete = final;
    };
    file.start();
  });
  archive.register(UnzipInflate);
  // Bound each inflater input as well as actual expanded output; ZIP headers need not be truthful.
  for (let at = 0; at < bytes.length; at += 1024) {
    if (performance.now() - started > 3500) throw tooLarge();
    archive.push(bytes.subarray(at, at + 1024), at + 1024 >= bytes.length);
  }
  if (!complete) throw unsupported();
  const content = new Uint8Array(actual);
  let at = 0;
  for (const chunk of chunks) { content.set(chunk, at); at += chunk.length; }
  const xml = new TextDecoder("utf-8", { fatal: true }).decode(content);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw unsupported();
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const ns = doc.documentElement.namespaceURI;
  if (doc.documentElement.localName !== "document" || !ns ||
      !["http://schemas.openxmlformats.org/wordprocessingml/2006/main", "http://purl.oclc.org/ooxml/wordprocessingml/main"].includes(ns)) throw unsupported();
  if (doc.getElementsByTagName("*").length > 45_000) throw tooLarge();
  const paras = doc.getElementsByTagNameNS(ns, "p");
  if (paras.length > 1500) throw tooLarge();
  let length = 0;
  const result: Passage[] = [];
  for (let i = 0; i < paras.length; i++) {
    const text = Array.from(paras[i].getElementsByTagNameNS(ns, "t"), t => t.textContent ?? "").join("").trim();
    if ((length += text.length + 1) > maxText) throw tooLarge();
    if (text) result.push({ location: `Paragraph ${i + 1}`, text });
  }
  return result;
}

function plain(bytes: Uint8Array): Passage[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.length > maxText) throw tooLarge();
  if (/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) throw unsupported();
  const lines = text.split(/\r\n?|\n/), result: Passage[] = [];
  for (let i = 0; i < lines.length; ) {
    const start = i;
    let size = 0;
    do { size += lines[i++].length + 1; } while (i < lines.length && size < 4000 && i - start < 50);
    const text = lines.slice(start, i).join("\n").trim();
    if (text) result.push({ location: i === start + 1 ? `Line ${i}` : `Lines ${start + 1}–${i}`, text });
  }
  return result;
}

export async function readDocument(file: File, signal: AbortSignal): Promise<Passage[]> {
  if (!file.size || file.size > maxBytes) throw tooLarge();
  const ext = file.name.split(".").pop()?.toLowerCase();
  if (!ext || !["pdf", "docx", "txt", "md", "csv"].includes(ext)) throw unsupported();
  const bytes = new Uint8Array(await file.arrayBuffer());
  signal.throwIfAborted();
  const result = ext === "pdf" ? await pdf(bytes, signal) : ext === "docx" ? docx(bytes) : plain(bytes);
  if (!result.length) throw unsupported();
  return result;
}
