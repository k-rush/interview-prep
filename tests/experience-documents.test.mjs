import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { launchBrowser } from '../apps/web/tests/browser.mjs';
import { localHost } from './local-host.mjs';

const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
const { build } = requireWeb('esbuild'), { zipSync } = requireWeb('fflate');
const web = fileURLToPath(new URL('../apps/web/', import.meta.url));
function samplePdf() {
  const content = 'BT /F1 12 Tf 20 80 Td (Synthetic contributor reviewed the checklist.) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 120] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let text = '%PDF-1.4\n'; const offsets = [0];
  for (const [i, o] of objects.entries()) { offsets.push(text.length); text += `${i + 1} 0 obj\n${o}\nendobj\n`; }
  const xref = text.length;
  text += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}` +
    `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}

test('local PDF, DOCX and text previews let the candidate select and redact without sending the original', async t => {
  const common = { absWorkingDir: web, bundle: true, minify: true, write: false, jsx: 'automatic', logLevel: 'silent' };
  const [reader, harness, worker] = await Promise.all([
    build({ ...common, entryPoints: ['src/ExperienceDocumentReader.tsx'], format: 'esm' }),
    build({ ...common, stdin: { loader: 'tsx', resolveDir: web, contents: `
      import {createRoot} from 'react-dom/client';
      import {DocumentPreview} from './src/ExperienceDocuments';
      createRoot(document.querySelector('main')).render(<DocumentPreview onUse={(text, location) =>
        document.querySelector('output').textContent = location + ': ' + text} />);` } }),
    readFile(join(web, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'))]);
  const files = { '/fixture.js': harness.outputFiles[0].contents, '/assets/experience-reader.js': reader.outputFiles[0].contents,
    '/assets/experience-pdf.worker.js': worker };
  const serves = [];
  const server = createServer((req, res) => {
    serves.push([req.method, req.url]);
    res.setHeader('Content-Security-Policy', "default-src 'self'; object-src 'none'; base-uri 'none'");
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html'); res.end('<!doctype html><main></main><output></output><script src="/fixture.js"></script>');
    } else if (files[req.url]) { res.setHeader('content-type', 'text/javascript'); res.end(files[req.url]); }
    else { res.writeHead(404); res.end(); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await launchBrowser(t);
  const page = await browser.newPage(), origin = `http://127.0.0.1:${server.address().port}`, outside = [];
  page.setDefaultTimeout(15000);
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin === origin) return route.continue();
    outside.push(route.request().url()); return route.abort();
  });
  await page.goto(origin);
  const input = page.getByLabel('Preview a local document'), preview = page.getByLabel('Local preview (highlight the part to keep)');
  const choose = (name, mimeType, buffer) => input.setInputFiles({ name, mimeType, buffer });
  await choose('example.pdf', 'application/pdf', samplePdf());
  assert.match(await preview.inputValue(), /Synthetic contributor reviewed the checklist/);
  await page.getByRole('button', { name: 'Copy selected text to redaction editor' }).click();
  await page.getByLabel('Redact or correct this excerpt before using it').fill('A contributor reviewed the checklist.');
  await page.getByRole('button', { name: 'Use reviewed excerpt' }).click();
  assert.equal(await page.locator('output').textContent(), 'Page 1: A contributor reviewed the checklist.');
  const main = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>Private first paragraph.</w:t></w:r></w:p><w:p><w:r><w:t>Second project paragraph.</w:t></w:r></w:p></w:body></w:document>';
  const zip = zipSync({ 'word/document.xml': Buffer.from(main), 'word/comments.xml': Buffer.from('Never preview these notes.') });
  await choose('example.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', Buffer.from(zip));
  await page.getByLabel('Source passage').selectOption('1');
  assert.equal(await preview.inputValue(), 'Second project paragraph.');
  await choose('positions.csv', 'text/csv', Buffer.from('Position,Company\nDesigner,Fixture'));
  assert.match(await preview.inputValue(), /Designer,Fixture/);
  await choose('scan.doc', 'application/msword', Buffer.from('unsupported'));
  await page.getByRole('alert').filter({ hasText: /paste/i }).waitFor();
  await choose('large.txt', 'text/plain', Buffer.alloc(3 * 1024 * 1024 + 1, 65));
  await page.getByRole('alert').filter({ hasText: /limits/i }).waitFor();
  assert.deepEqual(outside, []);
  assert.ok(serves.every(([method]) => method === 'GET'), 'preview must read local scripts only, not post any file or excerpt');
});

test('job experience imports only the reviewed pasted excerpt and opens the conversational builder', async t => {
  const app = await localHost(t), cookie = await app.open();
  const browser = await launchBrowser(t), context = await browser.newContext();
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: app.url }]);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => new URL(route.request().url()).origin === app.url ? route.continue() : route.abort());
  await page.goto(`${app.url}/#workspace/library`);
  await page.getByText('Import a document or link',{exact:true}).click();
  await page.getByLabel('Evidence category').selectOption('performance-review');
  await page.getByLabel('Private source title').fill('Sample assessment');
  await page.getByLabel('Or paste text for a private preview').fill('Synthetic Name: our team reviewed the plan.');
  await page.getByRole('button', { name: 'Select pasted passage for redaction' }).click();
  await page.getByLabel('Selected excerpt 1 (remove names and confidential details)').fill('Our team reviewed the plan.');
  await page.getByLabel('I have permission to use this material', { exact: false }).check();
  await page.getByRole('button', { name: 'Save reviewed evidence' }).click();
  await page.getByText(/Saved\. Review any proposed statements/).waitFor();
  const { facts } = await app.state(cookie);
  assert.equal(facts.length, 1);
  assert.equal(facts[0].confirmed, false);
  assert.doesNotMatch(facts[0].source, /Synthetic Name/);
  assert.equal(facts[0].claim, 'Our team reviewed the plan.');
  await page.getByRole('link',{name:'talk it through in Chat'}).click();
  await page.getByLabel('Message your coach').waitFor();
  assert.deepEqual(errors, []);
});
