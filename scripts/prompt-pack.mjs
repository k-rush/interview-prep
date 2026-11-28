import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const source = fileURLToPath(new URL('../apps/api/Prompts/', import.meta.url));
const release = JSON.parse(await readFile(join(source, 'release.json'), 'utf8'));
const ids = [...release.ids].sort();
const maxBytes = 128 * 1024;
const hex = /^[0-9a-f]{64}$/;
const semver = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const pointer = store => join(store, 'active');
const artifact = (store, digest) => join(store, 'releases', `${digest}.json`);
const binding = (store, version) => join(store, 'versions', version);

function validate(raw) {
  if (!raw || Object.keys(raw).sort().join(',') !== 'contract,prompts,version' || raw.contract !== 1 ||
      typeof raw.version !== 'string' || !semver.test(raw.version) || !raw.prompts ||
      JSON.stringify(Object.keys(raw.prompts).sort()) !== JSON.stringify(ids)) throw Error('Incompatible prompt pack contract or version.');
  const prompts = {}, hash = createHash('sha256').update(`interview-prep-prompts/1\0${raw.version}\0`);
  for (const id of ids) {
    const text = raw.prompts[id];
    if (typeof text !== 'string') throw Error(`Missing prompt: ${id}`);
    const body = text.replaceAll('\r\n', '\n').replace(/\n+$/, '');
    if (!body.trim() || body.length > 8192 || /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(body))
      throw Error(`Invalid prompt text: ${id}`);
    hash.update(`${id}\0${body}\0`);
    prompts[id] = body;
  }
  return { version: raw.version, digest: hash.digest('hex'), prompts };
}

async function bounded(path, max) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > max) throw Error('Oversized or non-file prompt artifact.');
    const bytes = await handle.readFile();
    if (bytes.length > max) throw Error('Oversized prompt artifact.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } finally { await handle.close(); }
}

async function readDigest(path) {
  const digest = (await bounded(path, 66)).replace(/[\r\n]+$/, '');
  if (!hex.test(digest)) throw Error('Invalid prompt digest pointer.');
  return digest;
}

async function byDigest(store, digest) {
  if (!hex.test(digest)) throw Error('Expected a lowercase SHA-256 digest.');
  const { pack } = await readArtifact(artifact(store, digest));
  if (pack.digest !== digest) throw Error('Prompt digest mismatch.');
  return pack;
}

export async function loadPack(store) {
  if (store !== undefined) return byDigest(store, await readDigest(pointer(store)));
  const files = (await readdir(source)).filter(f => f.endsWith('.txt')).sort();
  if (JSON.stringify(files) !== JSON.stringify(ids.map(id => id + '.txt'))) throw Error('Bundled prompts do not match release.json.');
  const prompts = Object.fromEntries(await Promise.all(ids.map(async id => [id, await bounded(join(source, id + '.txt'), 32768)])));
  return validate({ contract: release.contract, version: release.version, prompts });
}

function encode(pack) {
  const bytes = JSON.stringify({ contract: 1, version: pack.version, prompts: pack.prompts }) + '\n';
  if (Buffer.byteLength(bytes) > maxBytes) throw Error('Oversized prompt pack.');
  return bytes;
}

async function readArtifact(file) {
  const bytes = await bounded(file, maxBytes), pack = validate(JSON.parse(bytes));
  // The publisher and reader must not interpret duplicate JSON properties differently.
  if (bytes !== encode(pack)) throw Error('Not a canonical artifact; use prompt-pack.mjs build.');
  return { bytes, pack };
}

export async function build(file) {
  const pack = await loadPack();
  await writeFile(file, encode(pack), { flag: 'wx' });
  return pack;
}

async function atomic(path, text) {
  const tmp = join(dirname(path), `.prompt-${randomUUID()}.tmp`);
  try {
    const handle = await open(tmp, 'wx', 0o644);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); }
}

async function locked(store, work) {
  await mkdir(store, { recursive: true });
  const path = join(store, '.writer.lock');
  let lock;
  try { lock = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw Error('Another prompt writer holds the store lock.'); throw error; }
  try { return await work(); }
  finally { await lock.close(); await rm(path); }
}

async function orMissing(work) {
  try { return await work(); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function install(file, store) {
  const { bytes, pack } = await readArtifact(file);
  return locked(store, async () => {
    await mkdir(join(store, 'versions'), { recursive: true });
    await mkdir(join(store, 'releases'), { recursive: true });
    const name = binding(store, pack.version), prior = await orMissing(() => readDigest(name));
    if (prior !== null && prior !== pack.digest) throw Error('Version already names a different digest; bump release.json.');
    if (!await orMissing(() => byDigest(store, pack.digest))) await atomic(artifact(store, pack.digest), bytes);
    if (prior === null) await atomic(name, pack.digest + '\n');
    return pack;
  });
}

export async function activate(store, digest, expected) {
  if (expected !== 'none' && (typeof expected !== 'string' || !hex.test(expected))) throw Error('Expected the current digest or none.');
  return locked(store, async () => {
    const pack = await byDigest(store, digest);
    if (await readDigest(binding(store, pack.version)) !== digest) throw Error('Digest was not installed with this version.');
    const current = await orMissing(() => readDigest(pointer(store)));
    if (current === digest) return pack;
    if ((current ?? 'none') !== expected) throw Error('Serving pointer changed; inspect it before activating.');
    await atomic(pointer(store), digest + '\n');
    return pack;
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [command, ...args] = process.argv.slice(2);
  const commands = { build: [1, build], install: [2, install], activate: [3, activate], status: [1, loadPack] };
  try {
    if (!Object.hasOwn(commands, command) || args.length !== commands[command][0])
      throw Error('Usage: prompt-pack.mjs build FILE | install FILE STORE | activate STORE DIGEST EXPECTED_DIGEST_OR_none | status STORE');
    const { version, digest } = await commands[command][1](...args);
    console.log(JSON.stringify({ version, digest }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
