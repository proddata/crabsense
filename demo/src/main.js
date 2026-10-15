import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController.js';
import { conf as sqlConfiguration, language as sqlLanguage } from 'monaco-editor/esm/vs/basic-languages/sql/sql.js';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import CompletionWorker from './completion.worker.js?worker';
import { createCrabSense } from '@proddata/crabsense';
import { monacoCompletionEdit } from './monaco-completion.js';
import { createCompletionWorkerClient } from './completion-worker-client.js';
import { postgresKeywordData } from './postgres-keywords.js';
import { examples } from './examples.js';
import './style.css';

self.MonacoEnvironment = { getWorker: () => new EditorWorker() };

// Use Monaco's SQL lexical rules, replacing its generic keyword list when the
// database snapshot arrives. No editor SQL is needed for this metadata.
monaco.languages.register({ id: 'sql', extensions: ['.sql'], aliases: ['SQL'] });
monaco.languages.setLanguageConfiguration('sql', sqlConfiguration);
let keywordData = postgresKeywordData({}, sqlLanguage.keywords);
let highlighting = monaco.languages.setMonarchTokensProvider('sql', { ...sqlLanguage, keywords: keywordData.keywords });
function installPostgresHighlighting(snapshot) {
  const next = postgresKeywordData(snapshot, sqlLanguage.keywords);
  highlighting.dispose();
  keywordData = next;
  highlighting = monaco.languages.setMonarchTokensProvider('sql', { ...sqlLanguage, keywords: next.keywords });
}

const sample = examples[0].sql;

document.querySelector('#app').innerHTML = `
  <header class="topbar">
    <div class="brand"><span class="crab" aria-hidden="true">🦀</span><strong>CrabSense</strong><span class="brand-subtitle">SQL completion playground</span></div>
    <div class="top-actions"><span id="status" class="status">Connecting…</span><button id="refresh" type="button">Refresh schema</button></div>
  </header>
  <main class="layout">
    <section class="workspace" aria-label="SQL editor">
      <div class="controls"><label for="method">Completion</label><select id="method"><option value="crabsense">CrabSense</option><option value="codemirror">CodeMirror SQL</option></select><label for="example">Example</label><select id="example"><option value="">Choose an example…</option>${examples.map((example, index) => `<option value="${index}"${index === 0 ? ' selected' : ''}>${example.label}</option>`).join('')}</select><button id="new-query" type="button">New query</button><label class="validation-toggle"><input id="validate" type="checkbox"> Validate syntax</label></div>
      <div class="editor-shell"><div class="editor-toolbar"><span class="file-dot" aria-hidden="true"></span><span>query.sql</span><span class="editor-help">Try <code>FROM</code>, <code>s.</code>, or <code>harbor.</code></span><button id="suggest" type="button" aria-label="Show SQL suggestions" aria-keyshortcuts="Control+Enter Meta+Enter">Show suggestions <span class="shortcut-hint">⌘/Ctrl+Enter</span></button></div><div id="editor"></div></div>
      <div class="editor-messages"><p id="method-note" class="method-note" role="status" aria-live="polite">CrabSense: catalog-aware completion.</p><p id="validation-status" class="validation-status" role="status" aria-live="polite"></p></div>
      <details id="comparison-panel" class="utility-panel"><summary>Compare completion methods <span>At the current cursor</span></summary><div id="comparison-grid" class="comparison-grid"></div></details>
      <details class="utility-panel"><summary>Inspect editor metadata <span id="data-summary">Waiting for database metadata…</span></summary><div class="data-details"><details id="snapshot-detail"><summary>Completion engine snapshot</summary><pre id="snapshot-json"></pre></details><details id="monaco-detail"><summary>Monaco keyword input</summary><pre id="monaco-json"></pre></details><details id="suggestions-detail"><summary>At cursor: engine → Monaco</summary><pre id="suggestions-json"></pre></details></div></details>
    </section>
    <aside class="sidebar" aria-label="Database objects"><div class="sidebar-heading"><h2>Database objects</h2><label class="sr-only" for="object-search">Find an object</label><input id="object-search" class="object-search" type="search" placeholder="Search tables, columns, functions…" autocomplete="off"><p id="counts">Loading schema…</p><p id="object-results" class="object-results" role="status" aria-live="polite"></p></div><div id="objects" class="objects"></div></aside>
  </main>
  <footer>Local demo · SQL stays in this browser</footer>`;

const editor = monaco.editor.create(document.getElementById('editor'), {
  value: sample,
  language: 'sql',
  theme: 'vs-dark',
  automaticLayout: true,
  fontSize: 14,
  lineHeight: 24,
  minimap: { enabled: false },
  padding: { top: 18, bottom: 18 },
  scrollBeyondLastLine: false,
  suggest: { showWords: false, localityBonus: false },
  suggestSelection: 'first',
  quickSuggestions: { other: true, comments: false, strings: false },
  quickSuggestionsDelay: 75,
  wordBasedSuggestions: 'off'
});

function showSuggestions() {
  editor.focus();
  editor.trigger('keyboard', 'editor.action.triggerSuggest', {});
}

editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, showSuggestions);
document.getElementById('suggest').addEventListener('click', showSuggestions);
document.getElementById('example').addEventListener('change', () => {
  if (document.getElementById('example').value === '') return;
  const example = examples[Number(document.getElementById('example').value)];
  editor.setValue(example.sql);
  const offset = example.sql.indexOf(example.cursorAfter) + example.cursorAfter.length;
  const position = editor.getModel().getPositionAt(offset);
  editor.setPosition(position);
  editor.revealPositionInCenter(position);
  showSuggestions();
});
document.getElementById('new-query').addEventListener('click', () => {
  document.getElementById('example').value = '';
  editor.setValue('');
  editor.focus();
});

let metadata = { schemas: [], relations: [], columns: [], functions: [], types: [], builtinFunctions: [], settings: [], keywords: [] };
let crabsense = createCrabSense(metadata);
const completionWorker = createCompletionWorkerClient(new CompletionWorker());
completionWorker.setMetadata(metadata).catch(error => console.error('Completion worker:', error));
let hasSnapshot = false;
const methodSelect = document.getElementById('method');
const methodNote = document.getElementById('method-note');
const validationToggle = document.getElementById('validate');
const validationStatus = document.getElementById('validation-status');
let validationTimer;
let validationRun = 0;
let comparisonTimer;
let comparisonRun = 0;
const methods = [
  { id: 'crabsense', label: 'CrabSense' },
  { id: 'codemirror', label: 'CodeMirror SQL' }
];
const comparisonGrid = document.getElementById('comparison-grid');
const comparisonPanel = document.getElementById('comparison-panel');
comparisonGrid.innerHTML = methods.map(method =>
  `<article class="comparison-card" aria-label="${method.label} suggestions"><h3>${method.label}</h3><p class="comparison-state">Loading…</p></article>`
).join('');
const comparisonCards = [...comparisonGrid.children];
const comparisonHtml = [];
const comparisonPreviewLimit = 60;
const monacoSuggestionLimit = 500;
const objectPreviewLimit = 200;
const snapshotDetail = document.getElementById('snapshot-detail');
const monacoDetail = document.getElementById('monaco-detail');
const suggestionsDetail = document.getElementById('suggestions-detail');
const pretty = value => JSON.stringify(value, null, 2);

function renderDataInspector() {
  const categories = metadata.keywordCategories || [];
  document.getElementById('data-summary').textContent = hasSnapshot
    ? `${metadata.relations.length} relations · ${metadata.columns.length} columns · ${metadata.types?.length || 0} types · ${metadata.functions.length + metadata.builtinFunctions.length} routines · ${keywordData.keywords.length} Monaco keywords · ${keywordData.reservedKeywords.length} reserved`
    : 'Waiting for database metadata; Monaco is using generic SQL keywords.';
  if (snapshotDetail.open) document.getElementById('snapshot-json').textContent = pretty(metadata);
  if (monacoDetail.open) document.getElementById('monaco-json').textContent = pretty({
    language: 'sql', tokenizer: 'Monaco SQL Monarch', keywords: keywordData.keywords,
    reservedKeywordsInSnapshot: keywordData.reservedKeywords,
    categoryCounts: Object.fromEntries(['U', 'C', 'T', 'R'].map(code => [code, categories.filter(entry => entry.category === code).length])),
    completionProvider: { triggerCharacters: ['.', ' ', '"', '('], source: 'CrabSense or independent CodeMirror SQL completion sources' }
  });
}
for (const detail of [snapshotDetail, monacoDetail]) detail.addEventListener('toggle', renderDataInspector);
suggestionsDetail.addEventListener('toggle', scheduleComparison);

function completionFor(method, sql, offset, options, token) {
  return completionWorker.complete(method, sql, offset, options, token);
}

async function renderComparison(run) {
  const sql = editor.getValue();
  const offset = editor.getModel().getOffsetAt(editor.getPosition());
  const results = await Promise.allSettled(methods.map(method =>
    completionFor(method.id, sql, offset, { limit: monacoSuggestionLimit })));
  if (run !== comparisonRun) return;
  if (results.some(result => result.status === 'fulfilled' && !result.value)) return;
  results.forEach((result, index) => {
    const method = methods[index];
    let html;
    if (result.status === 'rejected') {
      html = `<h3>${method.label}</h3><p class="comparison-state error">Unavailable: ${escapeHtml(result.reason?.message || result.reason)}</p>`;
    } else {
      const { context, suggestions, incomplete } = result.value;
      const count = `${suggestions.length}${incomplete ? '+' : ''}`;
      const rows = suggestions.slice(0, comparisonPreviewLimit).map(s => `<li><span class="comparison-kind">${escapeHtml(s.kind)}</span><span class="comparison-label">${escapeHtml(s.label)}</span><small>${escapeHtml(s.listDescription || s.detail)}</small></li>`).join('');
      const more = suggestions.length > comparisonPreviewLimit
        ? `<li class="comparison-more">Showing first ${comparisonPreviewLimit} of ${count} suggestions.</li>` : '';
      html = `<h3>${method.label}<span>${count}</span></h3><p class="comparison-state">${escapeHtml(context)}</p>${suggestions.length ? `<ul>${rows}${more}</ul>` : '<p class="comparison-empty">No suggestions at this cursor.</p>'}`;
    }
    if (html !== comparisonHtml[index]) {
      comparisonCards[index].innerHTML = html;
      comparisonHtml[index] = html;
    }
  });
  if (suggestionsDetail.open) {
    const selected = results[methods.findIndex(method => method.id === methodSelect.value)];
    document.getElementById('suggestions-json').textContent = selected.status === 'fulfilled'
      ? pretty({ engine: methods.find(method => method.id === methodSelect.value).label,
        capabilities: selected.value.capabilities || { context: true, ranking: true },
        nativeCandidateCount: selected.value.nativeCandidateCount,
        cursorOffset: offset, context: selected.value.context,
        replacementStart: selected.value.replacementStart,
        returnedSuggestions: selected.value.suggestions.length,
        moreSuggestions: selected.value.incomplete,
        comparisonLimit: monacoSuggestionLimit,
        monacoPopupLimit: monacoSuggestionLimit,
        monacoListIncomplete: true,
        firstTenEngineSuggestions: selected.value.suggestions.slice(0, 10),
        firstTenMonacoItems: selected.value.suggestions.slice(0, 10).map((suggestion, index) =>
          toMonacoItem(editor.getModel(), sql, offset, selected.value.replacementStart, suggestion, index)) })
      : `Unavailable: ${selected.reason?.message || selected.reason}`;
  }
}

function scheduleComparison() {
  clearTimeout(comparisonTimer);
  const run = ++comparisonRun;
  if (!comparisonPanel.open && !suggestionsDetail.open) return;
  comparisonCards.forEach((card, index) => card.classList.toggle('active', methods[index].id === methodSelect.value));
  comparisonTimer = setTimeout(() => renderComparison(run), 160);
}
comparisonPanel.addEventListener('toggle', scheduleComparison);

methodSelect.addEventListener('change', async () => {
  const method = methodSelect.value;
  methodNote.classList.remove('error');
  methodNote.textContent = {
    crabsense: 'CrabSense: catalog-aware completions, draft tables, CTE columns, and function signatures.',
    codemirror: 'CodeMirror SQL: independent PostgreSQL completion sources. Prefix filtering for Monaco; native popup ranking is not compared.'
  }[method];
  if (methodSelect.value === method) showSuggestions();
  scheduleComparison();
});

async function runValidation() {
  const run = ++validationRun;
  const model = editor.getModel();
  const sql = model.getValue();
  validationStatus.classList.remove('error', 'valid');
  validationStatus.textContent = 'Checking PostgreSQL syntax locally…';
  try {
    const { validateSql } = await import('./methods/validate.js');
    const result = await validateSql(sql);
    if (run !== validationRun || !validationToggle.checked) return;
    if (result.valid) {
      monaco.editor.setModelMarkers(model, 'libpg_query', []);
      validationStatus.textContent = result.empty ? 'Nothing to validate.' : '✓ PostgreSQL syntax valid';
      validationStatus.classList.add('valid');
    } else {
      const errors = result.errors || [result];
      monaco.editor.setModelMarkers(model, 'libpg_query', errors.map(error => {
        const start = Math.min(error.offset, Math.max(0, sql.length - 1));
        const from = model.getPositionAt(start);
        const to = model.getPositionAt(Math.min(sql.length, start + 1));
        return {
          startLineNumber: from.lineNumber, startColumn: from.column,
          endLineNumber: to.lineNumber, endColumn: to.column,
          message: error.hint ? `${error.hint}\nPostgreSQL: ${error.message}` : error.message,
          severity: monaco.MarkerSeverity.Error
        };
      }));
      validationStatus.textContent = errors.length === 1
        ? `Syntax: ${result.hint || result.message}`
        : `${errors.length} syntax errors · First: ${result.hint || result.message}`;
      validationStatus.classList.add('error');
    }
  } catch (error) {
    if (run !== validationRun || !validationToggle.checked) return;
    validationStatus.textContent = `Validator unavailable: ${error.message}`;
    validationStatus.classList.add('error');
    console.error(error);
  }
}

function scheduleValidation() {
  clearTimeout(validationTimer);
  if (validationToggle.checked) validationTimer = setTimeout(runValidation, 350);
}

validationToggle.addEventListener('change', () => {
  if (validationToggle.checked) runValidation();
  else {
    clearTimeout(validationTimer);
    validationRun++;
    monaco.editor.setModelMarkers(editor.getModel(), 'libpg_query', []);
    validationStatus.textContent = 'Syntax validation is off.';
    validationStatus.classList.remove('error', 'valid');
  }
});
editor.onDidChangeModelContent(() => {
  scheduleValidation();
  scheduleComparison();
});
editor.onDidChangeCursorPosition(scheduleComparison);

const kind = {
  table: monaco.languages.CompletionItemKind.Struct,
  cte: monaco.languages.CompletionItemKind.Struct,
  alias: monaco.languages.CompletionItemKind.Variable,
  view: monaco.languages.CompletionItemKind.Reference,
  'materialized view': monaco.languages.CompletionItemKind.Reference,
  schema: monaco.languages.CompletionItemKind.Module,
  column: monaco.languages.CompletionItemKind.Field,
  function: monaco.languages.CompletionItemKind.Function,
  type: monaco.languages.CompletionItemKind.Class,
  setting: monaco.languages.CompletionItemKind.Property,
  keyword: monaco.languages.CompletionItemKind.Keyword
};

function toMonacoItem(model, sql, offset, replacementStart, suggestion, index) {
  const edit = monacoCompletionEdit(sql, offset, replacementStart, suggestion, index);
  const start = model.getPositionAt(edit.replacementStart);
  const end = model.getPositionAt(edit.replacementEnd);
  return {
    label: { label: suggestion.label, description: suggestion.listDescription },
    kind: kind[suggestion.kind] || monaco.languages.CompletionItemKind.Text,
    insertText: edit.insertText,
    filterText: edit.filterText,
    insertTextRules: suggestion.kind === 'function' ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
    detail: suggestion.detail,
    sortText: edit.sortText,
    range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column)
  };
}

monaco.languages.registerCompletionItemProvider('sql', {
  triggerCharacters: ['.', ' ', '"', '('],
  async provideCompletionItems(model, position, _context, token) {
    const offset = model.getOffsetAt(position);
    const sql = model.getValue();
    const version = model.getVersionId();
    const method = methodSelect.value;
    let result;
    try {
      result = await completionFor(method, sql, offset, { limit: monacoSuggestionLimit }, token);
    } catch (error) {
      methodNote.textContent = `Completion method unavailable: ${error.message}`;
      methodNote.classList.add('error');
      console.error(error);
      return { suggestions: [] };
    }
    if (!result || token.isCancellationRequested || model.getVersionId() !== version || methodSelect.value !== method) return { suggestions: [] };
    return {
      suggestions: result.suggestions.slice(0, monacoSuggestionLimit).map((suggestion, index) =>
        toMonacoItem(model, sql, offset, result.replacementStart, suggestion, index)),
      // filterText represents this prefix only, so ask the engine again when
      // typing changes it, even when the package returned every match.
      incomplete: true
    };
  }
});

monaco.languages.registerSignatureHelpProvider('sql', {
  signatureHelpTriggerCharacters: ['(', ','],
  signatureHelpRetriggerCharacters: [','],
  provideSignatureHelp(model, position) {
    if (methodSelect.value !== 'crabsense') return null;
    const help = crabsense.signatureHelp(model.getValue(), model.getOffsetAt(position));
    if (!help) return null;
    return {
      value: help,
      dispose() {}
    };
  }
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function sqlIdentifier(value) {
  return /^[a-z_][a-z_0-9]*$/.test(value) ? value : `"${value.replaceAll('"', '""')}"`;
}

let objectIndex = { relations: new Map(), functions: new Map(), types: new Map(), columns: new Map() };
function indexObjects() {
  const relations = new Map(metadata.schemas.map(schema => [schema, []]));
  const functions = new Map(metadata.schemas.map(schema => [schema, []]));
  const types = new Map(metadata.schemas.map(schema => [schema, []]));
  const columns = new Map();
  for (const relation of metadata.relations) relations.get(relation.schema)?.push(relation);
  for (const fn of metadata.functions) functions.get(fn.schema)?.push(fn);
  for (const type of metadata.types || []) types.get(type.schema)?.push(type);
  for (const column of metadata.columns) {
    const key = `${column.schema}\0${column.relation}`;
    if (!columns.has(key)) columns.set(key, []);
    columns.get(key).push(column);
  }
  objectIndex = { relations, functions, types, columns };
}

function renderObjects() {
  document.getElementById('counts').textContent = `${metadata.schemas.length} schemas · ${metadata.relations.length} relations · ${metadata.functions.length} user functions`;
  const query = document.getElementById('object-search').value.trim().toLowerCase();
  let matches = 0;
  let shown = 0;
  const schemas = query ? metadata.schemas : metadata.schemas.filter(schema => !['pg_catalog', 'information_schema'].includes(schema));
  const sections = schemas.map(schema => {
    const schemaMatches = schema.toLowerCase().includes(query);
    const relations = (objectIndex.relations.get(schema) || []).filter(r => schemaMatches || r.name.toLowerCase().includes(query) || (objectIndex.columns.get(`${schema}\0${r.name}`) || []).some(column => column.name.toLowerCase().includes(query)));
    const functions = (objectIndex.functions.get(schema) || []).filter(f => schemaMatches || f.name.toLowerCase().includes(query));
    const types = (objectIndex.types.get(schema) || []).filter(type => query
      ? schemaMatches || type.name.toLowerCase().includes(query)
      : type.kind !== 'composite');
    matches += relations.length + functions.length + types.length;
    const available = Math.max(0, objectPreviewLimit - shown);
    const visibleRelations = relations.slice(0, available);
    shown += visibleRelations.length;
    const visibleFunctions = functions.slice(0, Math.max(0, objectPreviewLimit - shown));
    shown += visibleFunctions.length;
    const visibleTypes = types.slice(0, Math.max(0, objectPreviewLimit - shown));
    shown += visibleTypes.length;
    if (!visibleRelations.length && !visibleFunctions.length && !visibleTypes.length) {
      return relations.length || functions.length || types.length
        ? `<section class="schema"><h3>${escapeHtml(schema)}</h3><p class="object-results">Narrow your search to explore this schema.</p></section>`
        : '';
    }
    return `<section class="schema"><h3>${escapeHtml(schema)}</h3>${visibleRelations.map(r => {
      const cols = objectIndex.columns.get(`${schema}\0${r.name}`) || [];
      return `<details class="object"><summary><span class="object-icon">${r.kind === 'table' ? '▤' : '◫'}</span><span class="object-name">${escapeHtml(r.name)}</span><small>${escapeHtml(r.kind)}</small></summary><div class="object-body"><button type="button" class="insert-button" data-insert="${escapeHtml(`${sqlIdentifier(schema)}.${sqlIdentifier(r.name)}`)}" aria-label="Insert ${escapeHtml(r.name)} into editor">Insert relation</button><ul>${cols.map(c => `<li><span>${escapeHtml(c.name)} <em>${escapeHtml(c.type)}</em></span><button type="button" class="insert-button" data-insert="${escapeHtml(sqlIdentifier(c.name))}" aria-label="Insert ${escapeHtml(c.name)} into editor">Insert</button></li>`).join('')}</ul></div></details>`;
    }).join('')}${visibleFunctions.map(f => `<div class="function-row"><span class="object-icon">ƒ</span><span class="object-name">${escapeHtml(f.name)}()</span><button type="button" class="insert-button" data-insert="${escapeHtml(`${sqlIdentifier(schema)}.${sqlIdentifier(f.name)}()`)}" aria-label="Insert ${escapeHtml(f.name)} into editor">Insert</button></div>`).join('')}${visibleTypes.map(type => `<div class="function-row"><span class="object-icon">◇</span><span class="object-name">${escapeHtml(type.name)}</span><small>${escapeHtml(type.kind)} type</small></div>`).join('')}</section>`;
  }).join('');
  document.getElementById('object-results').textContent = matches
    ? query ? `${shown} of ${matches} matches${shown < matches ? ' · narrow the search for more' : ''}` : `${shown} demo objects · search to include system schemas`
    : query ? 'No matching objects' : 'No demo objects available';
  document.getElementById('objects').innerHTML = sections;
}

document.getElementById('objects').addEventListener('click', event => {
  const button = event.target.closest('button[data-insert]');
  if (!button) return;
  event.preventDefault();
  const range = editor.getSelection();
  editor.executeEdits('object-explorer', [{ range, text: button.dataset.insert, forceMoveMarkers: true }]);
  editor.focus();
});

let objectSearchTimer;
document.getElementById('object-search').addEventListener('input', () => {
  clearTimeout(objectSearchTimer);
  objectSearchTimer = setTimeout(renderObjects, 120);
});

let schemaLoadRun = 0;
async function loadSchema(refresh = false) {
  const run = ++schemaLoadRun;
  const status = document.getElementById('status');
  status.textContent = 'Connecting…';
  status.classList.remove('error');
  try {
    const response = await fetch(`/api/schema${refresh ? '?refresh=1' : ''}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = await response.json();
    if (run !== schemaLoadRun) return;
    const ready = await completionWorker.setMetadata(snapshot);
    if (run !== schemaLoadRun || !ready) return;
    metadata = snapshot;
    crabsense = createCrabSense(metadata);
    installPostgresHighlighting(metadata);
    hasSnapshot = true;
    indexObjects();
    renderObjects();
    renderDataInspector();
    status.textContent = '● Schema connected';
    scheduleComparison();
  } catch (error) {
    if (run !== schemaLoadRun) return;
    status.textContent = '● Schema unavailable';
    status.classList.add('error');
    document.getElementById('counts').textContent = 'Could not load database objects';
    if (!hasSnapshot) document.getElementById('data-summary').textContent = 'Metadata unavailable; Monaco is using generic SQL keywords.';
    console.error(error);
  }
}

document.getElementById('refresh').addEventListener('click', () => loadSchema(true));
loadSchema();
scheduleComparison();
