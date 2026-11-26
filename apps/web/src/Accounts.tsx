import { useEffect, useState } from "react";
import { api, type Act, type Workspace } from "./client";

type Configuration = { enabled: boolean; webApiKey: string | null; localWorkspace: boolean };
type Account = { signedIn: boolean; tier: string; email?: string; billingStatus?: string; paused?: boolean;
  periodStart?: number; periodEnd?: number; checkoutEnabled: boolean; portalEnabled: boolean;
  usage: { meter: string; used: number; limit: number }[] };

function signInCode() {
  let url = new URL(window.location.href);
  // Firebase Hosting links may wrap the action URL. Never navigate to that URL or use its API key.
  for (let i = 0; i < 3; i++) {
    const code = url.searchParams.get("oobCode");
    if (url.searchParams.get("mode") === "signIn" && code && code.length <= 2048) return code;
    const link = url.searchParams.get("link");
    if (!link) break;
    try { url = new URL(link); } catch { break; }
  }
  return null;
}

export function LandingAccount({ onSignedIn = () => { location.hash = "workspace"; } }: { onSignedIn?: () => void } = {}) {
  const [config, setConfig] = useState<Configuration | null>(null);
  const [email, setEmail] = useState(""), [code, setCode] = useState(signInCode);
  const [message, setMessage] = useState(""), [error, setError] = useState(""), [working, setWorking] = useState(false);
  useEffect(() => {
    let current = true;
    api<Configuration>("account/config").then(x => { if (current) setConfig(x); })
      .catch(() => { if (current) setError("Account sign-in is unavailable."); });
    return () => { current = false; };
  }, []);
  useEffect(() => {
    if (code) history.replaceState(history.state, "", location.pathname + location.hash);
  }, [code]);
  return <section><h2>Private account</h2>
    {error && <p role="alert">{error}</p>}
    {!config ? <p>Checking sign-in availability…</p> : !config.enabled ?
      <p>Managed sign-in is not configured on this installation. The fictional sample needs no account or payment.</p> :
      <><p>Use a verified email link for a Free account. No password, card or automatic upgrade.
        Your account is separate from any local workspace; signing in does not copy its records.</p>
        <form onSubmit={async e => {
          e.preventDefault(); if (working || !config.webApiKey) return;
          setWorking(true); setMessage(""); setError("");
          try {
            const action = code ? "signInWithEmailLink" : "sendOobCode";
            const body = code ? { email: email.trim(), oobCode: code } :
              { email: email.trim(), requestType: "EMAIL_SIGNIN", continueUrl: location.origin + location.pathname, canHandleCodeInApp: true };
            const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:${action}?key=${encodeURIComponent(config.webApiKey)}`, {
              method: "POST", cache: "no-store", credentials: "omit", redirect: "error", referrerPolicy: "origin",
              headers: { "Content-Type": "application/json" }, body: JSON.stringify(body)
            });
            if (!response.ok) throw new Error(code ? "The link is invalid, expired, or for another email. Request a new link." :
              "The sign-in email could not be sent. Check the address and try again later.");
            if (code) {
              const result: { idToken?: string } = await response.json();
              if (!result.idToken) throw new Error("The provider did not return a verified sign-in.");
              await api("account/login", "POST", { idToken: result.idToken });
              setCode(null); setEmail(""); onSignedIn();
            } else setMessage("Check your inbox and open the link. Enter the same email address to finish signing in.");
          } catch (err) { setError(err instanceof Error ? err.message : "Sign-in failed."); }
          finally { setWorking(false); }
        }}>
          <label>{code ? "Email address that received this link" : "Email address"}<input type="email" autoComplete="email"
            value={email} onChange={e => setEmail(e.target.value)} maxLength={320} required /></label>
          <div className="actions"><button disabled={working}>{working ? "Please wait…" : code ? "Finish verified sign-in" : "Email me a sign-in link"}</button>
            {code && <button className="quiet" type="button" disabled={working} onClick={() => { setCode(null); setError(""); }}>Use a new link</button>}</div>
        </form>
        {message && <p role="status">{message}</p>}
      </>}
  </section>;
}

const labels: Record<string, string> = { mocks: "Mock starts (includes debrief and retry)", imports: "Evidence imports",
  builds: "Experience and planning sessions", drafts: "Tailored resume and letter pairs", voiceSeconds: "Active voice minutes" };
const day = (unix: number) => new Date(unix * 1000).toLocaleDateString();
const quantity = (meter: string, units: number) => meter === "voiceSeconds" ? (units / 60).toLocaleString(undefined, { maximumFractionDigits: 1 }) : units;

export function Accounts({ data, act, busy }: { data: Workspace; act: Act; busy: boolean }) {
  const [account, setAccount] = useState<Account | null>(null), [error, setError] = useState("");
  useEffect(() => {
    let current = true;
    api<Account>("account").then(x => { if (current) { setAccount(x); setError(""); } })
      .catch(() => { if (current) setError("Account usage could not be loaded. Reload to retry."); });
    return () => { current = false; };
  }, [data]);
  const redirect = (path: "checkout" | "portal") => void act(async () => {
    const { url } = await api<{ url: string }>(`billing/${path}`, "POST");
    const to = new URL(url), host = path === "checkout" ? "checkout.stripe.com" : "billing.stripe.com";
    if (to.origin !== `https://${host}` || to.username || to.password) throw new Error("Unexpected Stripe destination.");
    location.assign(to.href);
  });
  return <section><h2>Account and usage</h2>
    {error && <p role="alert">{error}</p>}
    {!account ? <p>Loading account…</p> : <>
      <h3>{account.tier}</h3>
      {!account.signedIn ? <p>This is a local development workspace, not a verified Free or paid account.
        There is no billing or subscription, and local practice is not metered. <a href="#">Return home for sign-in options.</a></p> :
        <><p>Signed in as {account.email}. {account.periodStart && account.periodEnd ?
          `Test billing period: ${day(account.periodStart)} to ${day(account.periodEnd)}. No rollover.` :
          "Free starter allowances are granted once per account, not every month."}</p>
          <ul>{account.usage.map(m => <li key={m.meter}><strong>{quantity(m.meter, Math.max(0, m.limit - m.used))} of {quantity(m.meter, m.limit)}</strong> {labels[m.meter]} remaining</li>)}</ul>
          {account.paused && <p role="status">New generation is paused while billing is resolved. You can still read existing work.</p>}
          {account.billingStatus !== "none" && <p>Test subscription status: {account.billingStatus?.replaceAll("_", " ")}.</p>}
          {account.tier === "Free" && <p>The Prep test plan adds scheduled scouting and period allowances: 8 mock starts,
            40 evidence imports, 100 builder turns, 31 tailored pairs and 120 active minutes with a configured speech service.</p>}
          <p>The live Prep price has not been set. Live checkout is closed. No auto-conversion or overage charges.</p>
          <div className="actions">
            {account.checkoutEnabled && <button disabled={busy} onClick={() => redirect("checkout")}>Try Stripe test checkout (no real payment)</button>}
            {account.portalEnabled && <button className="quiet" disabled={busy} onClick={() => redirect("portal")}>Manage test billing in Stripe</button>}
            <button className="quiet" disabled={busy} onClick={() => void act(async () => { await api("account/logout", "POST"); location.hash = ""; })}>Sign out</button>
          </div>
          <p>For billing or deletion, use a fresh sign-in link. Deleting your workspace removes this app’s account data and cancels its test renewals; the managed sign-in identity is separate.</p>
        </>}
    </>}
  </section>;
}
