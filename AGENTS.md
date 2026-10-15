# Codex instructions for CrabSense

CrabSense is a local prototype of PostgreSQL object completion in Monaco Editor. Keep the demo small, runnable with Docker Compose, and visibly crab themed.

## Architecture

- The repository root is the publishable, dependency-free package. `src/completion.js` owns completion; `src/completion.d.ts` is its TypeScript contract; `npm run build` writes only package files to root `dist/`.
- `demo/` is a separate private Monaco application with its own package manifest, lockfile, tests, and `demo/dist/` build output.
- `demo/src/main.js` owns Monaco, the schema browser, loading state, and the `CompletionItemProvider` adapter.
- `demo/server/index.js` exposes `GET /api/schema` and `GET /health`. It reads PostgreSQL catalogs through `pg`, applies privilege checks, and serves the built frontend. Editor SQL must never be sent to or executed by the server.
- `demo/db/init.sql` creates representative public and `harbor` schema objects, a view, a function, and rows for manual exploration.
- `compose.yaml` starts PostgreSQL and the app. PostgreSQL readiness gates app startup.

Flow: PostgreSQL catalogs → `/api/schema` → cached metadata in browser → SQL context resolver → Monaco suggestions. `Refresh schema` bypasses the server's 30-second metadata cache after schema changes.

## Completion behavior

- After `FROM` or `JOIN`, suggest relations and schemas.
- After `alias.` or `table.`, suggest columns from the resolved relation.
- After `schema.`, suggest that schema's relations and functions.
- In expressions, suggest columns from referenced relations, user-defined functions, and SQL keywords.
- Ignore comments and string literals. Preserve offsets so Monaco's replacement range matches the typed prefix.
- Treat quoted identifiers and aliases carefully. If you extend SQL parsing, add a focused test in `tests/completion.test.js` first.

This is deliberately a heuristic completion engine, not a full PostgreSQL parser. State limitations in the README as behavior changes.

## Working rules

- Run `npm test` after changing completion logic.
- Run `npm run build` after changing package code or types. Run `npm run demo:build` after changing browser code, when demo dependencies are installed.
- Run `npm run demo:test` after changing demo parser, validation, or comparison code.
- Run `docker compose config --quiet` after changing Compose.
- For end-to-end validation, use `docker compose up --build -d`, check `/health` and `/api/schema`, then open `http://localhost:3000` and try the examples in README.
- Keep database credentials clearly local to the demo. Do not add arbitrary SQL execution endpoints or expose PostgreSQL on the host by default.
- Keep accessibility labels, visible error states, and the schema explorer as changes are made.
