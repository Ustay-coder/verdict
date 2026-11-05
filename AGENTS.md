# Verdict — instructions for coding agents (Codex CLI, Claude Code, …)

Verdict is an evaluation engine: rubrics (criteria × scales × anchors) are scored by pluggable judges
(`llm` / `human` / `benchmark` / `panel`) and rolled up by a configurable aggregation. Surfaces: REST (Hono), CLI, MCP, SDK.
Read `docs/ARCHITECTURE.md` before changing the engine and `docs/RUBRICS.md` before changing the schema.

## Working in this repo
- Package manager: `pnpm` (workspace). Node 22. ESM + TypeScript (NodeNext) — relative imports end in `.js`.
- Build everything: `pnpm build`. Typecheck: `pnpm typecheck`. Tests: `pnpm test` (vitest; `packages/core/test`, `packages/api/test`).
- Try it without any LLM key: `node packages/cli/dist/bin.js eval -r examples/rubrics/offline-benchmark.yaml -i ci=examples/inputs/ci.json -i examples/inputs/CHANGELOG.md`
  or add `--mock` to any rubric that uses `llm` judges.
- Dependency order: `core` ← `sdk` ← `api`, `mcp` ← `cli`. Rebuild `core` before testing dependants.

## Invariants (do not break)
- Judges never throw; they return `status: "error"` or `status: "pending"` ratings (`packages/core/src/judges/types.ts`).
- Every score keeps a raw value in the criterion's scale **and** a normalized 0..1 value; aggregation works on normalized unless the method says otherwise.
- An evaluation freezes its rubric; `reaggregate` must never call judges.
- Rubrics never contain secrets — judges reference env vars via `apiKeyEnv`.
- Formulas go through `packages/core/src/expr.ts` (no `eval`, no `Function`).
- The API must keep running on Cloudflare Workers: no Node-only imports in `packages/api/src/app.ts` or anything it pulls from `core` at module top level (Node-only modules like `node:fs` are imported lazily inside functions).
- Public API shape is documented in `README.md` (REST table) and mirrored by `packages/sdk`; change all three together.

## Style
- Small, typed modules; zod schemas are the source of truth for request/rubric shapes.
- Add or update a vitest test for every behaviour change; keep tests offline (inject `fetch`, use `provider: mock`).
- Don't add dependencies without a reason; prefer the web platform (`fetch`, `Response`) over Node-specific APIs.
- Commit messages: imperative subject, body explains *why*.

## Codex CLI
Use the ChatGPT subscription via OAuth, not an API key: `scripts/setup-codex.sh` installs Codex, writes
`~/.codex/config.toml` with `preferred_auth_method = "chatgpt"`, and runs `codex login`. Start work with `codex` from the repo root. In a cloud container use `scripts/codex-cloud.sh` (credentials from the
`CODEX_AUTH_JSON` secret, or device-code login) and `codex exec "<task>"` for non-interactive runs.
