// Run against the actual public route, not the controller's view of the desired template.
export async function smoke(origin, commit) {
  const get = (path, options) => fetch(origin + path, {
    redirect: 'manual', signal: AbortSignal.timeout(15_000), ...options
  });
  const require = (condition, check) => { if (!condition) throw new Error(`Demo smoke failed: ${check}`); };
  const health = await (await get('/healthz')).json();
  require(health.status === 'ok' && health.mode === 'public-demo' && health.version?.endsWith('+' + commit), 'serving commit');
  const ready = await get('/readyz');
  require(ready.ok && (await ready.json()).status === 'ready', 'readiness');
  const home = await get('/');
  const demo = await get('/demo');
  const html = await demo.text();
  require(home.status === 302 && home.headers.get('location') === '/demo' && demo.ok &&
    html.includes('/assets/app.js') && html.includes('/assets/app.css') &&
    demo.headers.get('content-security-policy')?.includes("connect-src 'none'"), 'browser-only landing');
  for (const asset of ['app.js', 'app.css']) {
    const res = await get(`/assets/${asset}`, { method: 'HEAD' });
    require(res.ok && Number(res.headers.get('content-length')) > 0, 'compiled assets');
  }
  for (const [method, path] of [['GET', '/api/workspace'], ['POST', '/api/workspace'], ['POST', '/api/discovery/run'],
    ['POST', '/api/account/login'], ['POST', '/api/billing/webhook']]) {
    const res = await get(path, { method, headers: { 'X-Practice-Request': '1' } });
    require(res.status === 401 && !res.headers.has('set-cookie'), 'private APIs locked');
  }
  return ['serving commit', 'readiness', 'browser-only landing', 'compiled assets', 'private APIs locked'];
}
