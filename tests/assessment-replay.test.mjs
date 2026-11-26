import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { localHost } from './local-host.mjs';

test('a local coach must cite the answers; unused facts and an ungraded retry cannot inflate the verdict', async t => {
  const answers = ['I wrote the launch checklist.', 'I chose a pilot over a one-step rollout.',
    'The rollout went well.', 'We rehearsed with one team before expanding.'];
  const labels = ['Ownership', 'Judgment', 'Impact', 'Clarity'];
  const questions = ['What part of the release did you own?', 'What alternative rollout did you consider?',
    'Which platform impact did you observe?', 'How would you explain the release to a new teammate?'];
  const marks = [3, 3, 2, 4].map((points, i) => ({ competency: labels[i], points, quote: answers[i], feedback: 'Describe the observation behind the claim.' }));
  const requests = [];
  const fixture = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    requests.push({ path: req.url, body });
    let content;
    if (requests.length <= 2) {
      const plan = labels.map((competency, i) => ({ competency, text: questions[i] }));
      content = { questions: requests.length === 1 ? plan.slice(1) : plan };
    } else {
      const result = structuredClone(marks);
      if (requests.length === 3) result[2].quote = 'Invented evidence not present in the answer';
      content = { marks: result };
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }));
  });
  fixture.listen(0, '127.0.0.1'); await once(fixture, 'listening');
  t.after(() => { fixture.closeAllConnections(); return new Promise(resolve => fixture.close(resolve)); });
  const app = await localHost(t, fixture.address().port), token = await app.open();
  const post = (path, body) => app.request(path, token, 'POST', body);
  const privateFact = 'Private library example deliberately omitted from the mock';
  const fact = await (await post('evidence', { project: 'Related work', statement: privateFact })).json();
  await post(`evidence/${fact.id}/confirm`, { claim: privateFact });
  const target = { target: 'Platform engineering role', tailor: true };
  assert.equal((await post('mocks', target)).status, 503);
  assert.deepEqual((await app.state(token)).mocks, []);
  const { id } = await (await post('mocks', target)).json();
  assert.deepEqual((await app.state(token)).mocks[0].questions, questions);
  for (const [index, text] of answers.entries()) assert.equal((await post(`mocks/${id}/answers`, { index, text })).status, 204);
  assert.equal((await post(`mocks/${id}/report`, { assessor: 'local' })).status, 503);
  assert.equal((await app.state(token)).mocks[0].report, null);
  assert.equal((await post(`mocks/${id}/report`, { assessor: 'local' })).status, 204);
  assert.equal((await post(`mocks/${id}/report`, { assessor: 'local' })).status, 204);
  assert.equal(requests.length, 4);
  assert.ok(requests.every(r => r.path === '/v1/chat/completions' && !r.body.includes(privateFact)));
  const packet = JSON.parse(JSON.parse(requests[3].body).messages[1].content);
  assert.deepEqual(packet.turns.map(t => t.question), questions);
  const { report } = (await app.state(token)).mocks[0];
  assert.deepEqual([report.assessor, report.score, report.grade, report.verdict, report.retryIndex], ['local', 75, 'C', 'Simulated no-hire', 2]);
  assert.equal((await post(`mocks/${id}/retry`, { text: 'I compared notes from both pilot teams.' })).status, 204);
  assert.deepEqual((await app.state(token)).mocks[0].report, report);
  assert.deepEqual((await app.state(token)).mocks[0].answers, answers);
});
