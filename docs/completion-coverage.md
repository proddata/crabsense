# Completion behavior and boundaries

This page expands on the [README's feature summary](../README.md#what-it-completes). CrabSense resolves SQL at the cursor against a permission-filtered catalog snapshot and, where supported, objects declared earlier in the editor. It does not execute SQL.

## Relations and query scopes

- After `FROM` or `JOIN`, completion offers visible relations and schemas. A relation alias hides the original relation name in that query. Unaliased self-join sources remain separately qualified.
- `alias.` and `table.` offer columns from the resolved relation. A schema qualifier offers that schema's relations and functions. An effective `searchPath` controls unqualified relation, type, and routine lookup; names outside it receive qualified insertions.
- `UNION`, `UNION ALL`, `INTERSECT`, and `EXCEPT` branches have separate relation bindings. A combined query's trailing `ORDER BY` offers output names from the first branch, including aliases and expanded stars, instead of input-only columns.
- Scalar and `EXISTS` subqueries retain legal outer aliases. Ordinary `FROM` subqueries hide immediate parent sources; `LATERAL` subqueries see preceding sources. Inner aliases take precedence when they reuse an outer name.
- `ON` and `USING` suggestions use the active JOIN operands, including parenthesized JOIN groups. A parenthesized JOIN's result alias exposes its columns and hides operand names; an unaliased group retains operand qualifiers. Chained `USING` and `NATURAL` joins merge shared output names. Incomplete JOIN trees are not fully resolved.

## CTEs, derived tables, functions, and draft objects

- Completed CTEs and simple derived tables contribute projected columns. Nested `WITH` clauses keep local names; earlier nonrecursive CTEs are visible in later definitions. `WITH RECURSIVE` can resolve forward siblings and infer output names from an anchor `SELECT` or explicit output list.
- While entering a CTE header, `WITH acs a` offers `AS`; `WITH acs AS (` offers query starters such as `SELECT`.
- Catalog-backed table functions contribute columns inside JOIN trees. Function arguments can see preceding sources, even without `LATERAL`, but not later aliases. Record functions with explicit column definitions, `ROWS FROM`, `WITH ORDINALITY`, and functions returning a catalog relation type expose output columns. Polymorphic or overload-dependent output types remain incomplete.
- Completed `CREATE TABLE` statements before the cursor supply **draft** relations and columns. A later simple `DROP TABLE` removes a draft from the editor-local overlay. Future and unfinished statements do not contribute; the overlay does not mean any DDL has run.

## Cursor positions and ranking

The lexer preserves offsets across quoted identifiers, strings, dollar quotes, nested block comments, numbers, and operators. Completion ignores cursor positions inside comments and string literals. Quoted and partially typed names retain the correct replacement range.

Within a `SELECT` list, a completed expression offers continuations such as `AS`, `FROM`, and `WHERE`; a comma or operator opens a new operand position. For example, `SELECT * f` offers `FROM`, while `SELECT *, fr` can offer expression starters. Exact typed names rank first, then shorter matching names, subject to SQL context. Function candidates remain available beside SQL keywords. The [Monaco adapter guide](monaco-postgresql.md) explains how to keep this order in the popup.

Type positions such as `CAST(x AS `, `x::`, and `CREATE TABLE t (id ` use the optional `types` snapshot, with a small built-in fallback. A new `CREATE TABLE` column-name position does not offer catalog column names. `INSERT` and `UPDATE` target-column forms and common DDL type forms use bounded pattern matching.

## Current limits

Context recovery is heuristic, not a full PostgreSQL grammar or expression validator. CrabSense does not infer arbitrary expression types, all recursive CTE types, mutually recursive definitions, exact overload resolution, or every nested scope rule. Draft DDL does not model `ALTER TABLE`, `CREATE TABLE AS`, rollback, or temporary-table lifetime. For planned work, see the [SQL resolution roadmap](sql-resolution-plan.md).
