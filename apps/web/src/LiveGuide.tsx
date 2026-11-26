import { useEffect, useRef, useState } from "react";
import { api, type Act, type Workspace } from "./client";
import { TargetPicker, type Target } from "./Preparation";
import { deviceRecognition } from "./Voice";

const generic = { Impact:"What changed as a result?", Ownership:"Separate your contribution from the team's.",
  Judgment:"Name the trade-off you considered.", Clarity:"Start with the situation." };
type Topic = keyof typeof generic;
type Choice = { topic:Topic; factId:string; label:string };
type Card = { id:string; topic:Topic; line:string };
const blank = ():Choice => ({topic:"Impact",factId:"",label:""});
const line = (x:Choice) => x.factId ? `Mention ${x.label.trim()}.` : generic[x.topic];

export function LiveGuideView({ data,act,busy }: {data:Workspace;act:Act;busy:boolean}) {
  const [targets,setTargets] = useState<Target[]>([]), [id,select] = useState(""), [err,setErr] = useState("");
  useEffect(() => { api<Target[]>("targets").then(t => {setTargets(t); select(t[0]?.id ?? "");}).catch(e => setErr(e.message)); },[]);
  return <><p className="eyebrow">Optional notes / no interview answers</p><h1>Live reminders</h1>
    {err && <p role="alert">{err}</p>}{!targets.length ? <p><a href="#workspace/prep">Create an interview target</a> to prepare its cue cards.</p> :
    <><TargetPicker targets={targets} id={id} select={select} />{id && <Deck key={id} id={id} data={data} act={act} busy={busy} />}</>}</>;
}

function Deck({id,data,act,busy}:{id:string;data:Workspace;act:Act;busy:boolean}) {
  const path = `targets/${id}/deck`;
  const [cards,setCards] = useState<Card[]>([]), [choices,setChoices] = useState<Choice[]>([blank()]);
  const [ready,setReady] = useState(false), [permitted,setPermitted] = useState(false), [live,setLive] = useState(false), [err,setErr] = useState("");
  const [generation,setGeneration] = useState(0);
  const reload = async () => { const result = await api<Card[]>(path); setCards(result); return result; };
  useEffect(() => { reload().catch(e => setErr(e.message)); },[path]);
  const change = (list:Choice[]) => {setChoices(list); setReady(false);};
  if (live) return <LiveSession key={generation} path={path} onEnd={() => { setLive(false); setPermitted(false); setCards([]); void reload().catch(e => setErr(e.message)); }} />;
  return <><section><h2>Prepare and approve cards</h2><p>Choose up to five short reminders. Only explicitly permitted, confirmed facts are available. No private source text is displayed during the interview.</p>
    {err && <p role="alert">{err}</p>}{choices.map((x,i) => <div className="item" key={i}><label>Topic {i+1}<select value={x.topic} onChange={e => change(choices.map((v,j) => j === i ? {...v,topic:e.target.value as Topic} : v))}>
      {Object.keys(generic).map(t => <option key={t}>{t}</option>)}</select></label>
      <label>Example<select value={x.factId} onChange={e => change(choices.map((v,j) => j === i ? {...v,factId:e.target.value,label:""} : v))}>
        <option value="">Generic prompt</option>{data.facts.filter(f => f.confirmed && f.allowLive).map(f => <option value={f.id} key={f.id}>{f.project}: {f.claim}</option>)}</select></label>
      {x.factId && <label>Non-confidential project label (up to six words)<input maxLength={65} value={x.label} onChange={e => change(choices.map((v,j) => j === i ? {...v,label:e.target.value} : v))} /></label>}
      <strong>{line(x)}</strong><div className="actions"><button type="button" className="quiet" disabled={i===0} onClick={() => {
        const next=[...choices]; [next[i-1],next[i]]=[next[i],next[i-1]]; change(next);}}>Move up</button>
        <button type="button" className="quiet" onClick={() => change(choices.filter((_,j) => j!==i))}>Remove card</button></div>
    </div>)}<button className="quiet" disabled={choices.length>=5} onClick={() => change([...choices,blank()])}>Add cue</button>
    <label><input type="checkbox" checked={ready} onChange={e=>setReady(e.target.checked)} /> I approve these exact cards as the replacement deck.</label>
    <button disabled={busy || !ready} onClick={() => void act(async () => {
      await api(path,"POST",{approved:true,cards:choices.map(c => ({...c,factId:c.factId||null}))}); await reload();setReady(false);
    })}>Save approved deck</button></section>
    <section><h2>Approved deck</h2>{cards.length ? <ol>{cards.map(c => <li key={c.id}><b>{c.line}</b></li>)}</ol> : <p>No currently valid cards.</p>}
      <label><input type="checkbox" checked={permitted} onChange={e=>setPermitted(e.target.checked)} /> Notes and this guide are permitted for this interview.</label>
      <button disabled={!permitted || !cards.length} onClick={() => {setGeneration(generation+1);setLive(true);}}>Open manual guide</button>
      <p className="muted">Manual mode never requests a microphone. No transcript, score or memory update will be created.</p></section></>;
}

function LiveSession({path,onEnd}:{path:string;onEnd:()=>void}) {
  const [cards,setCards]=useState<Card[]>([]), [covered,setCovered]=useState<string[]>([]), [selected,select]=useState("");
  const [paused,pause]=useState(false), [consent,setConsent]=useState(false), [listening,setListening]=useState(false), [msg,setMsg]=useState("");
  const stop=useRef<(() => void)|null>(null), generation=useRef(0), last=useRef(0);
  const available=cards.filter(c=>!covered.includes(c.id)), current=available.find(c=>c.id===selected)??available[0];
  const options=useRef<Card[]>([]); options.current=available;
  function silence(){ generation.current++; stop.current?.(); stop.current=null; setListening(false); }
  useEffect(()=>{
    let alive=true, seq=0;
    async function check(){
      const version=++seq;
      try { const valid=await api<Card[]>(path); if(alive && seq===version) setCards(valid); }
      catch { if(alive && seq===version){ setCards([]);silence();setMsg("Deck could not be verified. No reminders displayed."); } }
    }
    void check(); const timer=setInterval(()=>void check(),5000);
    const channel=typeof BroadcastChannel!=="undefined"?new BroadcastChannel("practice-library"):null;
    if(channel) channel.onmessage=()=>{setCards([]);void check();};
    const focus=()=>{setCards([]);void check();};
    const hidden=()=>{if(document.hidden){silence();setConsent(false);pause(true);}};
    window.addEventListener("focus",focus);document.addEventListener("visibilitychange",hidden);
    return ()=>{alive=false;generation.current++;stop.current?.();clearInterval(timer);channel?.close();window.removeEventListener("focus",focus);document.removeEventListener("visibilitychange",hidden);};
  },[path]);
  async function listen(){
    const mine=++generation.current;
    try {
      const r=await deviceRecognition();
      if(mine!==generation.current)return;
      if(!r){setMsg("No verified on-device English recognizer. Manual cards remain available.");return;}
      r.continuous=true; r.onend=()=>{if(mine===generation.current)setListening(false);};
      r.onerror=()=>{if(mine===generation.current){silence();setMsg("On-device listening stopped.");}};
      r.onresult=e=>{
        if(mine!==generation.current || Date.now()-last.current<30000)return;
        const hit=e.results[e.resultIndex]; if(!hit?.isFinal || hit[0].confidence<0.65)return;
        // Transient matching only: no transcript state, logging, speech server or model call.
        const s=hit[0].transcript;
        const topic=/result|outcome|measure|impact/i.test(s)?"Impact":/own|responsib|your role/i.test(s)?"Ownership":
          /decision|trade.off|alternative/i.test(s)?"Judgment":/summari|explain|situation/i.test(s)?"Clarity":null;
        const card=options.current.find(c=>c.topic===topic); if(card){select(card.id);last.current=Date.now();}
      };
      stop.current=()=>{r.onresult=null;r.onend=null;r.onerror=null;r.abort();}; r.start();setListening(true);setMsg("");
    } catch {if(mine===generation.current){silence();setMsg("On-device listening is not available.");}}
  }
  return <section><p className="eyebrow">{paused?"Paused":listening?"Listening on this device":"Manual / microphone off"}</p>
    <p className="live-cue" aria-live="polite"><strong>{paused?"Paused":current?.line??"No remaining cue."}</strong></p>
    <div className="actions"><button disabled={paused||!current} onClick={()=>{setCovered([...covered,current.id]);last.current=Date.now();}}>Covered</button>
      <button className="quiet" disabled={paused||available.length<2} onClick={()=>{select(available[(available.indexOf(current)+1)%available.length].id);last.current=Date.now();}}>Later</button>
      <button className="quiet" onClick={()=>{silence();setConsent(false);pause(!paused);}}>{paused?"Resume":"Pause"}</button>
      <button className="quiet" onClick={()=>{silence();onEnd();}}>End guide</button></div>
    {!paused && <><label>Choose an approved topic<select value={current?.id??""} onChange={e=>{select(e.target.value);last.current=Date.now();}}>
      {available.map(c=><option key={c.id} value={c.id}>{c.topic}</option>)}</select></label>
      <details><summary>Optional on-device topic selection</summary><label><input type="checkbox" checked={consent} onChange={e=>{
        setConsent(e.target.checked);if(!e.target.checked)silence();}} /> The interview permits listening and everyone audible has agreed for this session.</label>
        <button className="quiet" disabled={!consent} onClick={()=>listening?silence():void listen()}>{listening?"Stop listening":"Enable on-device selection"}</button></details></>}
    {msg&&<p role="status">{msg}</p>}</section>;
}
