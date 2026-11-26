import { api, values, type Act, type Mock, type Workspace } from "./client";

export function Round({ mock, data, act, busy }: { mock: Mock; data: Workspace; act: Act; busy: boolean }) {
  const { probes } = data;
  const index = mock.answers.length;
  const report = mock.report;
  const submit = (path: string, body: unknown) => act(() => api(`mocks/${mock.id}/${path}`, "POST", body));
  return <>
    <a href="#workspace">Back to workspace</a>
    <p className="eyebrow">Hiring-manager practice / {mock.rubric} / {mock.tailored ? "locally tailored questions" : "standard questions"}</p>
    <h1>{report ? "Your debrief" : "Practice round"}</h1>
    <p className="target">{mock.target}</p>
    {!report && index < probes.length && <section>
      <p className="eyebrow">Question {index + 1} of {probes.length} / {probes[index].name}</p>
      <h2>{mock.questions[index]}</h2>
      <form key={index} onSubmit={e => { e.preventDefault(); void submit("answers", { index, ...values(e.currentTarget) }); }}>
        <label>Your answer<textarea name="text" required maxLength={3000} rows={5} /></label>
        <button disabled={busy}>Save answer</button>
      </form>
      <p className="muted">Submitted answers are saved. You can leave between questions and resume; an unfinished round has no grade.</p>
    </section>}
    {!report && index === probes.length && <section>
      <h2>Assess the transcript</h2>
      <p>Only these four answers count. Impact must reach 3/4 and the total must reach 75/100 for a simulated hire.</p>
      {data.localCoachEnabled && <div className="callout"><p>The local model will receive the role and four answers, not your experience library. No cloud model is configured.</p>
        <button disabled={busy} onClick={() => void submit("report", { assessor: "local" })}>Ask the local coach</button></div>}
      <h3>Self-assessment</h3>
      <p>No model needed. Rate the evidence you actually gave: 0 = none, 1 = claim only, 2 = partial, 3 = meets the anchor, 4 = unusually strong.</p>
      <form onSubmit={e => {
        e.preventDefault(); const ratings = values(e.currentTarget);
        void submit("report", { assessor: "self", points: probes.map(p => Number(ratings[p.name])) });
      }}>
        {probes.map((p, i) => <div className="item" key={p.name}>
          <h3>{p.name}</h3><p>{mock.questions[i]}</p><blockquote>{mock.answers[i]}</blockquote>
          <p>{p.anchor}</p>
          <label>{p.name} rating<select name={p.name} required defaultValue="">
            <option disabled value="">Choose points</option>
            {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n} / 4</option>)}
          </select></label>
        </div>)}
        <button disabled={busy}>Save self-assessment</button>
      </form>
    </section>}
    {report && <>
      <section><p className="eyebrow">{report.assessor === "self" ? "Self-assessed / not an AI evaluation" : "Local model assessment / not calibrated"}</p>
        <h2>{report.score}/100 ({report.grade}) &middot; {report.verdict}</h2>
        <p>A practice decision, not an employer prediction. The pass line is 75 and impact must be at least 3/4.</p>
        {report.marks.map((m, i) => <div className="item" key={probes[i].name}>
          <h3>{probes[i].name}: {m.points}/4</h3><blockquote>{m.quote}</blockquote><p>{m.feedback}</p>
        </div>)}
      </section>
      <section><h2>Examples for next time</h2>
        <p>These are your confirmed statements to consider, not evidence used to raise this grade.</p>
        {data.facts.some(f => f.confirmed) ? <ul>{data.facts.filter(f => f.confirmed).map(f =>
          <li key={f.id}><strong>{f.project}:</strong> {f.claim}</li>)}</ul> : <p>No confirmed examples yet. Add one in My experience.</p>}
      </section>
      <section><p className="eyebrow">Ungraded drill / {probes[report.retryIndex].name}</p><h2>Retry one answer</h2>
        <p>{probes[report.retryIndex].drill}</p><p>Original answer:</p><blockquote>{mock.answers[report.retryIndex]}</blockquote>
        {mock.retry ? <><h3>Saved retry</h3><blockquote>{mock.retry}</blockquote></> :
          <form onSubmit={e => { e.preventDefault(); void submit("retry", values(e.currentTarget)); }}>
            <label>Your revised answer<textarea name="text" required maxLength={3000} rows={4} /></label>
            <button disabled={busy}>Save ungraded retry</button>
          </form>}
        <p className="muted">The original transcript and verdict do not change.</p>
      </section>
    </>}
  </>;
}
