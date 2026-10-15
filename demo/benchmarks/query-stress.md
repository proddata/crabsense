# Single-query stress baseline

Measured on 2026-10-14 with Node v24.12.0 on darwin/arm64, using CodeMirror SQL 6.10.0. Synthetic queries and a two-relation catalog isolate query size and scope depth from schema size. This is an indicative local run, not an isolated performance laboratory.

Run: `npm --prefix demo run benchmark:query-stress -- --large --json /tmp/query-stress.json`. Full results: [query-stress-large.json](query-stress-large.json).

## Coverage

27 fixtures, all completed scaffolds checked by PostgreSQL's parser. CrabSense passed candidate presence/absence and replacement-range checks in all 27. CodeMirror passed 15/27. Its misses were CTE-derived columns, nested alias shadowing, and unfinished nested queries. These selected checks are not a complete SQL correctness score; native popup ranking is not compared.

## Latency after an edit

15 samples per fixture; median and p95 in milliseconds. Each edit alternates one extra prefix letter. Setup, network, and Monaco rendering are excluded. Both providers are capped at 500 suggestions. CodeMirror's adapter uses whole-document replacement on edits; a native CodeMirror editor can use finer incremental transactions. The raw report also distinguishes first call and unchanged-query timings.

| Query | Characters | Engine | Candidate/range checks | Edit p50 ms | Edit p95 ms |
| --- | ---: | --- | --- | ---: | ---: |
| chained CTE/150 | 20440 | CrabSense | pass | 5.74 | 8.34 |
| chained CTE/150 | 20440 | CodeMirror SQL | miss | 3.18 | 3.72 |
| many joins/150 | 7031 | CrabSense | pass | 1.06 | 1.16 |
| many joins/150 | 7031 | CodeMirror SQL | pass | 1.55 | 1.87 |
| CTE lateral window union/150 | 20911 | CrabSense | pass | 8.06 | 8.33 |
| CTE lateral window union/150 | 20911 | CodeMirror SQL | miss | 3.25 | 4.73 |
| nested alias shadow/128 | 6320 | CrabSense | pass | 22.54 | 23.20 |
| nested alias shadow/128 | 6320 | CodeMirror SQL | miss | 1.13 | 1.73 |
| deep correlated outer alias/128 | 6893 | CrabSense | pass | 22.85 | 23.08 |
| deep correlated outer alias/128 | 6893 | CodeMirror SQL | pass | 1.21 | 1.49 |
| unfinished nested edit/128 | 5801 | CrabSense | pass | 21.05 | 49.45 |
| unfinished nested edit/128 | 5801 | CodeMirror SQL | miss | 1.16 | 1.37 |
| wide projection/1000 | 64969 | CrabSense | pass | 6.84 | 7.40 |
| wide projection/1000 | 64969 | CodeMirror SQL | pass | 10.36 | 46.51 |
| wide projection/5000 | 328969 | CrabSense | pass | 40.64 | 58.90 |
| wide projection/5000 | 328969 | CodeMirror SQL | pass | 37.94 | 41.26 |

## What this exposed

CrabSense preserves the expected bindings in these fixtures. The 329 KB, 5,000-expression query takes about 41 ms per completion in this run. It previously took about 74 ms before reference-scan reuse, about 105 ms before masked-SQL reuse and early exits, and about 968 ms in an older 2026-10-10 baseline. Completion now runs in a dedicated browser worker, so that computation does not block typing, though the numbers here exclude Monaco and worker message transfer. The 128-level nested cases take about 21–23 ms at the median despite being under 7 KB, so document length alone is an incomplete guard.

A V8 CPU profile after masked-SQL reuse put about 81% of sampled time in `references`. It copied the entire statement to mask parenthesized JOIN groups, then scanned it again even when there were no such groups. Reference collection now reuses the first scan and copies only when masking a group. Qualified completions also skip JOIN output counting, which only affects unqualified columns. The previous profile attributed about 57% of sampled CPU time directly to `scanSql` and about 73% including its callees. A Monaco-side statement split would not help this single-statement fixture.

The suite also found an adapter defect: after `ensureSyntaxTree`, a state update is needed to make the completed parse available to CodeMirror sources. The adapter now publishes that tree, following the behavior of CodeMirror’s `forceParsing`, and a long-document alias regression protects it. Measurements above include the fix.
