import test from 'node:test';
import assert from 'node:assert/strict';

test('completion worker serves both engines from one metadata snapshot', async () => {
  const replies = [];
  globalThis.self = { postMessage: reply => replies.push(reply) };
  await import('../src/completion.worker.js');
  const metadata = {
    schemas: ['public'], currentSchema: 'public',
    relations: [{ schema: 'public', name: 'sailors', kind: 'table' }],
    columns: [{ schema: 'public', relation: 'sailors', name: 'handle', type: 'text' }],
    functions: []
  };
  self.onmessage({ data: { type: 'init', id: 1, generation: 1, metadata } });
  assert.deepEqual(replies.pop(), { id: 1, generation: 1, result: true });

  for (const method of ['crabsense', 'codemirror']) {
    const sql = 'SELECT s.ha FROM public.sailors s';
    self.onmessage({ data: { type: 'complete', id: 2, generation: 1, method,
      sql, offset: 'SELECT s.ha'.length, limit: 500 } });
    const reply = replies.pop();
    assert.equal(reply.error, undefined, `${method}: ${reply.error}`);
    assert.ok(reply.result.suggestions.some(item => item.label === 'handle'), method);
  }

  self.onmessage({ data: { type: 'complete', id: 3, generation: 0, method: 'crabsense',
    sql: 'SELECT ', offset: 7, limit: 500 } });
  assert.deepEqual(replies.pop(), { id: 3, generation: 0, result: null });
});
