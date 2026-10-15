# SQL resolution roadmap

CrabSense currently resolves incomplete SQL with an offset-preserving lexer,
query frames, catalog bindings, and small editor-local overlays. This plan
extends that foundation while keeping the root package dependency-free and
keeping all editor SQL in the browser.

## First increment: set-operation scope isolation — implemented

`UNION`, `UNION ALL`, `INTERSECT`, and `EXCEPT` now separate relation bindings
between their input queries. A local alias resolves only in its branch; a
correlated subquery can still see its enclosing query. Derived aliases from a
sibling branch are hidden. Token boundaries keep comments, literals, quoted
identifiers, and nested set operations from splitting an enclosing scope.

The regression tests cover both cursor directions, alias reuse, unqualified
columns, parentheses, shared CTEs, derived projections, incomplete edits, and
correlation. Aliases beginning with a keyword, such as `outer_ship`, also work.

This does not yet resolve the output namespace of a combined query's trailing
`ORDER BY`, or fully analyze CTE, derived-table, and join visibility.

## 1. Make scope and binding rules explicit — in progress

Direct and wrapped FROM subqueries now hide their immediate parent's
bindings, while LATERAL subqueries see only preceding sources. Scalar and
EXISTS subqueries keep correlation; a FROM subquery can still reference an
earlier ancestor when its immediate parent has an inaccessible alias of the
same name. Source visibility has focused package tests, demo scenario oracles,
and read-only PostgreSQL `EXPLAIN` checks for allowed and rejected references.
An explicit relation alias also hides the relation's original name in that
query. A mixed aliased/unaliased self join retains both column qualifiers.
`ON` and `USING` now use the active JOIN operands: a preceding comma source is
excluded, while a nested parenthesized JOIN condition sees only its own group.
An alias on a parenthesized JOIN exposes the joined columns and hides operand
names outside the group. Chained `USING` and `NATURAL` joins merge shared output
columns in order, and unaliased parenthesized groups retain operand bindings.
Ambiguous duplicate output names from `ON` are not suggested through that
alias. A new `CREATE TABLE` column-name position also
suppresses unrelated catalog column suggestions.

Replace the remaining text-based reference collection with token-based source
nodes and an explicit scope tree. Represent relation aliases, query outputs,
CTEs, and correlation edges separately from the global catalog. Keep cursor
ranges attached to nodes, including unfinished groups.

Deliver in small increments:

- Finish FROM/LATERAL handling for polymorphic table functions, ambiguous
  overloads, and unusual or incomplete JOIN trees. Function arguments see
  preceding sources; record definitions, catalog composite returns, and
  `ROWS FROM` are supported in common cases.
- Extend JOIN output modeling to table functions, derived sources, incomplete
  trees, and multiple comma-separated JOIN groups. Chained `USING`, `NATURAL`
  joins, unaliased nested groups, derived subqueries, and catalog-backed scalar
  table functions are implemented for common cases. Function arguments see
  preceding sources, and record functions with explicit definitions, `ROWS FROM`, and
  catalog composite return types now contribute columns. Polymorphic or
  overload-dependent return shapes remain unresolved.
- Finish WITH resolution for recursive expressions and complex output shapes.
  Nested WITH shadowing, earlier sibling visibility, recursive forward references,
  explicit output names, direct anchor-column types, and derived columns from
  visible CTEs are implemented. Mutual recursion remains unsupported.
- Extend set-operation output inference beyond simple SELECT projections. The
  trailing ORDER BY now uses first-branch output names, including aliases and
  stars, and excludes branch-local input columns.
- Refine PostgreSQL visibility beyond the effective `searchPath` snapshot,
  including temporary schemas and exact function overload rules. The demo now
  supplies `current_schemas(true)` and the package orders unqualified relations,
  types, and routines by that path.

Acceptance: focused positive and negative completion tests for each visibility
rule, a shared scope corpus in the demo correctness gate, and PostgreSQL
parse/analysis checks for completed representative queries. Analysis checks run
directly against a disposable test database, never through a demo SQL endpoint.

## 2. Add PostgreSQL grammar coverage through an optional parser adapter

The demo already uses `libpg_query` for optional syntax validation. Evaluate an
adapter that normalizes its PostgreSQL parse trees into the same scope/source
nodes. Keep the parser outside the root package and make integration optional.
Document the supported PostgreSQL major version explicitly.

Completed SQL can use the grammar tree; incomplete SQL still needs recovery.
Design a cursor-hole strategy for missing identifiers, trailing dots, open
groups, and unfinished clauses. Preserve original JavaScript offsets when
repairing input and converting parser locations. Fall back to the token resolver
when a repair is uncertain. A successful parse alone does not resolve catalog
objects, overloads, or expression types.

Acceptance: grammar fixtures for SELECT/DML, nested WITH, windows, set operations,
table functions, casts, arrays, and JSON operators; every fixture also exercised
at incomplete cursor positions. Test non-ASCII offsets, parser load failure,
and worker/cancellation behavior. Compare latency and asset size before enabling
the adapter by default in the demo.

## 3. Infer expression and output types conservatively

Introduce an internal type result with explicit unknown/ambiguous states and
provenance. Start with column references, explicit casts, typed literals, and
routine returns with an unambiguous signature. Propagate these through SELECT
outputs, CTEs, and derived tables.

Extend the optional metadata contract with stable type identity and structured
routine argument types/modes, plus the catalog facts needed for domains, enums,
arrays, casts, and operators. Keep existing snapshots valid. Do not infer
overloads by splitting the human-readable `arguments` string.

Then add operator signatures, overload selection, CASE/COALESCE common types,
set-operation output types, aggregates, and polymorphic routines. Preserve
unknown when the snapshot cannot prove an answer. Finally use expected types
to rank comparison operands and function arguments; avoid hiding candidates on
uncertain inference. Enum values can follow once enum labels are supplied.

Acceptance: expected output-type assertions, ambiguous-overload and unknown
fallback cases, domains/arrays/enums, and independent PostgreSQL analysis of
completed expressions. Verify backward compatibility with current snapshots.

## 4. Keep correctness, latency, and packaging measurable

For every increment run package tests/build and the demo correctness gate.
Add discovered failures to the corpus before implementing fixes. Run the query
stress and schema-scale benchmarks when scope/index structures change; track
the existing 10,000-relation and deep-query cases. Cache by immutable catalog
identity and document invalidation for parser/type results.

Before release, verify the packed package's public entry point and declarations,
build the demo, rebuild Docker Compose, check both API endpoints, and manually
exercise Monaco replacements, signatures, schema refresh, and visible errors.
Record remaining unsupported constructs in the README at each milestone.

## PostgreSQL semantic references

- [Table expressions, aliases, joins, and LATERAL (PostgreSQL 17)](https://www.postgresql.org/docs/17/queries-table-expressions.html)
- [Combining queries (PostgreSQL 17)](https://www.postgresql.org/docs/17/queries-union.html)
- [SELECT, WITH, and set-operation ORDER BY (PostgreSQL 17)](https://www.postgresql.org/docs/17/sql-select.html)
- [WITH queries and recursive self-reference (PostgreSQL 17)](https://www.postgresql.org/docs/17/queries-with.html)

These are the semantic baseline for the PostgreSQL 17 Docker demo. Full grammar
support and full semantic analysis remain separate milestones; neither is
claimed by the first increment.
