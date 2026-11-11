# Verdict — instructions for coding agents (Codex CLI, Claude Code, …)

Verdict is an evaluation engine: rubrics (criteria × scales × levels) are scored by pluggable judges
(`decision` models such as Jev / Clef — the default — plus `human` / `benchmark` / `llm` / `panel`) and rolled up by a configurable aggregation. Surfaces: REST (Hono), CLI, MCP, SDK.
Read `docs/ARCHITECTURE.md` before changing the engine and `docs/RUBRICS.md` before changing the schema.

## Working in this repo
- Package manager: `pnpm` (workspace). Node 22. ESM + TypeScript (NodeNext) — relative imports end in `.js`.
- Build everything: `pnpm build`. Typecheck: `pnpm typecheck`. Tests: `pnpm test` (vitest; `packages/core/test`, `packages/api/test`).
- Try it without any LLM key: `node packages/cli/dist/bin.js eval -r examples/rubrics/offline-benchmark.yaml -i ci=examples/inputs/ci.json -i examples/inputs/CHANGELOG.md`
  or add `--mock` to any rubric that uses `llm` judges.
- Dependency order: `core` ← `db`, `sdk` ← `api`, `mcp` ← `cli`. Rebuild `core` before testing dependants.
- Live provider calls: `TYPESAFE_API_KEY` (Jev), `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (Clef-flash). Contracts and what is verified: `docs/PROVIDERS.md`.
  In Claude Code cloud sessions prefix Node commands with `NODE_USE_ENV_PROXY=1` (built-in fetch ignores HTTPS_PROXY otherwise).
- Persistence lives in `packages/db` (Drizzle ORM, SQLite for Cloudflare D1 and local files; Postgres for self-hosting). Schemas: `packages/db/src/schema/sqlite.ts` and `packages/db/src/schema/pg.ts`.
  After a schema change run `pnpm --filter @verdict-ai/db db:generate` and `pnpm --filter @verdict-ai/db db:generate:pg`; commit both migration folders (`packages/db/drizzle/` and `packages/db/drizzle/pg/`); never hand-edit applied migrations.

- Quality loop: `pnpm quality` scores the code (docs/HARNESS.md); `pnpm quality:improve` runs the agent-driven improvement harness. Behaviour goldens in `scripts/harness/golden.json` must stay unchanged unless the change is intended (`pnpm smoke -- --update`). Never edit the rubrics, scorer, metrics collector, harness, ESLint config or workflows as part of an improvement round.

## Invariants (do not break)
- Judges never throw; they return `status: "error"` or `status: "pending"` ratings (`packages/core/src/judges/types.ts`).
- Decision models are the primary judge: a criterion maps to one `score` (ordered levels) or `noul` (binary) question, and all criteria sharing a judge spec + evidence go out in ONE request (`rateMany` / `batchKey` in `packages/core/src/judges/decision.ts`). Never add per-criterion round trips there.
- Ratings from decision models keep `probabilities` and `confidence`; respect `minConfidence` / `onLowConfidence` escalation.
- Every score keeps a raw value in the criterion's scale **and** a normalized 0..1 value; aggregation works on normalized unless the method says otherwise.
- An evaluation freezes its rubric; `reaggregate` must never call judges.
- Rubrics never contain secrets — judges reference env vars via `apiKeyEnv`. API keys are stored only as sha256 hashes.
- Documents (rubric / evaluation) are stored as JSON `doc` columns; add indexed columns only for fields that are queried. Every store read is tenant-scoped — the one deliberate exception is public hub reads, which read only the `publications` collection: copies authors chose to make public (`packages/core/src/hub/`). Never add a public read path to any other collection.
- Formulas go through `packages/core/src/expr.ts` (no `eval`, no `Function`).
- The API must keep running on Cloudflare Workers: no Node-only imports in `packages/api/src/app.ts` or anything it pulls from `core` at module top level (Node-only modules like `node:fs` are imported lazily inside functions).
- Public API shape is documented in `README.md` (REST table) and mirrored by `packages/sdk`; change all three together.

## Style
- Small, typed modules; zod schemas are the source of truth for request/rubric shapes.
- Add or update a vitest test for every behaviour change; keep tests offline (inject `fetch`, use `provider: mock`).
- Don't add dependencies without a reason; prefer the web platform (`fetch`, `Response`) over Node-specific APIs.
- Commit messages: imperative subject, body explains *why*.

## Codex CLI
Use the ChatGPT subscription via OAuth, not an API key: `scripts/setup-codex.sh` installs Codex, writes a headless-friendly
`~/.codex/config.toml` (no `model` pin — ChatGPT accounts reject `gpt-5-codex`), and runs `codex login`. Start work with `codex` from the repo root. In a cloud container use `scripts/codex-cloud.sh` (credentials from the
`CODEX_AUTH_JSON` secret, or device-code login) and `codex exec "<task>" < /dev/null` for non-interactive runs (stdin must be closed or Codex waits for extra input).
