import test from 'node:test';
import assert from 'node:assert/strict';
import { postgresKeywordData } from '../src/postgres-keywords.js';

test('PostgreSQL keyword snapshot replaces Monaco fallback and preserves reserved category', () => {
  assert.deepEqual(postgresKeywordData({
    keywords: ['select', 'ILIKE', 'select'],
    keywordCategories: [
      { word: 'select', category: 'R' },
      { word: 'ILIKE', category: 'U' }
    ]
  }, ['GENERIC']), { keywords: ['SELECT', 'ILIKE'], reservedKeywords: ['SELECT'] });
  assert.deepEqual(postgresKeywordData({}, ['select']), { keywords: ['SELECT'], reservedKeywords: [] });
});
