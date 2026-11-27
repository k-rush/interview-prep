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

test('dropping a document files its summary and cited history without intake fields; pasted links stay bookmarks', {timeout:120_000}, async t => {
  let reading;
  const started = new Promise(resolve => { reading = resolve; });
  const model = createServer(async (req, res) => {
    let body = ''; for await (const part of req) body += part;
    if (reading) { reading(); reading = null; return; }
    const { read_attachment } = JSON.parse(JSON.parse(body).messages[1].content);
    const entries = read_attachment.map(({line, text}) => text.includes('Project Cedar') ? { line, kind:'project', label:'Project Cedar' } :
      { line, kind:'statement', label:'' });
    res.writeHead(200, { 'content-type':'application/json' });
    res.end(JSON.stringify({ choices:[{ message:{ content:JSON.stringify({ description:'Team notes about Project Cedar and its checklist.', careerHistory:false, entries }) } }] }));
  });
  model.listen(0, '127.0.0.1'); await once(model, 'listening');
  t.after(() => new Promise(resolve => {model.close(resolve); model.closeAllConnections();}));
  const app = await localHost(t, model.address().port), cookie = await app.open();
  const browser = await launchBrowser(t), context = await browser.newContext({ viewport:{width:390,height:844} });
  const [name, value] = cookie.split('=');
  await context.addCookies([{ name, value, url: app.url }]);
  const page = await context.newPage(), errors = [], uploads = [], outside = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== app.url) { outside.push(url.origin); return route.abort(); }
    if (url.pathname === '/api/experience/documents') uploads.push(route.request().postDataJSON());
    return route.continue();
  });
  await page.goto(`${app.url}/#workspace/library`);
  const zone = page.getByRole('region', {name:'Import experience'});
  await zone.getByRole('button',{name:'Choose file',exact:true}).waitFor();
  assert.equal(await zone.locator('select, input[required], textarea[required]').count(), 0);
  await zone.locator('input[type=file]').setInputFiles({name:'old.doc',mimeType:'application/msword',buffer:Buffer.from('unsupported')});
  await zone.getByRole('alert').filter({hasText:/paste/i}).waitFor();
  const main = '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
    '<w:p><w:r><w:t>We designed Project Cedar.</w:t></w:r></w:p><w:p><w:r><w:t>Our team reviewed the checklist.</w:t></w:r></w:p></w:body></w:document>';
  const zip = zipSync({'word/document.xml':Buffer.from(main), 'word/comments.xml':Buffer.from('Private comment never sent.')});
  await zone.getByRole('button', {name:'Choose file', exact:true, disabled:false}).waitFor();
  await zone.getByRole('heading', {name:'Drop a document here'}).evaluate((el, bytes) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([new Uint8Array(bytes)], 'review.docx'));
    el.dispatchEvent(new DragEvent('drop', {bubbles:true,cancelable:true,dataTransfer}));
  }, Array.from(zip));
  await page.waitForURL('**/#workspace/chat/*');
  await started;
  await page.getByRole('button',{name:'Stop document analysis'}).click();
  await page.getByText(/Document analysis stopped/).waitFor();
  assert.deepEqual((await app.state(cookie)).facts, []);
  await page.getByRole('button',{name:'Retry document analysis'}).click();
  await page.getByRole('list',{name:'Chat transcript'}).getByText(/I searched your job history/).waitFor();
  await page.getByRole('link',{name:'Review updated job history'}).click();
  await page.getByText('AI summary: Team notes about Project Cedar and its checklist.',{exact:true}).waitFor();
  await page.getByText('Project: Project Cedar',{exact:true}).click();
  await page.getByText('We designed Project Cedar. (needs review)',{exact:true}).waitFor();
  assert.equal(uploads.length, 1);
  assert.deepEqual(uploads[0], {fileName:'review.docx', requestId:uploads[0].requestId, passages:[{location:'Paragraph 1',text:'We designed Project Cedar.'},
    {location:'Paragraph 2',text:'Our team reviewed the checklist.'}]});
  const { facts } = await app.state(cookie);
  assert.equal(facts.length, 2);
  assert.ok(facts.every(f => !f.confirmed && !f.allowDrafts && !f.allowLive));
  await page.reload();
  await page.getByText(/AI summary: Team notes/).waitFor();
  await zone.getByText('Paste text or a link instead').click();
  await zone.getByLabel('Document text or bookmark').fill('https://www.linkedin.com/in/synthetic-fixture');
  await zone.getByRole('button', {name:'Add to Job experience'}).click();
  await page.getByText('Bookmark saved. The link was not opened.').waitFor();
  assert.equal(uploads.length, 1);
  assert.equal((await app.state(cookie)).facts.length, 2);
  await page.getByRole('link',{name:'talk it through in Chat'}).click();
  await page.getByLabel('Message your coach').waitFor();
  const builderUrl=page.url();
  await page.locator('.chat-page').evaluate(el=>{
    const dataTransfer=new DataTransfer();dataTransfer.items.add(new File(['Our team reviewed the checklist.'],'followup.txt'));
    el.dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer}));
  });
  await page.getByRole('heading',{name:'Import · followup.txt'}).waitFor();
  await page.getByRole('list',{name:'Chat transcript'}).getByText(/Existing statements supported by this source: 1/).waitFor();
  assert.notEqual(builderUrl,page.url());
  assert.equal((await app.state(cookie)).facts.length,2);
  assert.deepEqual(errors, []); assert.deepEqual(outside, []);
});
