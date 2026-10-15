import test from 'node:test';
import assert from 'node:assert/strict';
import { createCompletionWorkerClient } from '../src/completion-worker-client.js';

class FakeWorker {
  sent = [];
  postMessage(message) { this.sent.push(message); }
  reply(message) { this.onmessage({ data: message }); }
}

test('worker client sends metadata once and resolves capped completion replies', async () => {
  const worker = new FakeWorker();
  const client = createCompletionWorkerClient(worker);
  const metadata = { schemas: ['public'], relations: [], columns: [], functions: [] };
  const ready = client.setMetadata(metadata);
  assert.equal(worker.sent[0].type, 'init');
  assert.equal(worker.sent[0].metadata, metadata);
  worker.reply({ id: worker.sent[0].id, generation: 1, result: true });
  assert.equal(await ready, true);

  const completion = client.complete('crabsense', 'SELECT s.', 9, { limit: 500 });
  const sent = worker.sent[1];
  assert.deepEqual({ type: sent.type, method: sent.method, sql: sent.sql, offset: sent.offset, limit: sent.limit },
    { type: 'complete', method: 'crabsense', sql: 'SELECT s.', offset: 9, limit: 500 });
  assert.equal('metadata' in sent, false);
  const result = { suggestions: [{ label: 'id' }], incomplete: false };
  worker.reply({ id: sent.id, generation: 1, result });
  assert.equal(await completion, result);
});

test('schema refresh and cancellation discard stale completion replies', async () => {
  const worker = new FakeWorker();
  const client = createCompletionWorkerClient(worker);
  let ready = client.setMetadata({ schemas: [], relations: [], columns: [], functions: [] });
  worker.reply({ id: worker.sent.at(-1).id, generation: 1, result: true });
  await ready;

  const stale = client.complete('crabsense', 'SELECT ', 7);
  const staleId = worker.sent.at(-1).id;
  ready = client.setMetadata({ schemas: ['harbor'], relations: [], columns: [], functions: [] });
  assert.equal(await stale, null);
  worker.reply({ id: staleId, generation: 1, result: { suggestions: ['stale'] } });
  worker.reply({ id: worker.sent.at(-1).id, generation: 2, result: true });
  await ready;

  let canceled = false;
  let cancel;
  const token = {
    get isCancellationRequested() { return canceled; },
    onCancellationRequested(listener) { cancel = listener; return { dispose() {} }; }
  };
  const pending = client.complete('codemirror', 'SELECT ', 7, { limit: 60 }, token);
  const canceledId = worker.sent.at(-1).id;
  canceled = true;
  cancel();
  assert.equal(await pending, null);
  worker.reply({ id: canceledId, generation: 2, result: { suggestions: ['late'] } });
});

test('worker errors reject requests instead of leaving them pending', async () => {
  const worker = new FakeWorker();
  const client = createCompletionWorkerClient(worker);
  const ready = client.setMetadata({ schemas: [], relations: [], columns: [], functions: [] });
  worker.reply({ id: worker.sent[0].id, generation: 1, result: true });
  await ready;
  const pending = client.complete('crabsense', 'SELECT ', 7);
  worker.reply({ id: worker.sent.at(-1).id, generation: 1, error: 'worker failure' });
  await assert.rejects(pending, /worker failure/);
});
