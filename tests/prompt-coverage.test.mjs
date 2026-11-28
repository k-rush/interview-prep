import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

test('every named scenario in the evaluation plan has multiple runnable conversations', async () => {
  const plan = await readFile(new URL('../docs/prompt-evaluation-plan.md', import.meta.url), 'utf8');
  const inventory = plan.split('## Framework and rollout plan')[0];
  const required = [...inventory.matchAll(/\(`([a-z]+-[a-z-]+)`\)/g)].map(m => m[1]).sort();
  assert.ok(required.length >= 40);
  const dir = new URL('../evals/cases/', import.meta.url);
  const modules = await Promise.all((await readdir(dir)).filter(f => f.endsWith('.mjs')).map(f => import(new URL(f, dir))));
  const scenarios = modules.flatMap(m => m.default);
  assert.deepEqual(scenarios.map(s => s.id).sort(), required);
  for (const { id, conversations } of scenarios) {
    assert.ok(new Set(conversations.map(c => c.id)).size >= 2, `Missing variants for ${id}`);
    assert.ok(conversations.every(c => typeof c.run === 'function'), `Non-runnable conversation in ${id}`);
  }
});
