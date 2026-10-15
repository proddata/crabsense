# Postgres Language Server WASM comparison

Measured on 2026-10-14 with Node 24.12.0 on darwin/arm64. Compared CrabSense with the published [`@postgres-language-server/wasm` 0.26.0 Workspace API](https://www.npmjs.com/package/@postgres-language-server/wasm), using the same 27 large single-statement fixtures as [query-stress](query-stress.md). This is a local API benchmark, not a browser startup or Monaco rendering benchmark. [Raw results](pgls-wasm-large.json) include each fixture, errors, timings, and the WASM hash.

## Reproduce

The comparison scripts keep PGLS outside the package and demo manifests. Install it in a temporary directory, then pass its Workspace module to the benchmark:

```sh
npm install --prefix /tmp/crabsense-pgls-wasm --no-save --no-audit --no-fund @postgres-language-server/wasm@0.26.0
node demo/scripts/bench-pgls-wasm-matrix.mjs \
  --module /tmp/crabsense-pgls-wasm/node_modules/@postgres-language-server/wasm/dist/workspace.js \
  --large --runs 10 --json /tmp/pgls-benchmark.json
```

The runner converts the same two-relation catalog to PGLS's `SchemaCache`, including stable table OIDs and integer/text types. Each fixture runs in a separate process because PGLS aborts on some unfinished SQL. CrabSense receives the complete edited SQL on each call. PGLS receives `insertFile` with that document, then `complete`; its edit timing includes both calls. PGLS's Workspace completion items have no replacement range, so its correctness check covers required/forbidden candidates only. CrabSense's check also validates replacement offsets. Neither timing includes database access, network transfer, a Web Worker message, or Monaco rendering. Warm results exclude document changes.

## Results

PGLS returned the expected candidates on **15/27** fixtures, missed one on **9/27**, and aborted on **3/27** unfinished nested-query fixtures. CrabSense passed all 24 fixtures that the matrix could finish; the separate [query-stress run](query-stress.md) checks all 27. In focused probes, both engines returned `AS` after `WITH acs a`, a relation after `FROM`, and an aliased column. Only CrabSense returned `SELECT` immediately after `WITH acs AS (`; PGLS returned no candidates there.

| Query | CrabSense edit p50 | PGLS edit p50 | PGLS completion-only p50 | PGLS candidate check |
| --- | ---: | ---: | ---: | --- |
| chained CTE/150 | 6.20 ms | 5.18 ms | 3.96 ms | missed `handle` |
| many joins/150 | 1.36 ms | 2.40 ms | 1.73 ms | pass |
| CTE lateral window union/150 | 8.89 ms | 5.32 ms | 4.07 ms | missed `handle` |
| nested alias shadow/128 | 23.64 ms | 19.67 ms | 19.19 ms | pass |
| deep correlated outer alias/128 | 24.05 ms | 17.63 ms | 17.12 ms | missed `handle` |
| unfinished nested edit/128 | — | — | — | aborted |
| wide projection/1000 | 6.77 ms | 10.16 ms | 7.84 ms | pass |
| wide projection/5000 | 35.77 ms | 49.45 ms | 38.80 ms | pass |

PGLS aborted on the 10-, 40-, and 128-level unfinished nested edit fixtures with `No top-level grammar-rule found` in `pgls_treesitter/src/context/ancestors.rs`. The matrix isolates each fixture so later ones still run. This is a result for version 0.26.0 and these inputs, not a claim about all PGLS configurations.

The published PGLS WASM binary is **12.32 MB** raw (**2.70 MB** gzipped); the package's on-disk contents are about 24 MB. In this Node run, the first workspace initialized in **14.7 ms** and accepted the synthetic schema in **3.0 ms**. These times include local disk loading but exclude a browser download and WebAssembly compilation on a user's device. CrabSense's current built `dist/` occupies about **156 KB** on disk. Package sizes are therefore indicative, not a browser transfer-size comparison.

The benchmark does not support replacing CrabSense with this WASM release for the current demo. PGLS is faster on some deep or CTE fixtures and slower on the widest fixture, but the missing CTE-body starter and aborts matter more than the median speed difference. Revisit after a newer PGLS release, using the same fixtures and an actual browser-worker startup test.
