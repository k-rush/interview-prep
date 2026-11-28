import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { open } from 'node:fs/promises';
import { createServer, request } from 'node:http';

const endpoint = '/v1/chat/completions';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const isSha256 = value => typeof value === 'string' && value.length === 64 && !/[^a-f0-9]/.test(value);
export class EvalError extends Error {}
export function check(condition, code) { if (!condition) throw new EvalError(code); }

// Assertion messages, exception strings and provider errors can contain the entire packet.
export function failure(error, fallback = 'evaluation-error') {
  const code = error instanceof EvalError ? error.message : fallback;
  const location = error?.stack?.match(/[/\\]evals[/\\]cases[/\\]([a-z0-9-]+\.mjs:\d+:\d+)\)?(?:\r?\n|$)/i);
  return location ? { code, at: location[1] } : { code };
}

async function bounded(stream, limit) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    check(bytes <= limit, 'body-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function json(text, code) {
  try { return JSON.parse(text); } catch { throw new EvalError(code); }
}

async function readKey(path) {
  if (path === undefined) return null;
  check(path && !/^(?:[/\\]{2}|[a-z]+:\/\/)/i.test(path), 'invalid-model-key-file');
  let file;
  try {
    file = await open(path, 'r');
    const stat = await file.stat();
    check(stat.isFile() && stat.size <= 4096, 'invalid-model-key-file');
    const key = (await file.readFile('utf8')).trim();
    check(/^[\x21-\x7e]{1,4096}$/.test(key), 'invalid-model-key-file');
    return key;
  } catch { throw new EvalError('invalid-model-key-file'); }
  finally { await file?.close(); }
}

export async function modelAdapter(lane, env = process.env) {
  if (lane === 'replay') return { model: { provider: 'replay-fixture', id: 'replay' } };
  check(lane === 'live', 'invalid-lane');
  const raw = env.INTERVIEW_PREP_MODEL_PORT, id = env.INTERVIEW_PREP_MODEL_ID;
  const revision = env.INTERVIEW_PREP_EVAL_MODEL_REVISION;
  check(typeof raw === 'string' && /^[1-9]\d{0,4}$/.test(raw) && Number(raw) <= 65535, 'live-requires-local-model-port');
  check(typeof id === 'string' && /^[a-z0-9][a-z0-9._:/-]{0,127}$/i.test(id), 'live-requires-model-id');
  check(revision === undefined || isSha256(revision), 'invalid-model-revision');
  const key = await readKey(env.INTERVIEW_PREP_MODEL_KEY_FILE);
  check(!key || !id.includes(key), 'invalid-model-id');
  check(!key || !revision?.includes(key), 'invalid-model-revision');
  const port = Number(raw);
  return { model: { provider: 'loopback-openai-compatible', id, port, ...(revision ? { revision } : {}) }, async complete(body, signal) {
    // Numeric loopback, fixed route, no proxy/dispatcher, redirects, cookies or caller headers.
    const res = await new Promise((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: endpoint, method: 'POST', agent: false, signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) } }, resolve);
      req.on('error', () => reject(new EvalError('model-unavailable')));
      req.end(JSON.stringify(body));
    });
    try {
      check(res.statusCode === 200, `model-http-${res.statusCode}`);
      check(res.headers['content-type']?.split(';')[0].trim() === 'application/json', 'invalid-model-envelope');
      const envelope = json(await bounded(res, 65536), 'invalid-model-envelope');
      check(envelope?.model === undefined || envelope.model === id, 'provider-model-mismatch');
      const choice = envelope?.choices?.[0], content = choice?.message?.content;
      check(envelope?.choices?.length === 1 && (!choice.finish_reason || choice.finish_reason === 'stop') &&
        typeof content === 'string' && (!key || !content.includes(key)), 'invalid-model-envelope');
      const parsed = json(content, 'invalid-model-completion');
      check(object(parsed) && Object.keys(parsed).length > 0, 'invalid-model-completion');
      return content;
    } finally { res.destroy(); }
  } };
}

function send(res, status, body = {}) {
  if (!res.destroyed) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

function validateEnvelope(body, id) {
  check(object(body) && Object.keys(body).sort().join(',') === 'max_tokens,messages,model,response_format,stream,temperature' &&
    body.model === id && body.stream === false && body.temperature === 0 && Number.isSafeInteger(body.max_tokens) &&
    body.max_tokens > 0 && body.max_tokens <= 16384 && ['json_object', 'json_schema'].includes(body.response_format?.type),
  'invalid-request-settings');
  check(Array.isArray(body.messages) && body.messages.length === 2 &&
    body.messages.every((m, i) => object(m) && Object.keys(m).sort().join(',') === 'content,role' &&
      m.role === ['system', 'user'][i] && typeof m.content === 'string'), 'invalid-messages');
}

export async function createGateway(prompts, adapter) {
  check(object(prompts) && Object.keys(prompts).length > 0, 'empty-prompt-pack');
  const ids = new Map(), token = randomUUID();
  for (const [id, text] of Object.entries(prompts)) {
    check(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(id) && typeof text === 'string' && text.trim(), 'invalid-prompt-pack');
    check(!ids.has(text), 'ambiguous-system-prompt');
    ids.set(text, id);
  }
  let active;
  const failures = [];
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      (active?.failures ?? failures).push({ code: req.url === endpoint ? 'unauthenticated-model-call' : 'blocked-non-model-request' });
      return send(res, 403);
    }
    const scope = active;
    if (!scope) { failures.push({ code: 'out-of-context-model-call' }); return send(res, 409); }
    if (scope.busy) { scope.failures.push({ code: 'overlapping-model-calls' }); return send(res, 409); }
    const started = performance.now(), controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 85_000);
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    const expected = scope.queue.shift();
    const call = { expected: expected?.id ?? null, prompt: null };
    scope.calls.push(call);
    let done;
    scope.busy = new Promise(resolve => { done = resolve; });
    try {
      check(req.method === 'POST' && req.url === endpoint && req.headers['content-type']?.split(';')[0] === 'application/json',
        'invalid-model-request');
      check(expected, 'unexpected-model-call');
      const body = json(await bounded(req, 256 * 1024), 'invalid-model-request');
      validateEnvelope(body, adapter.model.id);
      call.prompt = ids.get(body.messages[0].content) ?? null;
      check(call.prompt === expected.id, 'wrong-system-prompt');
      call.settings = sha256(JSON.stringify([body.temperature, body.max_tokens, body.response_format, body.stream]));
      const packet = json(body.messages[1].content, 'invalid-user-packet');
      check(object(packet) && Object.keys(packet).length > 0, 'invalid-user-packet');
      try { check(await expected.inspect?.(packet) !== false, 'packet-assertion'); }
      catch (err) { scope.failures.push(failure(err, 'packet-assertion')); call.outcome = 'packet-assertion'; return send(res, 422); }
      let content;
      if (adapter.complete) {
        content = await adapter.complete(body, controller.signal);
        check(!controller.signal.aborted, 'model-request-aborted');
        call.outcome = 'live-completion';
      } else {
        const reply = typeof expected.reply === 'function' ? await expected.reply(packet) : expected.reply;
        if (reply === null) { call.outcome = 'fixture-unavailable'; return send(res, 503); }
        check(object(reply), 'invalid-fixture-reply');
        content = JSON.stringify(reply);
        call.outcome = 'replayed';
      }
      send(res, 200, { choices: [{ message: { role: 'assistant', content } }] });
    } catch (err) {
      const problem = failure(err, adapter.complete ? 'model-call-failed' : 'fixture-error');
      call.outcome = problem.code; scope.failures.push(problem);
      send(res, 502);
    } finally {
      clearTimeout(timer);
      call.durationMs = Math.round(performance.now() - started);
      scope.busy = null; done();
    }
  });
  // The app's HTTP(S) proxy is this non-forwarding listener. CONNECT never opens a socket.
  server.on('connect', (_req, socket) => { (active?.failures ?? failures).push({ code: 'blocked-public-egress' }); socket.destroy(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { port: server.address().port, token, failures,
    begin() {
      check(!active, 'overlapping-conversations');
      const scope = { queue: [], calls: [], failures: [], busy: null };
      active = scope;
      function record(code) { (active === scope ? scope.failures : failures).push({ code }); }
      return { calls: scope.calls, failures: scope.failures, record,
        expect(id, reply, inspect) {
          try {
            check(active === scope && !scope.busy, 'expect-outside-idle-conversation');
            check(typeof id === 'string' && Object.hasOwn(prompts, id), 'unknown-expected-prompt');
            check(reply === null || object(reply) || typeof reply === 'function', 'invalid-fixture-reply');
            check(inspect === undefined || typeof inspect === 'function', 'invalid-packet-inspector');
            scope.queue.push({ id, reply, inspect });
          } catch (error) { record(failure(error).code); throw error; }
        },
        async end() {
          check(active === scope, 'wrong-conversation');
          if (scope.busy) { scope.failures.push({ code: 'unfinished-model-call' }); await scope.busy; }
          for (const { id } of scope.queue) scope.failures.push({ code: 'missing-model-call', prompt: id });
          active = null;
        }
      };
    },
    async close() {
      const stopped = once(server, 'close'); server.close(); server.closeAllConnections(); await stopped;
    }
  };
}
