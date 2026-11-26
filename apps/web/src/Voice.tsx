import { useEffect, useId, useRef, useState } from "react";
import { api } from "./client";

type Recognition = {
  processLocally: boolean; lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string; confidence: number } }> }) => void) | null;
  onend: (() => void) | null; onerror: (() => void) | null; start(): void; abort(): void; stop(): void;
};
type Recognizer = { new(): Recognition; available?: (options: { langs: string[]; processLocally: boolean }) => Promise<string> };

export async function deviceRecognition() {
  const scope = window as unknown as { SpeechRecognition?: Recognizer; webkitSpeechRecognition?: Recognizer };
  const Engine = scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
  if (!Engine?.available || !("processLocally" in Engine.prototype) ||
    await Engine.available({ langs: ["en-US"], processLocally: true }) !== "available") return null;
  const r = new Engine(); r.processLocally = true; r.lang = "en-US"; r.interimResults = false;
  return r.processLocally === true ? r : null;
}

function wave(samples: Float32Array[]) {
  const count = samples.reduce((n, s) => n + s.length, 0);
  const raw = new ArrayBuffer(44 + 2 * count), v = new DataView(raw);
  function tag(at: number, text: string) { for (let i = 0; i < text.length; i++) v.setUint8(at + i, text.charCodeAt(i)); }
  tag(0, "RIFF"); v.setUint32(4, 36 + 2 * count, true); tag(8, "WAVEfmt "); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, 16000, true); v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true); tag(36, "data"); v.setUint32(40, 2 * count, true);
  let at = 44;
  for (const chunk of samples) for (const n of chunk) { v.setInt16(at, Math.max(-1, Math.min(n, 1)) * (n < 0 ? 32768 : 32767), true); at += 2; }
  return new Blob([raw], { type: "audio/wav" });
}

export function VoiceInput({ value, onChange, label, maxLength, prompt, name, required, compact }: {
  value: string; onChange: (text: string) => void; label: string; maxLength: number; prompt?: string; name?: string; required?: boolean; compact?: boolean;
}) {
  const inputId = useId();
  const [active, setActive] = useState(false), [note, setNote] = useState("");
  const [fallback, allowFallback] = useState(false), [showFallback, setShowFallback] = useState(false), [transcribing, setTranscribing] = useState(false);
  const stop = useRef<((submit: boolean) => void) | null>(null);
  const current = useRef(value), changed = useRef(onChange), lifetime = useRef<AbortController | null>(null);
  current.current = value; changed.current = onChange;
  function cancel() { lifetime.current?.abort(); stop.current?.(false); setActive(false); setTranscribing(false); }
  useEffect(() => {
    const hidden = () => { if(document.hidden){cancel();window.speechSynthesis?.cancel();setNote("Microphone off.");} };
    document.addEventListener("visibilitychange",hidden);
    return () => { document.removeEventListener("visibilitychange",hidden); lifetime.current?.abort(); stop.current?.(false); window.speechSynthesis?.cancel(); };
  }, []);
  const append = (text: string) => {
    const next = [current.current.trim(), text.trim()].filter(Boolean).join(" ").slice(0, maxLength);
    current.current = next; changed.current(next);
  };
  async function begin() {
    if (active) return;
    const life = new AbortController(); lifetime.current = life; setActive(true); setNote("Checking local voice support...");
    stop.current = () => { life.abort(); setActive(false); };
    try {
      window.speechSynthesis?.cancel();
      const r = await deviceRecognition().catch(() => null);
      if (life.signal.aborted) return;
      if (r) {
        r.continuous = false;
        const timer = window.setTimeout(() => r.stop(), 45000);
        r.onresult = e => { if (!life.signal.aborted) for (let i = e.resultIndex; i < e.results.length; i++) if (e.results[i].isFinal) append(e.results[i][0].transcript); };
        r.onend = () => { clearTimeout(timer); if (!life.signal.aborted) { setActive(false); setNote("Microphone off. Review and edit your caption before submitting."); } };
        r.onerror = () => { if (!life.signal.aborted) setNote("On-device dictation unavailable. Type your answer instead."); };
        stop.current = submit => { clearTimeout(timer); if (submit) r.stop(); else { life.abort(); r.abort(); } };
        try { r.start(); } catch (e) { clearTimeout(timer); throw e; }
        setNote("Listening on this device. Stop to review your caption."); return;
      }
      if (!(await api<{ localTranscriber: boolean }>("speech")).localTranscriber) throw Error("No on-device English speech pack or local whisper.cpp server is available. Type instead.");
      if (life.signal.aborted) return;
      if (!fallback) {
        setShowFallback(true);setActive(false);setNote("On-device recognition is unavailable. Enable the local practice transcriber below before recording, or keep typing.");return;
      }
      const media = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (life.signal.aborted) { media.getTracks().forEach(t => t.stop()); return; }
      let ctx: AudioContext;
      try { ctx = new AudioContext({ sampleRate: 16000 }); } catch (e) { media.getTracks().forEach(t => t.stop()); throw e; }
      let source: MediaStreamAudioSourceNode, processor: ScriptProcessorNode, mute: GainNode;
      try {
        source = ctx.createMediaStreamSource(media); processor = ctx.createScriptProcessor(4096, 1, 1);
        mute = ctx.createGain(); mute.gain.value = 0;
      } catch(e) { media.getTracks().forEach(t => t.stop()); void ctx.close(); throw e; }
      const chunks: Float32Array[] = []; let count = 0, finished = false;
      const finish = async (submit: boolean) => {
        if (finished) return; finished = true; clearTimeout(timer);
        processor.onaudioprocess = null; processor.disconnect(); source.disconnect(); mute.disconnect(); media.getTracks().forEach(t => t.stop()); void ctx.close();
        const clear = () => { for (const piece of chunks) piece.fill(0); chunks.length = 0; };
        if (!submit || life.signal.aborted) { clear(); return; }
        try {
          setTranscribing(true);setNote("Microphone off. Transcribing on this computer...");
          const body = wave(chunks); clear();
          const response = await fetch("/api/speech/transcribe", { method: "POST", headers: { "Content-Type": "audio/wav", "X-Practice-Request": "1" },
            body, signal: life.signal });
          if (!response.ok) throw Error("Local transcription failed. Your existing text is unchanged.");
          const result = await response.json(); if (!life.signal.aborted) { append(result.text); setNote("Review the caption before submitting."); }
        } catch (e) { if (!life.signal.aborted) setNote(String(e)); }
        finally { clear(); if (!life.signal.aborted) {setActive(false);setTranscribing(false);} }
      };
      const timer = window.setTimeout(() => void finish(true), 45000);
      stop.current = submit => { void finish(submit); };
      processor.onaudioprocess = e => {
        const piece = e.inputBuffer.getChannelData(0).slice(0, Math.max(0, 720000 - count)); chunks.push(piece); count += piece.length;
        if (count >= 720000) void finish(true);
      };
      try { source.connect(processor); processor.connect(mute); mute.connect(ctx.destination); } catch(e) { await finish(false); throw e; }
      setNote("Listening for up to 45 seconds. Audio goes only to the configured transcriber on this computer.");
    } catch (e) { if (!life.signal.aborted) { setNote(e instanceof Error ? e.message : "Voice unavailable. Type instead."); setActive(false); } }
  }
  function speak() {
    const synth = window.speechSynthesis, voice = synth?.getVoices().find(v => v.localService && v.lang.startsWith("en"));
    if (!voice || !prompt) { setNote("No local English reading voice is available."); return; }
    synth.cancel(); const utterance = new SpeechSynthesisUtterance(prompt); utterance.voice = voice; synth.speak(utterance);
  }
  const voice = <>{showFallback && <label><input type="checkbox" checked={fallback} onChange={e=>{allowFallback(e.target.checked);if(!e.target.checked)cancel();}}/>
      Allow up to 45 seconds of practice audio per turn to the configured speech server on this computer. Audio is not saved by the studio.</label>}
    <div className="actions"><button className="quiet" type="button" onClick={() => transcribing ? cancel() : active ? stop.current?.(true) : void begin()}>{transcribing ? "Cancel transcription" : active ? "Stop microphone" : "Dictate locally"}</button>
      {prompt && <><button type="button" className="quiet" disabled={active} onClick={speak}>Read prompt aloud</button>
        <button type="button" className="quiet" onClick={() => window.speechSynthesis?.cancel()}>Stop reading</button></>}</div>
    <small role="status">{note || "Microphone off. Dictation uses an installed on-device recognizer, never cloud recognition. Review the caption before sending."}</small>
  </>;
  return <div><label htmlFor={inputId} className={compact ? "sr-only" : undefined}>{label}</label><textarea id={inputId} name={name} rows={compact ? 2 : 4}
    placeholder={compact ? "Message your coach…" : undefined} required={required} maxLength={maxLength} value={value} onChange={e => onChange(e.target.value)} />
    {compact ? <details className="voice-tools"><summary>Voice options</summary>{voice}</details> : voice}</div>;
}
