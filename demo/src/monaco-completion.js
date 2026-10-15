import { completionEdit } from 'crabsense';

/** Preserve the engine's order through Monaco's fuzzy scoring stage. */
export function monacoCompletionEdit(sql, offset, replacementStart, suggestion, index) {
  const edit = suggestion.nativeEdit
    ? { ...suggestion.nativeEdit, insertText: suggestion.insertText }
    : completionEdit(sql, offset, replacementStart, suggestion);
  return {
    ...edit,
    // The engine already filters candidates. Give every item the same match
    // score; Monaco can still highlight each actual label independently.
    filterText: sql.slice(edit.replacementStart, offset),
    sortText: String(index).padStart(8, '0')
  };
}
