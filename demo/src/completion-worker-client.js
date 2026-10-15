/** Run both comparison methods off the editor thread and discard stale replies. */
export function createCompletionWorkerClient(worker) {
  let generation = 0;
  let nextId = 0;
  let failed;
  const pending = new Map();

  function settle(id, value, error) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.subscription?.dispose();
    if (error) request.reject(error);
    else request.resolve(value);
  }

  worker.onmessage = ({ data }) => {
    settle(data.id, data.generation === generation ? data.result : null,
      data.error ? new Error(data.error) : null);
  };
  worker.onerror = event => {
    failed = new Error(event.message || 'Completion worker failed');
    for (const id of pending.keys()) settle(id, null, failed);
  };

  function request(type, payload, token) {
    if (failed) return Promise.reject(failed);
    if (token?.isCancellationRequested) return Promise.resolve(null);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const subscription = token?.onCancellationRequested(() => settle(id, null));
      pending.set(id, { resolve, reject, subscription });
      if (token?.isCancellationRequested) return settle(id, null);
      try {
        worker.postMessage({ type, id, generation, ...payload });
      } catch (error) {
        settle(id, null, error);
      }
    });
  }

  return {
    setMetadata(snapshot) {
      generation++;
      for (const id of pending.keys()) settle(id, null);
      return request('init', { metadata: snapshot });
    },
    complete(method, sql, offset, { limit } = {}, token) {
      return request('complete', { method, sql, offset, limit }, token);
    }
  };
}
