import test from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'libpg-query';
import { createCrabSense } from 'crabsense';
import { queryStressFixtures, stressMetadata, checkStressResult } from '../fixtures/query-stress.js';

const engine = createCrabSense(stressMetadata);
for (const fixture of queryStressFixtures()) {
  test(`single-statement stress: ${fixture.name}`, async () => {
    await assert.doesNotReject(() => parse(fixture.validSql), 'Completed scaffold must be PostgreSQL syntax');
    const result = engine.complete(fixture.sql, fixture.offset, { limit: 500 });
    assert.deepEqual(checkStressResult(result, fixture), [], fixture.name);
    // Simulate another letter without changing the expected SQL binding.
    const extra = fixture.wanted[0][fixture.prefix.length];
    const sql = fixture.sql.slice(0, fixture.offset) + extra + fixture.sql.slice(fixture.offset);
    const edited = engine.complete(sql, fixture.offset + 1, { limit: 500 });
    assert.deepEqual(checkStressResult(edited, fixture, fixture.offset + 1, fixture.prefix + extra), []);
  });
}
