// PostgreSQL's pg_get_keywords() is dialect metadata, independent of the
// user's tables and privileges. Keep the editor input separate from the
// completion engine's catalog snapshot.
export function postgresKeywordData(snapshot, fallbackKeywords = []) {
  const supplied = Array.isArray(snapshot?.keywords) && snapshot.keywords.length
    ? snapshot.keywords : fallbackKeywords;
  const keywords = [...new Set(supplied.filter(word => typeof word === 'string').map(word => word.toUpperCase()))];
  const categoryByWord = new Map((snapshot?.keywordCategories || [])
    .filter(entry => typeof entry?.word === 'string' && /^[UCTR]$/.test(entry.category))
    .map(entry => [entry.word.toUpperCase(), entry.category]));
  const reservedKeywords = keywords.filter(word => categoryByWord.get(word) === 'R');
  return { keywords, reservedKeywords };
}
