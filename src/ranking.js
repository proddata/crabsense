const expressionStarters = new Set(['NULL', 'TRUE', 'FALSE', 'CASE', 'EXISTS', 'NOT']);
const matchName = suggestion => suggestion.filterText || suggestion.label;

/** Rank already-valid candidates, deduplicate them, then apply the result cap. */
export function rankSuggestions(suggestions, { search, context, preferredKeyword, limit }) {
  const matching = suggestions.filter(suggestion => matchName(suggestion).toLowerCase().startsWith(search));
  if (search) {
    const preferred = suggestion => suggestion.kind === 'keyword' && suggestion.label.toUpperCase() === preferredKeyword;
    const starter = suggestion => !preferredKeyword && ['projection', 'expression'].includes(context) &&
      suggestion.kind === 'keyword' && expressionStarters.has(suggestion.label.toUpperCase());
    matching.sort((a, b) => Number(preferred(b)) - Number(preferred(a)) ||
      Number(starter(b)) - Number(starter(a)) || matchName(a).length - matchName(b).length);
  }
  const unique = new Map();
  for (const suggestion of matching) {
    unique.set(`${suggestion.kind}:${suggestion.label}:${suggestion.detail}`, suggestion);
    if (unique.size > limit) break;
  }
  return { suggestions: [...unique.values()].slice(0, limit), incomplete: unique.size > limit };
}
