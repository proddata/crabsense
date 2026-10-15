import express from 'express';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';

const app = express();
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.env.PORT || 3000);
const gzipAsync = promisify(gzip);

// PostgreSQL catalogs include views, materialized views, and PostgreSQL-specific types.
const relationsSql = `
  SELECT n.nspname AS schema, c.relname AS name,
    CASE c.relkind WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized view' ELSE 'table' END AS kind
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp_%'
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
  ORDER BY n.nspname, c.relname`;

const columnsSql = `
  SELECT n.nspname AS schema, c.relname AS relation, a.attname AS name,
    pg_catalog.format_type(a.atttypid, a.atttypmod) AS type
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm')
    AND a.attnum > 0 AND NOT a.attisdropped
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp_%'
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    AND pg_catalog.has_table_privilege(c.oid, 'SELECT')
  ORDER BY n.nspname, c.relname, a.attnum`;

const functionsSql = `
  SELECT n.nspname AS schema, p.proname AS name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.format_type(p.prorettype, NULL) AS returns
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE p.prokind = 'f'
    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp_%'
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
  ORDER BY n.nspname, p.proname`;

const typesSql = `
  SELECT n.nspname AS schema,
    CASE WHEN n.nspname = 'pg_catalog' THEN pg_catalog.format_type(t.oid, NULL)
      ELSE t.typname END AS name,
    t.typname AS "sqlName",
    CASE t.typtype WHEN 'd' THEN 'domain' WHEN 'e' THEN 'enum'
      WHEN 'c' THEN 'composite' WHEN 'r' THEN 'range'
      WHEN 'm' THEN 'multirange' ELSE 'base' END AS kind
  FROM pg_catalog.pg_type t
  JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typisdefined
    AND t.typtype IN ('b', 'c', 'd', 'e', 'r', 'm')
    AND t.typcategory <> 'A'
    AND n.nspname NOT LIKE 'pg_toast%'
    AND n.nspname NOT LIKE 'pg_temp_%'
    AND pg_catalog.has_schema_privilege(n.oid, 'USAGE')
    AND pg_catalog.has_type_privilege(t.oid, 'USAGE')
  ORDER BY n.nspname, name`;

const builtinFunctionsSql = `
  SELECT 'pg_catalog' AS schema, p.proname AS name,
    pg_catalog.pg_get_function_identity_arguments(p.oid) AS arguments,
    pg_catalog.format_type(p.prorettype, NULL) AS returns,
    CASE p.prokind WHEN 'a' THEN 'aggregate' WHEN 'w' THEN 'window function' ELSE 'function' END AS "routineKind"
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'pg_catalog'
    AND p.prokind IN ('f', 'a', 'w')
    AND pg_catalog.has_function_privilege(p.oid, 'EXECUTE')
  ORDER BY p.proname, arguments`;

const settingsSql = `
  SELECT name, short_desc AS description
  FROM pg_catalog.pg_settings
  ORDER BY name`;

const keywordsSql = `
  SELECT upper(word) AS word, catcode AS category
  FROM pg_catalog.pg_get_keywords()
  ORDER BY word`;

let cache = null;
let compressedCache = null;
let cachedAt = 0;
app.get('/api/schema', async (req, res) => {
  try {
    if (req.query.refresh === '1' || !cache || Date.now() - cachedAt > 30000) {
      const [relations, columns, functions, types, builtinFunctions, settings, keywords, currentSchema] = await Promise.all([
        pool.query(relationsSql), pool.query(columnsSql), pool.query(functionsSql), pool.query(typesSql),
        pool.query(builtinFunctionsSql), pool.query(settingsSql), pool.query(keywordsSql),
        pool.query('SELECT pg_catalog.current_schema() AS schema, pg_catalog.to_json(pg_catalog.current_schemas(true)) AS path')
      ]);
      const nextCache = {
        currentSchema: currentSchema.rows[0].schema,
        searchPath: currentSchema.rows[0].path,
        schemas: [...new Set([
          ...relations.rows.map(row => row.schema),
          ...functions.rows.map(row => row.schema),
          ...types.rows.map(row => row.schema)
        ])].sort((a, b) => {
          const priority = name => name === currentSchema.rows[0].schema ? 0 :
            name === 'information_schema' || name === 'pg_catalog' ? 2 : 1;
          return priority(a) - priority(b) || a.localeCompare(b);
        }),
        relations: relations.rows,
        columns: columns.rows,
        functions: functions.rows,
        types: types.rows,
        builtinFunctions: builtinFunctions.rows,
        settings: settings.rows,
        keywords: keywords.rows.map(row => row.word),
        keywordCategories: keywords.rows.map(row => ({ word: row.word, category: row.category }))
      };
      const nextCompressedCache = await gzipAsync(JSON.stringify(nextCache));
      cache = nextCache;
      compressedCache = nextCompressedCache;
      cachedAt = Date.now();
    }
    res.vary('Accept-Encoding');
    if (req.acceptsEncodings('gzip')) {
      res.type('json').set('Content-Encoding', 'gzip').send(compressedCache);
    } else {
      res.json(cache);
    }
  } catch (error) {
    console.error('Schema introspection failed:', error);
    res.status(503).json({ error: 'Schema is unavailable. Check the database connection.' });
  }
});

app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'database unavailable' });
  }
});

app.use(express.static(path.join(root, 'dist')));
app.get('*', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
app.listen(port, '0.0.0.0', () => console.log(`CrabSense listening on ${port}`));
