# CrabSense 🦀

CrabSense adds PostgreSQL-aware completion to a SQL editor. Give it a snapshot of the database objects a user can access, then pass in SQL and a cursor position. It suggests relations, columns, types, functions, and useful SQL keywords. The engine is a dependency-free ESM package; the separate crab-themed Monaco playground lets you try it against a local PostgreSQL database.

CrabSense is a **0.1.0 prototype**. It uses a fast, recoverable SQL context resolver rather than a complete PostgreSQL grammar. See [limits](#limits) before using it for advanced SQL.

## Try the playground

From this repository:

```sh
docker compose up --build
```

Open [http://localhost:3000](http://localhost:3000) and choose an example. The editor loads it, moves the cursor to the relevant position, and opens suggestions. **New query** clears the editor. You can also type these yourself (`▌` marks the cursor):

| SQL at the cursor | What CrabSense offers |
| --- | --- |
| `SELECT * FROM ▌` | Accessible tables, views, and schemas |
| `SELECT s.▌ FROM public.sailors AS s` | Columns from `sailors` |
| `SELECT * FROM harbor.▌` | Relations in the `harbor` schema |
| `SELECT * FROM public.sailors AS s WHERE ▌` | Columns, functions, and SQL keywords for an expression |

**Refresh schema** fetches new metadata after changes made in a separate PostgreSQL client. The demo uses local-only PostgreSQL credentials. Editor SQL stays in the browser: the server exposes catalog metadata, not a query execution endpoint. PostgreSQL runs [the demo seed SQL](demo/db/init.sql) when its Compose data volume is first created. See the [playground guide](docs/demo.md) for the full example list and comparison tools.

## Use the package

The repository root is the package; `demo/` is a separate private application. The package is not published to npm by this project. Build a checkout before installing it in another app:

```sh
# In the CrabSense checkout
npm run build
# In your application
npm install /path/to/crabsense
```

Pass a permission-filtered catalog snapshot. This example needs no database connection at completion time:

```js
import { createCrabSense, completionEdit } from 'crabsense';

const catalog = {
  schemas: ['public'],
  relations: [{ schema: 'public', name: 'sailors', kind: 'table' }],
  columns: [{ schema: 'public', relation: 'sailors', name: 'handle', type: 'text' }],
  functions: []
};
const engine = createCrabSense(catalog);
const sql = 'SELECT s.ha FROM public.sailors s';
const offset = 'SELECT s.ha'.length;
const result = engine.complete(sql, offset, { limit: 500 });
const handle = result.suggestions.find(item => item.label === 'handle');
const edit = completionEdit(sql, offset, result.replacementStart, handle);
// edit: { replacementStart: 9, replacementEnd: 11, insertText: 'handle', ... }
```

Offsets are JavaScript string positions. A completion result contains ordered `suggestions`, `replacementStart`, a `context` label, and `incomplete` when the result limit omitted matches. `completionEdit` computes the replacement range and insertion text, including partially quoted identifiers. `engine.signatureHelp(sql, offset)` returns Monaco-compatible function signatures or `null`. The package ships TypeScript declarations and does not import Monaco.

The required snapshot fields are `schemas`, `relations`, `columns`, and `functions` arrays, as shown above. Common optional fields are:

| Field | Purpose |
| --- | --- |
| `searchPath: string[]` | Effective PostgreSQL lookup order for unqualified names |
| `currentSchema: string` | Default schema for draft `CREATE TABLE` statements |
| `types` | `{ schema, name, kind, sqlName? }` entries for type completion |
| `builtinFunctions` | Built-in routines with the same fields as `functions` |
| `settings` | `{ name, description }` entries for `SHOW` completion |
| `keywords` | PostgreSQL keyword strings for suggestions and optional Monaco highlighting |

The full shapes are in [the source TypeScript contract](src/completion.d.ts), shipped as `dist/index.d.ts`. Treat the arrays as immutable while an engine uses them; create a new engine when metadata changes. The demo's privilege-filtered [`GET /api/schema`](demo/server/index.js) is a working snapshot provider. It caches metadata for 30 seconds; `?refresh=1` bypasses the cache.

## What it completes

- Relations after `FROM` and `JOIN`; columns after `alias.` or `table.`; schema members after `schema.`.
- Columns, functions, and SQL keywords in expressions. It respects quoted identifiers, comments, strings, aliases, and cursor replacement ranges.
- Common `SELECT`, CTE, subquery, JOIN, set-operation, `INSERT`, `UPDATE`, `DELETE`, `SHOW`, and type-declaration contexts.
- Columns projected by completed CTEs and simple derived tables. Earlier completed `CREATE TABLE` statements in the editor can also supply **draft** relations and columns. Draft suggestions describe editor text; they do not mean the DDL ran.

For Monaco, start with the [Vite integration guide](docs/monaco-postgresql.md). It covers SQL language registration, highlighting, completion and signature providers, and metadata refresh. The [Web Worker recipe below](#run-completion-in-a-web-worker-with-monaco) keeps completion off the typing thread for larger documents. The demo runs completion in a dedicated worker. Optional syntax validation is a separate feature; it does not execute SQL.

See [completion behavior and boundaries](docs/completion-coverage.md) for detailed scope, JOIN, CTE, ranking, and draft-DDL behavior.

## Limits

CrabSense uses heuristics to keep useful suggestions available while SQL is unfinished. It is not a full PostgreSQL parser or type checker. Complex recursive CTE output types, arbitrary expression types, mutually recursive definitions, every routine-overload rule, procedural SQL, and every nested scope rule are outside the current model. Suggestions can need further context checks in advanced constructs.

Draft DDL covers simple completed `CREATE TABLE` and single-table `DROP TABLE` statements earlier in the editor. It does not model `ALTER TABLE`, `CREATE TABLE AS`, transaction rollback, or temporary-table lifetime. The browser demo's optional `libpg_query` validator checks syntax only; neither validation nor completion confirms that a query will run or that its referenced objects exist in the database.

See [completion behavior and boundaries](docs/completion-coverage.md) and [the resolution roadmap](docs/sql-resolution-plan.md) for coverage and remaining work. CrabSense is licensed under [Apache 2.0](LICENSE).

## Third-party software

The root completion package has no runtime dependencies. The separate playground installs Monaco Editor, CodeMirror SQL, `libpg-query`, Vite, Express, and `pg` through its npm manifests, and runs PostgreSQL through Docker Compose. The one third-party binary committed to this repository is [`demo/public/libpg-query.wasm`](demo/public/libpg-query.wasm), copied from `libpg-query` 17.7.4; its [MIT license](demo/public/LICENSE-libpg-query) is included alongside it. The demo's CodeMirror comparison uses that project's completion sources independently. The [PGLS WASM benchmark](demo/benchmarks/pgls-wasm.md) installs its comparison package separately and does not bundle it with CrabSense. Some independent [test scenarios](tests/pgcli-corpus.test.js) adapt SQL situations from pgcli's completion tests, with attribution in that file.

## Run completion in a Web Worker with Monaco

For large queries, keep the synchronous CrabSense engine in a dedicated browser worker. The demo now runs both comparison engines in such a worker; see [its worker](demo/src/completion.worker.js) and [client](demo/src/completion-worker-client.js). The host still fetches the permission-filtered catalog snapshot and registers Monaco's completion provider. This smaller CrabSense-only example assumes an ESM bundler such as Vite and the Monaco setup in the [editor recipe](docs/monaco-postgresql.md). The worker below is separate from Monaco's own `EditorWorker`.

Create `completion.worker.js` next to your editor module:

```js
import { createCrabSense, completionEdit } from 'crabsense';

let engine;
let generation = 0;

self.onmessage = ({ data }) => {
  if (data.type === 'schema') {
    generation = data.generation;
    engine = createCrabSense(data.snapshot);
    return;
  }
  if (data.type !== 'complete') return;
  const { id, sql, offset } = data;
  if (!engine || data.generation !== generation) {
    self.postMessage({ id, generation: data.generation, result: null });
    return;
  }
  try {
    const completion = engine.complete(sql, offset, { limit: 500 });
    const result = {
      ...completion,
      suggestions: completion.suggestions.map(suggestion => ({
        ...suggestion,
        edit: completionEdit(sql, offset, completion.replacementStart, suggestion)
      }))
    };
    self.postMessage({ id, generation, result });
  } catch (error) {
    self.postMessage({ id, generation, error: String(error) });
  }
};
```

In your Monaco module, replace the synchronous provider's engine call with a request to that worker. The worker also computes replacement edits, so the main thread does not import CrabSense:

```js
const completionWorker = new Worker(new URL('./completion.worker.js', import.meta.url), { type: 'module' });
const pending = new Map();
let generation = 0;
let nextId = 0;

function finish(id, result) {
  const request = pending.get(id);
  if (!request) return; // Canceled or superseded request.
  pending.delete(id);
  request.subscription.dispose();
  request.resolve(result);
}

completionWorker.onmessage = ({ data }) => {
  if (data.error) console.error('CrabSense worker:', data.error);
  finish(data.id, data.generation === generation && !data.error ? data.result : null);
};
completionWorker.onerror = error => {
  console.error('CrabSense worker:', error);
  for (const id of pending.keys()) finish(id, null);
};

function setCompletionSnapshot(snapshot) {
  generation++;
  for (const id of pending.keys()) finish(id, null);
  completionWorker.postMessage({ type: 'schema', generation, snapshot });
}

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', ' ', '"', '('],
  async provideCompletionItems(model, position, _context, token) {
    if (token.isCancellationRequested) return { suggestions: [] };
    const sql = model.getValue();
    const offset = model.getOffsetAt(position);
    const version = model.getVersionId();
    const id = ++nextId;
    const result = await new Promise(resolve => {
      const subscription = token.onCancellationRequested(() => finish(id, null));
      pending.set(id, { resolve, subscription });
      completionWorker.postMessage({ type: 'complete', id, generation, sql, offset });
    });
    if (!result || token.isCancellationRequested || model.getVersionId() !== version) return { suggestions: [] };
    return {
      incomplete: true, // Recompute filtering and ranking as the prefix changes.
      suggestions: result.suggestions.map((suggestion, index) => {
        const edit = suggestion.edit;
        const start = model.getPositionAt(edit.replacementStart);
        const end = model.getPositionAt(edit.replacementEnd);
        return {
          label: { label: suggestion.label, description: suggestion.listDescription },
          kind: ({ column: monaco.languages.CompletionItemKind.Field,
            function: monaco.languages.CompletionItemKind.Function,
            schema: monaco.languages.CompletionItemKind.Module,
            keyword: monaco.languages.CompletionItemKind.Keyword })[suggestion.kind]
            ?? monaco.languages.CompletionItemKind.Text,
          detail: suggestion.detail,
          insertText: edit.insertText,
          insertTextRules: suggestion.kind === 'function'
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          filterText: sql.slice(edit.replacementStart, offset),
          sortText: String(index).padStart(8, '0'),
          range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
        };
      })
    };
  }
});

// Use the same function for initial loading and the Refresh schema button.
async function refreshSchema(force = false) {
  const response = await fetch(`/api/schema${force ? '?refresh=1' : ''}`);
  if (!response.ok) throw new Error(`Schema request failed: HTTP ${response.status}`);
  setCompletionSnapshot(await response.json());
}
await refreshSchema();
```

The host sends the snapshot once per refresh and sends SQL plus the cursor offset for each completion request. Request IDs, Monaco's cancellation token, and the model version discard stale replies. A worker keeps typing responsive, but canceling a request does not stop synchronous work already running inside it; a newer request waits in that worker's queue. If that becomes visible, add a worker-side document cache or replace the worker when a costly request must be aborted. Editor SQL stays in the browser and never goes to `/api/schema`.

## Develop and measure

```sh
npm test
npm run build
npm --prefix demo ci
npm run demo:test
npm run demo:build
```

Package files go to `dist/`; the demo builds to `demo/dist/`. For correctness and latency details, see the [single-query stress report](demo/benchmarks/query-stress.md), [schema-scale and comparison commands](docs/demo.md#validate), and [PGLS WASM comparison](demo/benchmarks/pgls-wasm.md). The [SQL resolution roadmap](docs/sql-resolution-plan.md) tracks deeper grammar, scope, and expression-type work.
