import { createCrabSense } from '@proddata/crabsense';
import { createCodeMirror } from './methods/codemirror.js';

let generation = 0;
let metadata;
let crabsense;
let codeMirror;

self.onmessage = ({ data }) => {
  const { id } = data;
  try {
    if (data.type === 'init') {
      generation = data.generation;
      metadata = data.metadata;
      crabsense = createCrabSense(metadata);
      codeMirror = null;
      self.postMessage({ id, generation, result: true });
      return;
    }
    if (data.generation !== generation || !crabsense) {
      self.postMessage({ id, generation: data.generation, result: null });
      return;
    }
    if (data.type !== 'complete') throw new Error(`Unknown worker request: ${data.type}`);
    const engine = data.method === 'crabsense' ? crabsense :
      data.method === 'codemirror' ? (codeMirror ??= createCodeMirror(metadata)) : null;
    if (!engine) throw new Error(`Unknown completion method: ${data.method}`);
    const result = engine.complete(data.sql, data.offset, { limit: data.limit });
    self.postMessage({ id, generation, result });
  } catch (error) {
    self.postMessage({ id, generation, error: error.message || String(error) });
  }
};
