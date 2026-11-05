# Verdict — the evaluation engine API

**Score anything, your way.** Send documents, websites, YouTube links, JSON or raw text; define *what* to grade (criteria), *who* grades it (decision models such as Jev or Clef, humans, deterministic benchmarks) and *how* scores roll up (aggregation). Get a number, a grade, a pass/fail and per-criterion probability distributions back in one call — via REST, CLI, MCP or the TypeScript SDK.

Think "Resend for evaluation": one small, well-typed API that every product with a grading step can call.

**Built on decision models, not chat models.** A rubric is a set of typed questions. Decision models ("System One" models: TypeSafe **Jev**, Cloudflare **Clef** / Clef-flash, OpenAI **Decisions API**, Inception Mercury Decide, …) take a `state` plus typed questions and return calibrated probabilities over the allowed answers in ~100–500 ms, with no prose to parse, at a fraction of LLM cost. Verdict turns every criterion into one `score` (ordered rubric levels) or `noul` (yes/no probability) question and answers the **whole rubric in a single request**. Generative LLMs remain available as an optional judge where you need a written rationale.

```
POST /v1/evaluations
{
  "rubric": "rub_startup_pitch",
  "inputs": [
    { "type": "file",    "base64": "...", "filename": "deck.pdf" },
    { "type": "url",     "url": "https://acme.example" },
    { "type": "youtube", "url": "https://youtu.be/dQw4w9WgXcQ" }
  ]
}
→ { "status": "completed", "aggregate": { "score": 78.5, "grade": "invite", "passed": true }, "criteria": [ ... rationales, quotes ... ] }
```

## Why

Every hiring pipeline, accelerator, grant committee, school, hackathon, content program, RFP desk and model-eval team rebuilds the same thing: a rubric, a way to apply it, a spreadsheet to add it up. Verdict turns that into infrastructure:

| Concern | How Verdict handles it |
| --- | --- |
| **Any input** | `text`, `json`, `file` (PDF/MD/TXT/CSV/HTML/JSON — path or base64), `url`, `youtube` (transcript + description). Ingestors are pluggable. |
| **Any criteria** | Numeric / binary / ordinal scales per criterion, weights, anchors (level descriptions), groups, optional criteria, per-criterion input filters. |
| **Any judge** | `decision` (**default** — Jev via TypeSafe, Clef on Cloudflare Workers AI, OpenRouter, OpenAI Decisions, any `/v1/systemone`-compatible endpoint; per-level probabilities, confidence gates, escalation to humans), `human` (multi-rater, inbox, submit via API), `benchmark` (regex, keywords, length, JSON path, formula, similarity, external scorer), `llm` (generative judge with rationale + quotes), `panel` (combine several judges: mean/median/min/max/majority). Mix freely per criterion. |
| **Any aggregation** | `weighted_mean`, `weighted_sum`, `mean`, `median`, `min`, `max`, `geometric_mean`, or a custom **formula** over criterion scores. Rater aggregation (mean/median/trimmed/majority), gates, grades/tiers, pass thresholds, missing-score policy, output range. Re-aggregate any past evaluation without re-judging. |
| **Any surface** | REST API (Node or Cloudflare Workers), `verdict` CLI, MCP server (for agents), TypeScript SDK. Multi-tenant API keys, webhooks with HMAC signatures, batches with rankings. |

## Quick start

```bash
pnpm install && pnpm build
export TYPESAFE_API_KEY=...                  # default judge (Jev). Or CLOUDFLARE_* for Clef, or --mock / benchmark-only rubrics

# 1. a rubric
pnpm verdict rubric init rubric.yaml           # starter: decision (Jev + Clef) + human + benchmark + generative judges
pnpm verdict rubric validate rubric.yaml

# 2. evaluate (CLI, local engine, results persisted in ./.verdict)
pnpm verdict eval -r rubric.yaml -i deck.pdf -i https://acme.example -i https://youtu.be/VIDEO -n "Acme"
pnpm verdict eval -r examples/rubrics/offline-benchmark.yaml -i ci=examples/inputs/ci.json -i examples/inputs/CHANGELOG.md   # no LLM needed

# 3. humans finish what AI can't
pnpm verdict tasks
pnpm verdict score eval_… team --rater partner_a --score 4 --rationale "…"

# 4. what-if on the aggregation, no re-judging
pnpm verdict reaggregate eval_… --formula "problem_n*0.6 + team_n*0.4"

# 5. rank many subjects
pnpm verdict compare -r rubric.yaml -s "Acme=deck-a.pdf" -s "Beta=deck-b.pdf,https://beta.example"
```

### Run the API

```bash
VERDICT_API_KEYS="sk_live_abc:acme,sk_live_def:globex" pnpm verdict serve -p 8787 --data-dir ./data
curl -s localhost:8787/v1/evaluations -H "authorization: Bearer sk_live_abc" -H "content-type: application/json" \
  -d '{"rubric":{"name":"kw","criteria":[{"id":"k","name":"Mentions pricing","judge":{"type":"benchmark","method":"keywords","keywords":["pricing","plans"]}}]},"inputs":[{"type":"url","url":"https://example.com"}]}'
```

### SDK

```ts
import { Verdict } from "@verdict/sdk";
const verdict = new Verdict({ apiKey: process.env.VERDICT_API_KEY, baseUrl: "https://api.yourhost" });

const rubric = await verdict.rubrics.create(yamlOrObject);
const ev = await verdict.evaluations.create({ rubric: rubric.id, name: "Acme", inputs: [{ type: "youtube", url }] });
ev.aggregate.score; ev.aggregate.grade; ev.criteria[0].ratings[0].rationale;

await verdict.evaluations.submitScore(ev.id, { criterionId: "team", raterId: "partner_a", score: 4 });
await verdict.evaluations.reaggregate(ev.id, { method: "min" });
const { ranking } = await verdict.batches.create({ rubric: rubric.id, subjects: [...] });
```

### MCP (agents)

```jsonc
// claude_desktop_config.json / any MCP host
{ "mcpServers": { "verdict": { "command": "verdict", "args": ["mcp"], "env": { "ANTHROPIC_API_KEY": "…" } } } }
// or point at a hosted API:  "env": { "VERDICT_API_URL": "https://api.yourhost", "VERDICT_API_KEY": "sk_…" }
```

Tools: `validate_rubric`, `create_rubric`, `list_rubrics`, `evaluate`, `compare`, `get_evaluation`, `submit_human_score`, `reaggregate`, `list_human_tasks`.

## A rubric, end to end

```yaml
name: Startup pitch review
scale: { type: numeric, min: 1, max: 5 }
judges:
  jev:     { type: decision, provider: typesafe, model: jev-latest, minConfidence: 0.35, onLowConfidence: human, escalateTo: [partner_a] }
  clef:    { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef-flash" }
  partner: { type: human, raters: [partner_a, partner_b], required: 1 }
defaultJudge: { type: ref, ref: jev }
criteria:
  - id: problem
    name: Problem clarity
    weight: 2
    anchors:                       # anchors ARE the rubric levels the decision model scores on
      "1": No clear problem
      "3": Stated but vague
      "5": "Specific, painful, quantified"
  - id: traction
    name: Traction evidence
    weight: 2
    judge:
      type: panel
      combine: mean
      judges:
        - { type: ref, ref: jev }
        - { type: ref, ref: clef }
        - { type: benchmark, method: keywords, keywords: [revenue, users, retention, MRR], mode: ratio }
  - id: safe
    name: Brand safe
    scale: { type: binary, labels: [unsafe, safe] }      # → a noul (yes/no probability) question
  - id: team
    name: Team
    weight: 1.5
    judge: { type: ref, ref: partner }
aggregation:
  method: weighted_mean
  normalize: [0, 100]
  gates: [{ criterion: problem, min: 2 }]
  grades: [{ label: invite, min: 75 }, { label: maybe, min: 55 }, { label: pass, min: 0 }]
  passThreshold: 55
```

What happens on `POST /v1/evaluations`: inputs are ingested into one `state`; `problem`, `safe` (and any other criterion on the `jev` judge) go out as **one** System One request with a `score` question per criterion and a `noul` question for the binary one; the response's per-level probabilities become an expected score on the criterion scale plus a `confidence`; answers under `minConfidence` are handed to a human; `traction` runs its panel; the aggregation produces the total, grade and pass/fail. Everything arrives in a few hundred milliseconds unless a human is in the loop.

Full reference: [docs/RUBRICS.md](docs/RUBRICS.md). Design and extension points: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). More examples in [examples/rubrics](examples/rubrics).

## REST API

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/rubrics` | Create (JSON body, or YAML with `content-type: application/yaml`) |
| `POST` | `/v1/rubrics/validate` | Validate without storing |
| `GET/PUT/DELETE` | `/v1/rubrics/:id` | Read / replace / delete |
| `POST` | `/v1/evaluations` | Evaluate. `rubric` = id or inline. `inputs` or `subject`. `async:true` → `202 {id}`. `webhook` for completion. |
| `GET` | `/v1/evaluations/:id` | Status, per-criterion scores, ratings, rationales, quotes (`?evidence=true` includes ingested text) |
| `POST` | `/v1/evaluations/:id/scores` | Human rater submits `{criterionId, raterId, score, rationale?}` |
| `POST` | `/v1/evaluations/:id/aggregate` | Re-aggregate with a different `aggregation` (optionally `persist`) |
| `GET` | `/v1/tasks?rater=` | Pending human tasks |
| `POST` | `/v1/batches` | Many subjects, one rubric → ranking |
| `GET` | `/v1/openapi.json`, `/v1/health` | Discovery |

Auth: `Authorization: Bearer <key>`; keys map to tenants via `VERDICT_API_KEYS="key:tenant,..."` (unset = open single tenant). Errors: `{ "error": { "type": "validation|not_found|http|internal", "message", "issues?" } }`. Webhooks carry `verdict-signature: sha256=<hmac>` when `VERDICT_WEBHOOK_SECRET` is set.

## Configuration

| Env | Meaning |
| --- | --- |
| `TYPESAFE_API_KEY` | `decision` / `typesafe` — Jev (default judge). `VERDICT_TYPESAFE_MODEL` (default `jev-latest`) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | `decision` / `cloudflare` — Clef, Clef-flash, `typesafe/jev` on Workers AI. `VERDICT_CLOUDFLARE_MODEL` (default `@cf/cloudflare/clef`) |
| `OPENROUTER_API_KEY` | `decision` / `openrouter` — `typesafe/jev-1.13`, `inception/mercury-decide`, … |
| `OPENAI_API_KEY` | `decision` / `openai` — Decisions API (`gpt-6-luna`); also the `llm` / `openai` generative judge |
| `SYSTEMONE_BASE_URL`, `SYSTEMONE_API_KEY` | `decision` / `systemone` — any endpoint speaking the `/v1/systemone` shape (self-hosted Clef, DigitalOcean, gateways) |
| `ANTHROPIC_API_KEY` | `llm` / `anthropic` generative judge (rationales). `VERDICT_ANTHROPIC_MODEL` (default `claude-opus-5-5`) |
| `VERDICT_HTTP_JUDGE_URL`, `VERDICT_HTTP_JUDGE_KEY` | `llm` / `http` — a prompted judge behind your own URL |
| `VERDICT_API_KEYS` | `key:tenant,key2:tenant2` for the API |
| `VERDICT_DATA_DIR` | Persist to JSON files (CLI default `./.verdict`; API default memory) |
| `VERDICT_WEBHOOK_SECRET` | HMAC signing of webhook deliveries |
| `VERDICT_ALLOW_LOCAL_FILES=1` | Let the API read `file.path` inputs (off by default; CLI/MCP local mode allow it) |
| `VERDICT_API_URL`, `VERDICT_API_KEY` | Make the CLI / MCP server talk to a hosted API instead of the local engine |

Secrets never live in rubrics: judges reference them with `apiKeyEnv: MY_KEY_VAR`.

## Developing with Codex CLI (ChatGPT subscription, OAuth)

Implementation work on this repo is meant to run through [OpenAI Codex CLI](https://github.com/openai/codex) authenticated with your ChatGPT plan rather than an API key:

```bash
scripts/setup-codex.sh            # installs codex, sets preferred_auth_method = "chatgpt", runs `codex login`
scripts/setup-codex.sh --device   # headless machines: device-code login
codex login status                # should say logged in via ChatGPT
codex                             # start from the repo root; AGENTS.md carries the project rules
```

Running Codex **inside a cloud container** (Claude Code cloud, CI, a devbox) instead: the container's network policy must allow `auth.openai.com`, `chatgpt.com` and `api.openai.com`, then `scripts/codex-cloud.sh` writes a headless config and restores credentials from a `CODEX_AUTH_JSON` (or `CODEX_AUTH_JSON_B64`) secret — the contents of `~/.codex/auth.json` from any machine where you completed `codex login` — or falls back to `codex login --device-auth`. Drive it non-interactively with `codex exec "<task>"`.

`AGENTS.md` is the agent-facing guide (invariants, build/test commands, package layering). `~/.codex/config.toml` is written with `preferred_auth_method = "chatgpt"`, so usage is billed to the subscription; keep `OPENAI_API_KEY` unset in the shell you run Codex from.

## Repository layout

```
packages/core   engine: schemas (zod), ingestion, judges, aggregation, stores, expression language
packages/api    Hono REST API — Node server + Cloudflare Workers entry
packages/cli    `verdict` CLI (local engine or remote API)
packages/mcp    MCP server (stdio) — local engine or remote API
packages/sdk    TypeScript client
examples/       rubrics, inputs, SDK + MCP client scripts
docs/           ARCHITECTURE.md, RUBRICS.md
```

```bash
pnpm test        # core (expression language, aggregation, judges, engine, ingestion) + api
pnpm typecheck
```

## Status

v0.2 — decision-model-first engine (Jev / Clef / OpenAI Decisions / System One-compatible), API, CLI, MCP, SDK with in-memory and file stores. Provider request shapes for TypeSafe and Cloudflare follow their public documentation; OpenAI Decisions and OpenRouter adapters follow public write-ups of the beta and parse defensively — pin `baseUrl`/`options` if a shape differs. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#roadmap) for what's next.

MIT.
