import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { smoke } from './smoke.mjs';

const arm = 'https://management.azure.com';
const storage = 'https://storage.azure.com/';
const apiVersion = '?api-version=2024-03-01';

export class Azure {
  constructor(env) {
    this.env = env;
    this.ring = env.RING;
    this.purpose = env.PURPOSE;
    this.origin = `https://${env.APP_NAME}.${env.DEFAULT_DOMAIN}`;
    this.appUrl = arm + env.ENV_ID.replace(/\/managedEnvironments\/[^/]+$/i, `/containerApps/${env.APP_NAME}`) + apiVersion;
    this.current = `rings/${this.ring}/current.json`;
    this.tokens = new Map();
  }
  async token(resource) {
    const cached = this.tokens.get(resource);
    if (cached?.until > Date.now()) return cached.value;
    const url = new URL(this.env.IDENTITY_ENDPOINT);
    url.search = new URLSearchParams({ 'api-version': '2019-08-01', resource, client_id: this.env.CLIENT_ID });
    const res = await fetch(url, { headers: { 'X-IDENTITY-HEADER': this.env.IDENTITY_HEADER }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`Managed identity unavailable (${res.status})`);
    const { access_token, expires_on } = await res.json();
    this.tokens.set(resource, { value: access_token, until: Number(expires_on) * 1000 - 60_000 });
    return access_token;
  }
  async call(url, resource, method, headers, body, allowed = []) {
    const res = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(60_000), body,
      headers: { ...headers, Authorization: `Bearer ${await this.token(resource)}` } });
    if (!res.ok && !allowed.includes(res.status)) throw new Error(`${method} ${new URL(url).pathname} returned ${res.status}`);
    return res;
  }
  blob(ring, key, method, headers, body, allowed) {
    return this.call(`https://${this.env.RECEIPT_STORE}.blob.core.windows.net/${ring}/${key}`, storage, method,
      { 'x-ms-version': '2023-11-03', 'x-ms-date': new Date().toUTCString(), ...headers }, body, allowed);
  }
  async read(ring, key) {
    const res = await this.blob(ring, key, 'GET', {}, undefined, [404]);
    return res.status === 404 ? null : res.json();
  }
  async locked(action) {
    await this.blob(this.ring, this.current, 'PUT', { 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*' }, '{}', [409, 412]);
    const id = randomUUID(), lease = this.current + '?comp=lease';
    const start = Date.now();
    await this.blob(this.ring, lease, 'PUT', { 'x-ms-lease-action': 'acquire', 'x-ms-lease-duration': '60', 'x-ms-proposed-lease-id': id });
    this.lease = id;
    this.leaseUntil = start + 55_000;
    const renew = setInterval(async () => {
      const sent = Date.now();
      try {
        await this.blob(this.ring, lease, 'PUT', { 'x-ms-lease-action': 'renew', 'x-ms-lease-id': id });
        this.leaseUntil = Math.max(this.leaseUntil, sent + 55_000);
      } catch { this.lease = null; }
    }, 20_000);
    try { await action(await this.read(this.ring, this.current)); }
    finally {
      clearInterval(renew);
      await this.blob(this.ring, lease, 'PUT', { 'x-ms-lease-action': 'release', 'x-ms-lease-id': id });
      this.lease = null;
    }
  }
  assertLease() { if (!this.lease || Date.now() >= this.leaseUntil) throw new Error('Lost release lease; reconcile before retrying'); }
  record(receipt) {
    this.assertLease();
    return this.blob(this.ring, this.current, 'PUT', { 'x-ms-blob-type': 'BlockBlob', 'x-ms-lease-id': this.lease }, JSON.stringify(receipt));
  }
  async archive(key, receipt) {
    this.assertLease();
    const res = await this.blob(this.ring, key, 'PUT', { 'x-ms-blob-type': 'BlockBlob', 'If-None-Match': '*' }, JSON.stringify(receipt), [409, 412]);
    if (!res.ok) {
      const saved = await this.read(this.ring, key);
      if (!['ring','profile','commit','digest','status'].every(k => saved?.[k] === receipt[k]))
        throw new Error('Conflicting immutable release history; reconcile before retrying');
    }
  }
  async app() {
    const res = await this.call(this.appUrl, arm + '/', 'GET', {}, undefined, [404]);
    if (res.status === 404) return null;
    const app = await res.json();
    if (app.tags?.profile !== 'public-demo-v1' || app.properties.environmentId.toLowerCase() !== this.env.ENV_ID.toLowerCase())
      throw new Error('Refusing to change an app outside the demo profile');
    return app.properties;
  }
  image(digest) { return `${this.env.ACR_HOST}/interview-prep@${digest}`; }
  async deploy(digest, external = true) {
    const e = this.env;
    await this.app();
    this.assertLease();
    const probe = (type, path) => ({ type, httpGet: { path, port: 5187, httpHeaders: [{ name: 'Host', value: 'localhost' }] },
      periodSeconds: 5, timeoutSeconds: 3, failureThreshold: 10 });
    const spec = { location: e.LOCATION, tags: { profile: 'public-demo-v1', ring: this.ring },
      identity: { type: 'UserAssigned', userAssignedIdentities: { [e.PULL_ID]: {} } },
      properties: { environmentId: e.ENV_ID, workloadProfileName: 'Consumption',
        configuration: { activeRevisionsMode: 'Single', registries: [{ server: e.ACR_HOST, identity: e.PULL_ID }],
          ingress: { external, targetPort: 5187, transport: 'auto', allowInsecure: false } },
        template: { scale: { minReplicas: 0, maxReplicas: 1 }, containers: [{ name: 'studio', image: this.image(digest),
          resources: { cpu: 0.25, memory: '0.5Gi' }, env: [
            { name: 'INTERVIEW_PREP_DEMO_ONLY', value: '1' }, { name: 'INTERVIEW_PREP_PUBLIC_ORIGIN', value: this.origin }
          ], probes: [probe('Startup', '/readyz'), probe('Readiness', '/readyz'), probe('Liveness', '/healthz')] }] } } };
    await this.call(this.appUrl, arm + '/', 'PUT', { 'Content-Type': 'application/json' }, JSON.stringify(spec));
    const end = Date.now() + 240_000;
    do {
      await sleep(4000);
      this.assertLease();
      const app = await this.app();
      if (app?.provisioningState === 'Failed') throw new Error('Container App provisioning failed');
      if (app?.provisioningState === 'Succeeded' && app.template.containers[0].image === this.image(digest) &&
          app.configuration.ingress.external === external && app.latestRevisionName && app.latestReadyRevisionName === app.latestRevisionName) return;
    } while (Date.now() < end);
    throw new Error('Container App readiness timed out');
  }
  async contain() {
    const app = await this.app();
    if (!app) return;
    // Do not require a failed revision to become ready before disabling its public route.
    this.assertLease();
    await this.call(this.appUrl, arm + '/', 'PATCH', { 'Content-Type': 'application/json' },
      JSON.stringify({ properties: { configuration: { ingress: { ...app.configuration.ingress, external: false,
        fqdn: undefined, ipSecurityRestrictions: undefined } } } }));
    for (let i = 0; i < 30; i++) {
      if ((await this.app())?.configuration.ingress.external === false) return;
      await sleep(2000);
    }
    throw new Error('Could not confirm containment');
  }
  async verify(release) {
    const app = await this.app();
    if (!app?.configuration.ingress.external || app.template.containers[0].image !== this.image(release.digest))
      throw new Error('The serving image or ingress is not the expected deployment');
    for (let attempt = 0; ; attempt++) {
      try { return await smoke(this.origin, release.commit); }
      catch (error) { if (attempt >= 3) throw error; await sleep(3000); }
    }
  }
}
