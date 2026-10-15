// Deterministic single-statement fixtures. Expectations follow catalog bindings,
// never another engine's output. § marks the editor cursor.
export const stressMetadata = {
  currentSchema: 'public', schemas: ['public', 'harbor'],
  relations: [{ schema: 'public', name: 'sailors', kind: 'table' }, { schema: 'harbor', name: 'voyages', kind: 'table' }],
  columns: [
    { schema: 'public', relation: 'sailors', name: 'id', type: 'integer' },
    { schema: 'public', relation: 'sailors', name: 'handle', type: 'text' },
    { schema: 'harbor', relation: 'voyages', name: 'id', type: 'integer' },
    { schema: 'harbor', relation: 'voyages', name: 'destination', type: 'text' }
  ], functions: [], builtinFunctions: []
};

function fixture(family, scale, marked, wanted, forbidden = [], replacement = '') {
  const offset = marked.indexOf('§');
  if (offset < 0 || marked.indexOf('§', offset + 1) >= 0) throw new Error('Fixture needs exactly one cursor');
  const sql = marked.replace('§', '');
  const prefix = sql.slice(0, offset).match(/[A-Za-z_]*$/)[0];
  return { name: `${family}/${scale}`, family, scale, sql, offset, prefix, wanted, forbidden,
    validSql: sql.slice(0, offset - prefix.length) + replacement + sql.slice(offset) };
}

function ctes(count) {
  const parts = ['step_0 AS (SELECT id, handle FROM public.sailors)'];
  for (let i = 1; i < count; i++) parts.push(`step_${i} AS (
    SELECT id, handle, row_number() OVER (PARTITION BY id ORDER BY handle) AS position
    FROM step_${i - 1} WHERE id >= 0
  )`);
  return `WITH ${parts.join(',\n')}\n`;
}

export function queryStressFixtures({ large = false } = {}) {
  const fixtures = [];
  for (const size of large ? [10, 50, 150] : [5, 20, 50]) {
    const head = ctes(size);
    fixtures.push(fixture('chained CTE', size,
      `${head}SELECT q.ha§ FROM step_${size - 1} q ORDER BY q.id`, ['handle'], ['destination'], 'handle'));
    const joins = Array.from({ length: size }, (_, i) => `LEFT JOIN harbor.voyages v${i} ON v${i}.id = s.id`).join('\n');
    fixtures.push(fixture('many joins', size,
      `SELECT v${size - 1}.de§ FROM public.sailors s\n${joins}\nWHERE s.id > 0`, ['destination'], ['handle'], 'destination'));
    const body = `SELECT s.id, s.handle, v.destination,
      count(*) FILTER (WHERE v.id > 0) OVER (PARTITION BY s.id) AS voyage_count,
      row_number() OVER w AS rank
      FROM public.sailors s
      LEFT JOIN LATERAL (SELECT id, destination FROM harbor.voyages WHERE id = s.id ORDER BY id LIMIT 1) v ON true
      WINDOW w AS (PARTITION BY s.id ORDER BY v.id)`;
    fixtures.push(fixture('CTE lateral window union', size,
      `${head}, report AS (${body})
      SELECT r.ha§ FROM report r
      WHERE EXISTS (SELECT 1 FROM step_${size - 1} c WHERE c.id = r.id)
      UNION ALL SELECT handle FROM step_${size - 1} ORDER BY 1`, ['handle'], ['destination'], 'handle'));
    // Incomplete source names near the middle of a substantial statement.
    fixtures.push(fixture('incomplete JOIN edit', size,
      `${head}SELECT s.id FROM public.sailors s JOIN harbor.vo§ ON true
      WHERE EXISTS (SELECT 1 FROM step_${size - 1} q WHERE q.id = s.id)`, ['voyages'], ['sailors'], 'voyages'));
  }
  for (const depth of large ? [10, 40, 128] : [5, 15, 40]) {
    let inner = 'SELECT s.de§ FROM harbor.voyages s WHERE s.id > 0';
    for (let i = 0; i < depth; i++) inner = `SELECT s.id FROM public.sailors s WHERE EXISTS (${inner})`;
    fixtures.push(fixture('nested alias shadow', depth, inner, ['destination'], ['handle'], 'destination'));
    let correlated = 'SELECT root.ha§ FROM harbor.voyages deepest';
    for (let i = 0; i < depth; i++) correlated = `SELECT 1 FROM harbor.voyages level_${i} WHERE EXISTS (${correlated})`;
    fixtures.push(fixture('deep correlated outer alias', depth,
      `SELECT 1 FROM public.sailors root WHERE EXISTS (${correlated})`, ['handle'], ['destination'], 'handle'));
    let unfinished = 'SELECT 1 FROM harbor.voyages s WHERE s.de§';
    for (let i = 0; i < depth; i++) unfinished = `SELECT 1 FROM public.sailors s WHERE EXISTS (${unfinished}`;
    const editing = fixture('unfinished nested edit', depth, unfinished, ['destination'], ['handle'], 'destination');
    editing.validSql += ')'.repeat(depth);
    fixtures.push(editing);
    let exists = 'SELECT 1 FROM harbor.voyages v WHERE v.id = root.id';
    for (let i = 0; i < depth; i++) exists = `SELECT 1 FROM public.sailors inner_${i} WHERE EXISTS (${exists})`;
    fixtures.push(fixture('outer scope after subqueries', depth,
      `SELECT root.ha§ FROM public.sailors root WHERE EXISTS (${exists})`, ['handle'], ['destination'], 'handle'));
  }
  for (const width of large ? [100, 1000, 5000] : [100, 500, 1500]) {
    const projections = Array.from({ length: width }, (_, i) =>
      `coalesce(s.handle, $tag$FROM; SELECT /* ) */$tag$) AS label_${i}`).join(',\n');
    fixtures.push(fixture('wide projection', width,
      `SELECT s.ha§,\n${projections}\nFROM public.sailors s WHERE s.id IN (SELECT id FROM harbor.voyages)`, ['handle'], ['destination'], 'handle'));
  }
  return fixtures;
}

export function checkStressResult(result, fixture, offset = fixture.offset, prefix = fixture.prefix) {
  const problems = [];
  for (const wanted of fixture.wanted) {
    const candidate = result.suggestions.find(item => item.label.replaceAll('"', '') === wanted);
    if (!candidate) { problems.push(`missing ${wanted}`); continue; }
    const start = candidate.nativeEdit?.replacementStart ?? result.replacementStart;
    const end = candidate.nativeEdit?.replacementEnd ?? offset;
    if (start !== offset - prefix.length || end !== offset) problems.push(`incorrect edit range for ${wanted}: ${start}..${end}`);
  }
  for (const forbidden of fixture.forbidden) {
    if (result.suggestions.some(item => item.label.replaceAll('"', '') === forbidden)) problems.push(`unexpected ${forbidden}`);
  }
  return problems;
}
