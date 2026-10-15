# Configure Monaco for PostgreSQL with CrabSense

This recipe uses Vite and the ESM package entry point. Install `monaco-editor` in your app and install CrabSense from this checkout:

```sh
npm install monaco-editor /path/to/crabsense
```

Add an element such as `<div id="editor" style="height: 32rem"></div>` to the page. Your app must also expose a metadata endpoint that returns the [CrabSense snapshot shape](../README.md#use-the-package). This repo's `GET /api/schema` is an example. Keep database credentials and catalog queries on the server; the browser should receive only objects the current user may see.

If the snapshot includes an effective `searchPath` array, CrabSense uses that order for unqualified relation, type, and routine lookup. The demo obtains it from PostgreSQL's `current_schemas(true)`. `currentSchema` selects the target for draft `CREATE TABLE` statements earlier in the editor and remains a preference for older snapshots without `searchPath`. For a script that has actually run, refresh the server snapshot after execution. Draft suggestions are inferred from text and are labeled accordingly. The optional `types` array supplies `{ schema, name, kind, sqlName? }` entries for type suggestions after a column declaration, `CAST(... AS ...)`, `::`, `RETURNS`, and common `ALTER TABLE` forms. Without it, the package offers a small built-in type list. The demo obtains accessible types from `pg_type`, including domains and enums.

## Editor, language, and providers

This is one module. Register the language and providers once, and replace `engine` when metadata changes.

```js
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import { conf as sqlConfiguration, language as sqlLanguage }
  from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { createCrabSense, completionEdit } from 'crabsense';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({ id: 'sql', extensions: ['.sql'], aliases: ['SQL'] });
monaco.languages.setLanguageConfiguration('sql', sqlConfiguration);
let tokenizer = monaco.languages.setMonarchTokensProvider('sql', sqlLanguage);
function installKeywords(snapshot) {
  // The fallback is useful while the metadata request is loading.
  const keywords = snapshot.keywords?.length
    ? [...new Set(snapshot.keywords.map(word => word.toUpperCase()))]
    : sqlLanguage.keywords;
  tokenizer.dispose();
  tokenizer = monaco.languages.setMonarchTokensProvider('sql', {
    ...sqlLanguage, keywords
  });
}

const editor = monaco.editor.create(document.getElementById('editor'), {
  value: 'SELECT * FROM ',
  language: 'sql',
  theme: 'vs-dark',
  automaticLayout: true,
  minimap: { enabled: false },
  suggest: { showWords: false, localityBonus: false },
  suggestSelection: 'first',
  quickSuggestions: { other: true, comments: false, strings: false },
  quickSuggestionsDelay: 75,
  wordBasedSuggestions: 'off'
});

const empty = { schemas: [], relations: [], columns: [], functions: [], types: [] };
let engine = createCrabSense(empty);

const kinds = {
  table: monaco.languages.CompletionItemKind.Struct,
  cte: monaco.languages.CompletionItemKind.Struct,
  view: monaco.languages.CompletionItemKind.Reference,
  'materialized view': monaco.languages.CompletionItemKind.Reference,
  schema: monaco.languages.CompletionItemKind.Module,
  column: monaco.languages.CompletionItemKind.Field,
  function: monaco.languages.CompletionItemKind.Function,
  type: monaco.languages.CompletionItemKind.Class,
  setting: monaco.languages.CompletionItemKind.Property,
  keyword: monaco.languages.CompletionItemKind.Keyword
};

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', ' ', '"', '('],
  provideCompletionItems(model, position) {
    const sql = model.getValue();
    const offset = model.getOffsetAt(position);
    const result = engine.complete(sql, offset, { limit: 500 });
    return {
      // Recompute engine filtering and ranking for each changed prefix.
      incomplete: true,
      suggestions: result.suggestions.map((suggestion, index) => {
        const edit = completionEdit(sql, offset, result.replacementStart, suggestion);
        const start = model.getPositionAt(edit.replacementStart);
        const end = model.getPositionAt(edit.replacementEnd);
        return {
          label: { label: suggestion.label, description: suggestion.listDescription },
          kind: kinds[suggestion.kind] ?? monaco.languages.CompletionItemKind.Text,
          detail: suggestion.detail,
          insertText: edit.insertText,
          // Equal fuzzy scores let sortText preserve the engine's order.
          // Monaco still computes label highlights separately.
          filterText: sql.slice(edit.replacementStart, offset),
          insertTextRules: suggestion.kind === 'function'
            ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
          sortText: String(index).padStart(8, '0'),
          range: new monaco.Range(
            start.lineNumber, start.column, end.lineNumber, end.column
          )
        };
      })
    };
  }
});

monaco.languages.registerSignatureHelpProvider('sql', {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [','],
  provideSignatureHelp(model, position) {
    const help = engine.signatureHelp(model.getValue(), model.getOffsetAt(position));
    return help ? { value: help, dispose() {} } : null;
  }
});

export async function refreshSchema(force = false) {
  const response = await fetch(`/api/schema${force ? '?refresh=1' : ''}`);
  if (!response.ok) throw new Error(`Schema request failed: HTTP ${response.status}`);
  const snapshot = await response.json();
  engine = createCrabSense(snapshot);
  installKeywords(snapshot);
}

refreshSchema().catch(error => {
  // Show this in your app's status UI; completion otherwise uses the empty snapshot.
  console.error(error);
});

// Optional shortcut where Ctrl+Space is reserved by the operating system.
editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => {
  editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
});
```

Call `refreshSchema(true)` from a **Refresh schema** button after changing database objects, and show loading and error states around the request. If your API has no `?refresh=1` convention, replace that URL with your own. Store the completion and signature provider disposables and dispose them when an editor integration is torn down or hot reloaded.

## Why these settings

| Setting | Effect |
| --- | --- |
| SQL language configuration and Monarch tokenizer | Gives brackets, comments, string rules, and lexical highlighting. The snapshot's `keywords` replaces Monaco's generic list after loading; it does not validate SQL. |
| `triggerCharacters: ['.', ' ', '"', '(']` | Opens suggestions after qualifiers and clause words, including a starting quote and a CTE body parenthesis. |
| `quickSuggestions` outside comments and strings | Shows suggestions while an identifier is typed without inviting them in text literals. CrabSense also suppresses results inside ordinary comments and strings. |
| `wordBasedSuggestions: 'off'` and `showWords: false` | Keeps unrelated words from the current file out of the catalog list. |
| Snippet rule for functions | Makes the engine's `$1` argument placeholder an editable Monaco tab stop. |
| `completionEdit` and model positions | Preserves cursor offsets and correctly replaces a partially typed quoted identifier, including an auto closed quote. |

Monaco's bundled SQL language is generic. The PostgreSQL snapshot supplies the server's keyword list to both CrabSense completion and Monaco highlighting. `keywordCategories` also records each word's PostgreSQL category (`U`, `C`, `T`, or `R`); `R` means fully reserved. The demo displays those categories, but Monaco's lexical tokenizer colors all listed keywords alike. This is not grammar validation, and an unreserved keyword may also be a valid identifier in context. [PostgreSQL documents the categories](https://www.postgresql.org/docs/current/functions-info.html).

The demo's **What reaches the editor** inspector shows the full snapshot given to `createCrabSense`, the keyword list installed in Monaco, and the selected completion method's result plus its first ten mapped Monaco items at the cursor. Open a panel only when needed; large catalogs can produce large JSON payloads.

| Data | Source | Consumer |
| --- | --- | --- |
| Schemas, relations, columns, functions, built-in routines, settings | Permission-filtered PostgreSQL catalog queries in `/api/schema` | CrabSense's completion and signature engine |
| `keywords` | `pg_get_keywords()` on the connected PostgreSQL version | CrabSense keyword suggestions and Monaco's Monarch keyword list |
| `keywordCategories` | The same `pg_get_keywords()` result | Demo inspector; `R` is counted as fully reserved, but categories do not change token colors |
| SQL text and cursor offset | Monaco editor model | Browser-only completion engine; its suggestions are mapped to Monaco items and ranges |

The metadata endpoint never receives editor SQL. Updating syntax highlighting on a schema refresh replaces the tokenizer's keyword list once; it does not rerun catalog queries on every keystroke.

Monaco applies fuzzy scores before `sortText`. For example, lowercase `fr` can score higher against `from_sql` than uppercase `FROM`, reversing the engine's order. The adapter above gives every returned item the current typed prefix as `filterText`, producing equal fuzzy scores, then uses `sortText` for engine ranking. `localityBonus: false` disables another ranking factor, and `suggestSelection: 'first'` makes the first result the default selection. Labels, insertion text, and quote-aware ranges retain their actual values. Because this `filterText` represents the current prefix, the adapter always returns `incomplete: true` so typing asks the engine to filter and rank again. This runs completion against cached metadata locally; use a result limit to bound the popup. The package's own `incomplete` flag continues to mean that its result limit omitted matches.

The package treats `information_schema` and `pg_catalog` as ordinary metadata schemas; the demo's endpoint includes their accessible relations, and the package distinguishes `FROM pg_catalog.` relations from `pg_catalog.` routines in expressions.

## Syntax errors and scope

For PostgreSQL syntax markers, parse the editor text **in the browser** with a PostgreSQL parser and pass error positions to `monaco.editor.setModelMarkers(model, 'postgresql', markers)`. Debounce validation while typing, clear markers after a valid parse, and expect temporary errors for unfinished statements. The separate playground demonstrates this with an optional `libpg_query` WASM validator in [demo/src/main.js](../demo/src/main.js) and [demo/src/methods/validate.js](../demo/src/methods/validate.js). It splits ordinary SQL scripts at semicolons outside strings and comments, parses each statement, and shows multiple markers. It adds a focused hint when a `FROM` source is missing and retains the parser's error in the marker. Validation checks grammar, while CrabSense uses metadata for completion. Neither feature executes editor SQL.

For a production app, fetch a permission filtered snapshot for the current user, update it after schema changes, and keep SQL out of the metadata endpoint. CrabSense's context resolver is intentionally heuristic; review the [current limits](../README.md#limits) before relying on suggestions for complex nested queries.
