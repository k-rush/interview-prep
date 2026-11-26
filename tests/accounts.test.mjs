import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHmac, generateKeyPairSync, randomBytes, randomInt, sign } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = join(root, 'apps', 'api', 'InterviewPrep.Api.csproj');
const time = () => Math.floor(Date.now() / 1000);
const projectId = 'fixture-interview';
const secret = 'whsec_' + randomBytes(24).toString('hex');
const priceId = 'price_FixtureOnly';
const publicPrice = { id: priceId, object: 'price', active: true, livemode: false, billing_scheme: 'per_unit',
  type: 'recurring', unit_amount: randomInt(1, 10000), recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' } };
const email = 'candidate@example.invalid';

// Inject transport only into this test executable. The production host keeps its real fixed HTTPS trust endpoints.
const program = `
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;
using InterviewPrep;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Http;
[assembly: HostingStartup(typeof(TransportStartup))]
public static class Fixture {
    public static async Task Main(string[] args) {
        var result = typeof(AccountsModule).Assembly.EntryPoint!.Invoke(null, new object[]{args});
        if (result is Task task) await task;
    }
}
public sealed class TransportStartup : IHostingStartup {
    public void Configure(IWebHostBuilder builder) => builder.ConfigureServices(services =>
        services.AddSingleton<IHttpMessageHandlerBuilderFilter, TransportFilter>());
}
public sealed class TransportFilter : IHttpMessageHandlerBuilderFilter {
    public Action<HttpMessageHandlerBuilder> Configure(Action<HttpMessageHandlerBuilder> next) => b => {
        next(b); b.PrimaryHandler = new FixtureTransport();
    };
}
public sealed class FixtureTransport : DelegatingHandler {
    private static readonly string Certificate = MakeCert();
    private static string MakeCert() {
        using var key = RSA.Create(); key.ImportFromPem(Environment.GetEnvironmentVariable("FIXTURE_PEM"));
        var req = new CertificateRequest("CN=Fixture", key, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        using var cert = req.CreateSelfSigned(DateTimeOffset.UtcNow.AddDays(-1), DateTimeOffset.UtcNow.AddDays(1));
        return cert.ExportCertificatePem();
    }
    public FixtureTransport() : base(new HttpClientHandler { UseProxy = false, AllowAutoRedirect = false }) {}
    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage req, CancellationToken ct) {
        var uri = req.RequestUri!;
        if (uri.AbsoluteUri == "https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com")
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
                Content = JsonContent.Create(new Dictionary<string,string> { ["fixture"] = Certificate }) });
        if (uri.Scheme != "https" || uri.Host is not ("identitytoolkit.googleapis.com" or "api.stripe.com"))
            throw new InvalidOperationException("Unexpected outbound request in offline fixture.");
        req.RequestUri = new Uri("http://127.0.0.1:" + Environment.GetEnvironmentVariable("FIXTURE_PORT") + "/" + uri.Host + uri.PathAndQuery);
        return base.SendAsync(req, ct);
    }
}
`;

async function fixture(t) {
  const scratch = await mkdtemp(join(root, '.accounts-fixture-'));
  const data = join(scratch, 'data');
  await mkdir(data);
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const states = new Map(), customers = new Map(), attempts = new Map(), deleted = [], unexpected = [];
  let lastCustomer, failDelete = false, failSync = false, child, base;
  const remote = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const url = new URL(req.url, 'http://127.0.0.1'), form = new URLSearchParams(body), key = req.headers['idempotency-key'];
    const send = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/identitytoolkit.googleapis.com/v1/accounts:lookup') {
      const claims = JSON.parse(Buffer.from(JSON.parse(body).idToken.split('.')[1], 'base64url'));
      return send(200, { users: [{ localId: claims.sub, emailVerified: true, email: claims.email,
        disabled: claims.sub === 'disabled', validSince: claims.sub === 'revoked' ? `${time() + 100}` : '1' }] });
    }
    if (req.headers['stripe-version'] !== '2024-06-20' || !req.headers.authorization) return send(403, {});
    const path = url.pathname.replace('/api.stripe.com/v1/', '');
    if (path === `prices/${priceId}`) return send(200, publicPrice);
    if (path === 'customers' && req.method === 'POST') {
      if (!customers.has(key)) customers.set(key, `cus_Fixture${customers.size + 1}`);
      lastCustomer = customers.get(key);
      return send(200, { id: lastCustomer, livemode: false });
    }
    if (path === 'subscriptions' && req.method === 'GET')
      return failSync ? send(503, {}) : send(200, { object: 'list', has_more: false, data: states.get(url.searchParams.get('customer')) || [] });
    if (path === 'checkout/sessions' && req.method === 'POST') {
      if (!key || form.get('line_items[0][price]') !== priceId || form.get('customer') !== lastCustomer || form.get('mode') !== 'subscription')
        return send(400, {});
      if (attempts.has(key) && attempts.get(key) !== body) return send(409, {});
      attempts.set(key, body);
      return send(200, { customer: lastCustomer, livemode: false, url: 'https://checkout.stripe.com/c/pay/fixture' });
    }
    if (path === 'billing_portal/sessions' && form.get('customer') === lastCustomer)
      return send(200, { url: 'https://billing.stripe.com/p/session/fixture' });
    if (req.method === 'DELETE' && path === `customers/${lastCustomer}`) {
      if (failDelete) return send(503, {});
      deleted.push(lastCustomer); return send(200, { id: lastCustomer, deleted: true });
    }
    unexpected.push(`${req.method} ${path}`); return send(404, {});
  });
  remote.listen(0, '127.0.0.1'); await once(remote, 'listening');
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, 'exit'); child.kill(); await done;
  }
  t.after(async () => {
    await stop();
    const closed = once(remote, 'close'); remote.close(); remote.closeAllConnections(); await closed;
    await rm(scratch, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
    assert.deepEqual(unexpected, []);
  });
  const csproj = join(scratch, 'AccountsFixture.csproj');
  await writeFile(csproj, `<Project Sdk="Microsoft.NET.Sdk.Web"><PropertyGroup><TargetFramework>net10.0</TargetFramework><ImplicitUsings>enable</ImplicitUsings><Nullable>enable</Nullable></PropertyGroup><ItemGroup><ProjectReference Include="${project.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}" /></ItemGroup></Project>`);
  await writeFile(join(scratch, 'Program.cs'), program);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('INTERVIEW_PREP_') && !k.startsWith('ASPNETCORE_')));
  Object.assign(env, { TEMP: scratch, TMP: scratch, ASPNETCORE_HOSTINGSTARTUPASSEMBLIES: 'AccountsFixture', ASPNETCORE_ENVIRONMENT: 'Testing',
    INTERVIEW_PREP_DATA: data, INTERVIEW_PREP_PORT: '0', INTERVIEW_PREP_PLANE: 'local', FIXTURE_PORT: `${remote.address().port}`,
    FIXTURE_PEM: pair.privateKey, INTERVIEW_PREP_FIREBASE_PROJECT: projectId, INTERVIEW_PREP_FIREBASE_WEB_API_KEY: 'fixture-public-web-key',
    INTERVIEW_PREP_PUBLIC_ORIGIN: 'https://practice.example.invalid', INTERVIEW_PREP_STRIPE_MODE: 'test',
    INTERVIEW_PREP_STRIPE_TEST_SECRET_KEY: 'sk_test_' + randomBytes(16).toString('hex'), INTERVIEW_PREP_STRIPE_TEST_WEBHOOK_SECRET: secret,
    INTERVIEW_PREP_STRIPE_TEST_PRICE_ID: priceId });
  await promisify(execFile)('dotnet', ['build', csproj, '--artifacts-path', join(scratch, 'artifacts'), '--nologo', '-v:q',
    '-p:NuGetAudit=false', '-p:UseAppHost=false'],
    { cwd: scratch, env, timeout: 120000 });
  async function start(extra = {}) {
    await stop();
    child = spawn('dotnet', [join(scratch, 'artifacts', 'bin', 'AccountsFixture', 'debug', 'AccountsFixture.dll')], {
      cwd: scratch, env: { ...env, HTTP_PROXY: `http://127.0.0.1:${remote.address().port}`, HTTPS_PROXY: `http://127.0.0.1:${remote.address().port}`,
        NO_PROXY: 'localhost,127.0.0.1', ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    let logs = '';
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Fixture startup timeout: ${logs.slice(-1200)}`)), 30000);
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Fixture exited ${code}: ${logs.slice(-1600)}`)); });
      child.stderr.on('data', b => { logs += b; });
      child.stdout.on('data', b => {
        logs += b;
        const match = /Now listening on: (http:\/\/127\.0\.0\.1:\d+)/.exec(logs);
        if (match) { clearTimeout(timer); base = match[1]; resolve(); }
        if (logs.length > 8192) logs = logs.slice(-4096);
      });
    });
    assert.equal((await fetch(base + '/healthz')).status, 200);
  }
  const request = (path, cookie, method = 'GET', json, headers = {}) => fetch(`${base}/api/${path}`, { method,
    headers: { 'X-Practice-Request': '1', ...(cookie ? { cookie } : {}), ...(json === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: json === undefined ? undefined : JSON.stringify(json) });
  function token(sub, override = {}) {
    const now = time(), b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
    const input = `${b64({ alg: 'RS256', kid: 'fixture' })}.${b64({ iss: `https://securetoken.google.com/${projectId}`, aud: projectId,
      email, email_verified: true, firebase: { sign_in_provider: 'password' }, exp: now + 3600, iat: now, auth_time: now, sub, ...override })}`;
    return `${input}.${sign('RSA-SHA256', Buffer.from(input), pair.privateKey).toString('base64url')}`;
  }
  async function login(sub, cookie) {
    const res = await request('account/login', cookie, 'POST', { idToken: token(sub) });
    assert.equal(res.status, 204, await res.text());
    const value = res.headers.get('set-cookie');
    assert.match(value, /HttpOnly/i); assert.match(value, /SameSite=Strict/i);
    return value.split(';')[0];
  }
  function state(customer, start, status = 'active') {
    const end = start + 29 * 86400, sub = `sub_${customer}`;
    const invoice = { id: 'in_Fixture', status: 'paid', paid: true, livemode: false, amount_paid: publicPrice.unit_amount,
      customer, subscription: sub, lines: { data: [{ type: 'subscription', price: publicPrice, period: { start, end } }] },
      charge: { id: 'ch_Fixture', livemode: false, customer, paid: true, disputed: false, refunded: false, amount_refunded: 0 } };
    return { id: sub, livemode: false, customer, status, current_period_start: start, current_period_end: end,
      cancel_at_period_end: false, items: { has_more: false, data: [{ price: publicPrice, quantity: 1 }] }, latest_invoice: invoice };
  }
  function webhook(id, type, customer, opts = {}) {
    const stamp = opts.stamp ?? time();
    const body = JSON.stringify({ id: `evt_${id}`, object: 'event', type, livemode: opts.live ?? false, data: { object: { customer,
      status: opts.claimedStatus || 'active', metadata: { tier: 'Prep', workspace: 'ignored' } } } });
    const mac = createHmac('sha256', secret).update(`${stamp}.${body}`).digest('hex');
    return fetch(`${base}/api/billing/webhook`, { method: 'POST', headers: { 'content-type': 'application/json',
      'stripe-signature': `t=${stamp},v1=${mac}` }, body: opts.tampered ? body + ' ' : body });
  }
  await start();
  return { request, login, token, start, webhook, state, states, attempts, deleted, get customer() { return lastCustomer; },
    get url() { return base; }, failDelete: b => { failDelete = b; }, failSync: b => { failSync = b; },
    account: async cookie => (await request('account', cookie)).json() };
}

test('verified account and signed Stripe lifecycle on an isolated loopback host', { timeout: 240000 }, async t => {
  const app = await fixture(t);
  let a, b, anon;
  await t.test('managed subject, current verification, CSRF, and local/account workspace isolation', async () => {
    assert.equal((await (await app.request('account/config')).json()).enabled, true);
    assert.equal((await app.request('account')).status, 401);
    assert.equal((await fetch(`${app.url}/api/account/login`, { method: 'POST',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: app.token('a') }) })).status, 403);
    assert.equal((await app.request('account/login', null, 'POST', { idToken: app.token('a') }, { origin: 'https://other.example.invalid' })).status, 403);
    for (const invalid of [app.token('a', { email_verified: false }), app.token('a', { aud: 'wrong-project' }), app.token('a', { exp: time() - 1 }),
      app.token('a', { auth_time: time() - 3600 }), app.token('disabled'), app.token('revoked'), app.token('a').replace(/[^.]+$/, 'aaaa')])
      assert.equal((await app.request('account/login', null, 'POST', { idToken: invalid, email_verified: true, tier: 'Prep' })).status, 401);
    anon = (await app.request('workspace', null, 'POST')).headers.get('set-cookie').split(';')[0];
    assert.equal((await app.account(anon)).tier, 'Local sandbox');
    assert.equal((await app.request('evidence', anon, 'POST', { project: 'Local only', statement: 'A synthetic fixture.' })).status, 200);
    a = await app.login('candidate-A', anon);
    b = await app.login('candidate-B');
    assert.equal((await app.account(a)).tier, 'Free');
    const state = async cookie => (await app.request('workspace', cookie)).json();
    assert.equal((await state(`${anon}; ${a}`)).facts.length, 0);
    assert.equal((await app.request('evidence', a, 'POST', { project: 'Account A', statement: 'Another synthetic fixture.' })).status, 200);
    assert.equal((await state(b)).facts.length, 0, 'different subjects with the same verified address never merge');
    assert.equal((await state(anon)).facts[0].project, 'Local only');
    assert.equal((await app.request('billing/checkout', anon, 'POST')).status, 401);
    assert.equal((await (await app.request('discovery', a)).json()).scoutAllowed, false);
    const importSource = () => app.request('experience/sources', a, 'POST', { category: 'resume', title: 'Fixture resume', reviewed: true,
      excerpts: [{ location: 'Paragraph one', text: 'I documented a synthetic checklist.' }] });
    assert.deepEqual((await Promise.all([importSource(), importSource(), importSource()])).map(r => r.status).sort(), [200, 200, 429]);
    assert.equal((await app.account(a)).usage.find(x => x.meter === 'imports').used, 2);
  });
  await t.test('starter mock quota is atomic and survives a restart; checkout alone cannot grant Prep', async () => {
    const make = () => app.request('mocks', a, 'POST', { target: 'Fixture role' });
    const concurrent = await Promise.all([make(), make(), make()]);
    assert.deepEqual(concurrent.map(r => r.status).sort(), [200, 429, 429]);
    await app.start();
    assert.equal((await app.account(a)).usage.find(x => x.meter === 'mocks').used, 1);
    assert.equal((await app.request('billing/checkout', a, 'POST', { price: 'price_Forged' })).status, 400);
    assert.equal((await app.request('billing/checkout', a, 'POST')).status, 200);
    assert.equal((await app.request('billing/checkout', a, 'POST')).status, 200);
    assert.equal(app.attempts.size, 1, 'retry reuses the persisted Checkout attempt');
    assert.equal((await app.account(a)).tier, 'Free');
    assert.equal((await app.request('billing/portal', b, 'POST')).status, 409);
  });
  await t.test('webhooks reconcile only the mapped customer and paid configured price; resets follow the invoice period', async () => {
    const customer = app.customer, start = time() - 7200;
    const active = app.state(customer, start);
    app.states.set(customer, [active]);
    for (const options of [{ tampered: true }, { stamp: time() - 600 }, { live: true }])
      assert.equal((await app.webhook('bad', 'invoice.paid', customer, options)).status, 400);
    assert.equal((await app.account(a)).tier, 'Free');
    assert.equal((await app.webhook('other', 'invoice.paid', 'cus_Unmapped')).status, 200);
    assert.equal((await app.account(a)).tier, 'Free');
    assert.equal((await app.webhook('current', 'invoice.payment_failed', customer)).status, 200);
    assert.equal((await app.account(a)).tier, 'Prep (Stripe test)', 'the server rereads Stripe; a stale failure cannot remove a paid period');
    assert.equal((await app.account(b)).tier, 'Free');
    assert.equal((await (await app.request('discovery', a)).json()).scoutAllowed, true);
    assert.equal((await app.request('mocks', a, 'POST', { target: 'Paid fixture' })).status, 200);
    await app.webhook('current', 'invoice.payment_failed', customer);
    await app.webhook('differentDelivery', 'invoice.paid', customer);
    let view = await app.account(a);
    assert.equal(view.usage.find(x => x.meter === 'mocks').used, 1, 'duplicate events never reset usage');
    app.failSync(true);
    assert.equal((await app.webhook('deferred', 'customer.subscription.updated', customer)).status, 200);
    assert.equal((await app.account(a)).paused, true, 'a dirty snapshot cannot admit new work during a provider outage');
    app.failSync(false);
    await app.start();
    for (let i = 0; i < 40 && (await app.account(a)).tier === 'Free'; i++) await new Promise(r => setTimeout(r, 100));
    assert.equal((await app.account(a)).tier, 'Prep (Stripe test)', 'a restart reconciles the durable pending change');
    assert.equal((await app.request('billing/portal', a, 'POST')).status, 200);
    active.cancel_at_period_end = true;
    await app.webhook('cancelAtEnd', 'customer.subscription.updated', customer);
    assert.equal((await app.account(a)).billingStatus, 'canceling');
    const next = app.state(customer, start + 3600);
    app.states.set(customer, [next]);
    await app.webhook('renew', 'invoice.paid', customer);
    view = await app.account(a);
    assert.equal(view.periodStart, start + 3600); assert.equal(view.usage.find(x => x.meter === 'mocks').used, 0);
    next.latest_invoice.paid = false;
    await app.webhook('unpaid', 'invoice.paid', customer);
    assert.equal((await app.account(a)).tier, 'Free', 'a signed invoice event is not proof of a paid invoice');
    next.latest_invoice.paid = true; next.items.data[0].price = { ...publicPrice, id: 'price_Wrong' };
    await app.webhook('wrongprice', 'invoice.paid', customer);
    assert.equal((await app.account(a)).tier, 'Free');
    assert.equal((await app.request('mocks', a, 'POST', { target: 'Cannot reset starter' })).status, 429);
  });
  await t.test('provider failure cannot orphan renewal on deletion, and logout revokes the session', async () => {
    app.failDelete(true);
    assert.equal((await app.request('workspace', a, 'DELETE')).status, 503);
    assert.equal((await app.request('workspace', a)).status, 200);
    app.failDelete(false);
    assert.equal((await app.request('workspace', a, 'DELETE')).status, 204);
    assert.deepEqual(app.deleted, [app.customer]); assert.equal((await app.request('workspace', a)).status, 401);
    assert.equal((await app.request('workspace', anon)).status, 200);
    assert.equal((await app.request('account/logout', b, 'POST')).status, 204);
    assert.equal((await app.request('workspace', b)).status, 401);
    await app.start({ INTERVIEW_PREP_STRIPE_MODE: 'live' });
    b = await app.login('candidate-B');
    assert.equal((await app.request('billing/checkout', b, 'POST')).status, 503, 'live mode is never enabled');
    await app.start({ INTERVIEW_PREP_PLANE: 'production', INTERVIEW_PREP_FIREBASE_PROJECT: '', INTERVIEW_PREP_FIREBASE_WEB_API_KEY: '' });
    const cfg = await (await app.request('account/config')).json();
    assert.equal(cfg.enabled, false); assert.equal(cfg.localWorkspace, false);
    assert.notEqual((await app.request('workspace', null, 'POST')).status, 204, 'unprovisioned hosted mode does not open an unmetered local workspace');
    assert.equal((await app.request('workspace', anon)).status, 401);
  });
});
