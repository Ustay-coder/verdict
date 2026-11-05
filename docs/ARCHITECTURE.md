# Verdict architecture

Verdict is an **evaluation engine**: it turns *inputs* into *evidence*, lets *judges* score each *criterion*, then *aggregates* those scores under a user-defined policy. Everything that varies between use-cases is data (the rubric), not code.

```
                 ┌──────────── Rubric (data) ────────────┐
                 │ criteria · scales · anchors · judges    │
                 │ aggregation · gates · grades            │
                 └───────────────┬────────────────────────┘
                                 │
 inputs ──► Ingest ──► Evidence ─┼─► Judges ──► Ratings ──► Rater agg ──► CriterionResult ──► Overall agg ──► Evaluation
 (text,     (pluggable          │   llm | human | benchmark | panel        mean/median/…       weighted_mean/formula/…
  file,      per type)          │
  url,                          │
  youtube,                      ▼
  json)                  surfaces: REST (Hono) · CLI · MCP · SDK
```

## Packages

| Package | Role | Key files |
| --- | --- | --- |
| `@verdict/core` | Engine. Zero HTTP, no framework. Runs in Node and (mostly) in Workers. | `schema/*` zod models · `ingest/` · `judges/` · `aggregate/` · `expr.ts` · `engine.ts` · `store/` |
| `@verdict/api` | REST surface on Hono. Same app object serves Node (`server.ts`) and Cloudflare Workers (`worker.ts`). | `app.ts` |
| `@verdict/cli` | `verdict` binary. Local engine with a file store, or remote mode against an API. | `index.ts` |
| `@verdict/mcp` | MCP server (stdio). Same local/remote split. | `index.ts` |
| `@verdict/sdk` | Thin typed client mirroring the REST API. | `index.ts` |

## Core concepts

### Rubric
A versioned, self-contained document (`schema/rubric.ts`). Parsed with zod; defaults filled; cross-references checked (`parseRubric`). An evaluation **freezes a copy** of the rubric so later edits never change past results, and so `reaggregate` can rerun the policy on stored ratings.

### Scale
Per rubric with per-criterion override: `numeric {min,max,step}`, `binary {labels}`, `ordinal {labels,values}`. Every judge works in the criterion's raw units; the engine keeps a parallel **normalized 0..1** value (`normalizeScore`) so criteria with different scales can be combined. `snapToScale` rounds to steps / ordinal values; `coerceScore` accepts labels ("excellent", "pass") from humans.

### Judge
```ts
interface Judge { id; type; expectedRatings(): number; rate(ctx): Promise<Rating[]> }
```
A judge returns **ratings**, never throws: failures become `status: "error"` ratings, human work becomes `status: "pending"` placeholders. This keeps one bad provider from failing a whole evaluation and makes partial results first-class.

| Type | Behaviour |
| --- | --- |
| `llm` | Builds a stable system prompt (rubric context + criterion + scale + anchors — cacheable) and a user message of rendered evidence; asks the provider for a structured `{score, confidence, rationale, quotes}`. `samples: n` runs n times and takes the median; disagreement lowers confidence. Providers: `anthropic` (default; `client.beta.messages.parse` + `zodOutputFormat`, prompt caching on the system block, `fallbacks: "default"` for safety-classifier refusals, `effort` control), `openai` (any OpenAI-compatible `/chat/completions` with JSON schema), `cloudflare` (Workers AI REST / AI Gateway), `http` (POST to your own decision model), `mock` (tests / dry runs). Add more with `registerLlmProvider`. |
| `human` | Emits `required` pending slots. Slots are named when every listed rater must answer; otherwise generic and any allowed rater may fill them. `Engine.submitScore` validates rater, fills the slot, re-aggregates, and fires the webhook when the evaluation completes. |
| `benchmark` | Deterministic: `regex`, `keywords`, `length`, `jsonpath`, `formula` (over evidence stats + flattened JSON numbers), `similarity` (cosine over token bags), `http` (external scorer). Reproducible, free, edge-friendly. |
| `panel` | Runs member judges and folds them with `mean|median|min|max|majority`. Stays pending while any human member is pending; resolves when the last human submits. `combine: min` gives any member veto power (brand-safety style). |
| custom | `registerJudgeType("my_type", factory)` extends the discriminator. |

### Aggregation
Two layers, both configurable:
1. **Rater aggregation** (`aggregateRatings`): many ratings for one criterion → one score. `mean|median|trimmed_mean|min|max|majority`, rubric-wide default with per-criterion override. Tracks how many ratings are still expected → `pending`.
2. **Overall aggregation** (`aggregateCriteria`): criteria → total. Methods over normalized scores (`weighted_mean`, `mean`, `median`, `min`, `max`, `geometric_mean`), over raw scores (`weighted_sum`), or a **formula** evaluated by `expr.ts` (a small, safe parser: arithmetic, comparisons, boolean logic, ternaries, `min/max/avg/clamp/scale/if/...`; no `eval`). Variables per criterion: `id` (raw), `id_n` (0..1), `id_w` (weight), `id_present`. Then: output range (`normalize`), `missing` policy (`exclude|zero|fail`), `gates` (hard pass/fail on individual criteria), `grades` (tiers), `passThreshold`, `precision`. A result is `partial` while any criterion is pending — scores are provisional but available immediately.

### Evaluation lifecycle
`running → completed | pending_human | failed`. Human submissions move `pending_human → completed`. Webhooks fire on `completed`/`failed` (HMAC-signed). `reaggregate` never touches judges: it re-runs layer 1 + 2 on stored ratings — cheap what-if analysis and policy changes after the fact.

### Ingestion
`ingest/index.ts` registry keyed by input type. Built-ins: text, json, file (PDF via `unpdf`, HTML via `html-to-text`, JSON, everything else as text; path or base64), url (HTML→text, JSON, PDF), youtube (public caption tracks + description; auto-generated captions flagged; swap in a paid provider with `youtubeTranscript`). `registerIngestor(type, fn)` replaces any of them (e.g. route `url` through a headless browser or Firecrawl). Evidence carries stats (chars/words/lines) used by benchmarks and a `truncated` flag. Criteria can see a subset of evidence through `inputs: [tag|label]`.

### Store
`Store` interface (rubrics + evaluations, tenant-scoped). `MemoryStore` (tests, Workers), `FileStore` (CLI, single node). Postgres / D1 / KV are a ~60-line adapter each.

## Surfaces

- **REST** (`packages/api/app.ts`): bearer keys → tenant; JSON or YAML rubric bodies; sync by default, `async: true` returns 202 with an id you can poll (the id is pre-assigned so it is immediately fetchable); `present()` strips evidence text unless asked. OpenAPI stub at `/v1/openapi.json`.
- **CLI**: every engine capability, plus `--mock` to dry-run LLM rubrics with no API calls, `compare` for leaderboards, `serve` and `mcp` to host the other surfaces.
- **MCP**: tools map 1:1 to engine operations; results are compacted to what an agent needs (score, grade, per-criterion rationale, pending tasks).
- **SDK**: `Verdict` client mirroring the API, with `evaluations.wait()` polling helper and typed errors.

## Multi-tenancy & security
- Tenant id derived from the API key; all store reads are scoped.
- Rubrics never hold secrets — judges reference env vars (`apiKeyEnv`).
- `file.path` inputs are off in the API by default (`VERDICT_ALLOW_LOCAL_FILES=1` to enable); base64 is always allowed.
- Formulas run in a hand-written parser, not `eval`.
- Webhook bodies are HMAC-SHA256 signed when a secret is configured.

## Deployment shapes
- **Single node**: `verdict serve --data-dir ./data` (FileStore). Fine for teams.
- **Cloudflare Workers**: `packages/api/dist/worker.js` with `nodejs_compat`; use `provider: cloudflare` for a Workers-AI-only judge set, or Anthropic over fetch. Replace `MemoryStore` with a D1/KV adapter.
- **Embedded**: import `@verdict/core` directly in your own service and skip HTTP.

## Roadmap
1. Postgres and D1 `Store` adapters; idempotency keys; queue-backed async with retries.
2. Calibration: gold-standard sets, inter-rater agreement (Krippendorff's α), judge drift reports, per-rubric cost/latency stats.
3. Richer evidence: images / PDF page renders to vision models, video frames, audio transcription provider hooks.
4. Rubric versioning + migration of past evaluations; rubric templates library (hiring, grants, essays, hackathons, RFPs, model evals).
5. Human-rater UI kit (hosted task inbox) and SSO-aware rater identities.
6. Bias/consistency guards: position-swap for pairwise comparisons, anchor-only prompting experiments, blind mode (strip names/brands from evidence).
