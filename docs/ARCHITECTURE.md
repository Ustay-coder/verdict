# Verdict architecture

Verdict is an **evaluation engine**: it turns *inputs* into *evidence*, lets *judges* score each *criterion*, then *aggregates* those scores under a user-defined policy. Everything that varies between use-cases is data (the rubric), not code.

## Why decision models

Rubric scoring is a *bounded judgement*, not text generation. A new class of models — **decision models / "System One" models** (TypeSafe Jev, Cloudflare Clef & Clef-flash, OpenAI Decisions API, Inception Mercury Decide, Perplexity Decider, Selectstar Davi, open weights such as Imajev) — is built exactly for that: they take a `state` (text or JSON) plus a map of typed questions and return, per question, a probability distribution over the allowed answers and a confidence. Three primitives cover every rubric criterion:

| Primitive | Question | Verdict mapping |
| --- | --- | --- |
| `score` | Position on an ordered rubric of 2–10 described levels | Every numeric / ordinal criterion. Levels come from `criterion.levels`, else `anchors`, else ordinal labels, else auto-buckets of the scale. Expected value over level values → raw score; per-level probabilities kept. |
| `noul` | Probability that a proposition is true | Binary criteria (gates, safety, presence checks). |
| `choice` | One option out of up to 255 | Routing / categorisation via criterion `choices`; optional `values` map options to scores. |

Consequences for the design:
- **One request per rubric.** Questions fan out over a shared `state`; extra questions add tokens, not latency. The engine batches every criterion that uses an identical decision-judge spec and the same evidence into a single call (`Judge.rateMany` + `batchKey`). A 10-criterion rubric is one ~200 ms request instead of 10 LLM calls.
- **Probabilities, not prose.** Ratings carry `probabilities` (per level) and `confidence` (distribution concentration: `(p_max − 1/n)/(1 − 1/n)` for score/choice, for noul the distance of `p` from the criterion `threshold`, `|2p − 1|` at the default 0.5 — derived by Verdict, since decision models report no noul confidence). There is no rationale from the model; the rationale field renders the distribution. Where a written justification is required, add a generative `llm` judge for that criterion only.
- **Confidence gates.** `minConfidence` + `onLowConfidence: accept | human | error` route uncertain answers to a person (a pending human rating, with the model's distribution attached as context) or fail them — the canonical decision-model pattern of "auto-handle above threshold, escalate the rest".
- **Text-only state.** Decision models take text/JSON (Clef also accepts media on Workers AI). Ingestion therefore renders everything — PDFs, pages, transcripts — to text before judging; 64k-token request limits (32k for state + longest question) make `maxChars` and `criterion.inputs` filters matter.
- **Provider independence.** Clef, DigitalOcean Inference, FastRouter and several gateways accept the Jev `/v1/systemone` request shape, so one `systemone` adapter with a `baseUrl` covers most hosts; TypeSafe, Cloudflare (REST `result` envelope), OpenRouter (`/api/alpha/decisions`) and OpenAI Decisions (`predicate` instead of `noul`) get thin adapters. Any other decision model is one `registerDecisionProvider` away.
- **Pricing shape.** Decision models bill input tokens only (Jev ~$0.042/M, Clef $0.24/M, Clef-flash ~$0.04/M at the time of writing) — the state dominates cost, so Verdict sends the evidence once per batch.

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
| `@verdict-ai/core` | Engine. Zero HTTP, no framework. Runs in Node and (mostly) in Workers. | `schema/*` zod models · `ingest/` · `judges/` · `aggregate/` · `expr.ts` · `engine.ts` · `store/` |
| `@verdict-ai/api` | REST surface on Hono. Same app object serves Node (`server.ts`) and Cloudflare Workers (`worker.ts`). | `app.ts` |
| `@verdict-ai/cli` | `verdict` binary. Local engine with a file store, or remote mode against an API. | `index.ts` |
| `@verdict-ai/mcp` | MCP server (stdio). Same local/remote split. | `index.ts` |
| `@verdict-ai/sdk` | Thin typed client mirroring the REST API. | `index.ts` |

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
| `decision` | **Default.** Converts criteria to `score` / `noul` questions, sends one System One request per batch, maps per-level probabilities to the criterion scale, applies confidence gates and escalation. Providers: `typesafe` (Jev), `cloudflare` (Clef / Clef-flash / `typesafe/jev` on Workers AI), `openrouter`, `openai` (Decisions API), `systemone` (any compatible endpoint), `mock`. |
| `llm` | Generative judge (optional). Builds a stable system prompt (rubric context + criterion + scale + anchors — cacheable) and a user message of rendered evidence; asks the provider for a structured `{score, confidence, rationale, quotes}`. `samples: n` runs n times and takes the median; disagreement lowers confidence. Providers: `anthropic` (default; `client.beta.messages.parse` + `zodOutputFormat`, prompt caching on the system block, `fallbacks: "default"` for safety-classifier refusals, `effort` control), `openai` (any OpenAI-compatible `/chat/completions` with JSON schema), `cloudflare` (Workers AI REST / AI Gateway), `http` (POST to your own decision model), `mock` (tests / dry runs). Add more with `registerLlmProvider`. |
| `human` | Emits `required` pending slots. Slots are named when every listed rater must answer; otherwise generic and any allowed rater may fill them. `Engine.submitScore` validates rater, fills the slot, re-aggregates, and fires the webhook when the evaluation completes. |
| `benchmark` | Deterministic: `regex`, `keywords`, `length`, `jsonpath`, `formula` (over evidence stats + flattened JSON numbers), `similarity` (cosine over token bags), `http` (external scorer). Reproducible, free, edge-friendly. |
| `panel` | Runs member judges and folds them with `mean|median|min|max|majority`. Stays pending while any human member is pending; resolves when the last human submits. `combine: min` gives any member veto power (brand-safety style). |
| custom | `registerJudgeType("my_type", factory)` extends the discriminator. |

### Aggregation
Two layers, both configurable:
1. **Rater aggregation** (`aggregateRatings`): many ratings for one criterion → one score. `mean|median|trimmed_mean|min|max|majority`, rubric-wide default with per-criterion override. Tracks how many ratings are still expected → `pending`.
2. **Overall aggregation** (`aggregateCriteria`): criteria → total. Methods over normalized scores (`weighted_mean`, `mean`, `median`, `min`, `max`, `geometric_mean`), over raw scores (`weighted_sum`), or a **formula** evaluated by `expr.ts` (a small, safe parser: arithmetic, comparisons, boolean logic, ternaries, `min/max/avg/clamp/scale/if/...`; no `eval`). Variables per criterion: `id` (raw), `id_n` (0..1), `id_w` (weight), `id_present`. Then: output range (`normalize`), `missing` policy (`exclude|zero|fail`), `gates` (hard pass/fail on individual criteria), `grades` (tiers), `passThreshold`, `precision`. A result is `partial` while any criterion is pending — scores are provisional but available immediately.

### Batching
`Engine.evaluate` builds one `JudgeContext` per (criterion, judge). Judges that implement `rateMany` + `batchKey` (decision models) are grouped by `batchKey() + evidence input indexes`; each group becomes one request. Everything else (humans, benchmarks, panels, LLM judges) runs per criterion. All jobs share the evaluation's concurrency limit. Panels call their members per criterion, so a decision model inside a panel is not batched across criteria — use the top-level judge for the common case.

### Evaluation lifecycle

Idempotent evaluation and batch entry points scope keys by tenant and hash canonical request JSON with Web Crypto SHA-256, excluding response flags (`async`, `includeEvidence`). They reserve pre-assigned evaluation IDs before ingestion or judges start, and persist the key on evaluation documents. Matching retries reload current evaluations and rebuild batch rankings with `rankEvaluations`, without calling judges; changed requests raise `ConflictError` (HTTP 409). Keys expire after 24 hours (`EngineOptions.idempotencyTtlMs`), and missing targets allow a fresh run. All stores persist idempotency records. The engine serializes reservations within a store; FileStore also locks across instances and replaces JSON files atomically. SQLite/D1 atomically commits conditional key reservations and initial evaluation documents (SQLite transaction / D1 batch), using the unique `(tenant_id, key)` index, so separate processes cannot start duplicate judge work.
`queued → running → completed | pending_human | failed`. Queue jobs retry transient provider/ingestion errors (429, 5xx, rate limits, timeouts and network failures), returning to queued with backoff. Exhausted jobs become failed with job.deadLettered; intermediate attempts do not deliver terminal webhooks. Human submissions move `pending_human → completed`. Webhooks fire on `completed`/`failed` (HMAC-signed). `reaggregate` never touches judges: it re-runs layer 1 + 2 on stored ratings — cheap what-if analysis and policy changes after the fact.

**Input schema.** Before ingestion, a rubric's `inputSchema` (a JSON Schema subset, `schema/input-schema.ts`) is checked against every `json` input. A mismatch fails the evaluation with `inputErrors`, before any URL is fetched or judge called; the error is terminal, so queue jobs do not retry it.

**Checks.** After ingestion, rubric pre-screen checks run as one batch of noul questions before criterion judges. Failures flag, fail the aggregate, or abort with excluded criteria. Provider errors continue as flags, except abort checks complete with an evaluation error. Stored check results and fail gates survive reaggregation.

### Ingestion
`ingest/index.ts` registry keyed by input type. Built-ins: text, json, file (PDF via `unpdf`, HTML via `html-to-text`, JSON, everything else as text; path or base64), url (HTML→text, JSON, PDF; optional screenshot through an injected renderer such as `lazyPlaywrightScreenshot()`), image (PNG/JPEG/WebP; bytes held in memory for vision judges, metadata only on the evidence), youtube (public caption tracks + description; auto-generated captions flagged; swap in a paid provider with `youtubeTranscript`). `registerIngestor(type, fn)` replaces any of them (e.g. route `url` through a headless browser or Firecrawl). Evidence carries stats (chars/words/lines) used by benchmarks and a `truncated` flag. Criteria can see a subset of evidence through `inputs: [tag|label]`.

### Store
`Store` interface in core (rubrics + evaluations, tenant-scoped) with three implementations:
- `MemoryStore` (tests, demos) and `FileStore` (JSON files; CLI default) in core.
- **`DrizzleStore`** in `@verdict-ai/db` — Drizzle ORM with SQLite and Postgres dialects. SQLite supports **Cloudflare D1** in Workers (`fromD1(env.DB)`) and better-sqlite3 locally (`fromSqliteFile(path)`), sharing one schema and one set of drizzle-kit migrations (`packages/db/drizzle/`). Documents are stored as JSON `doc` columns (their shapes belong to core's zod schemas and change often); the columns we query — tenant, status, score, grade, timestamps, usage — are derived on write. A denormalized `ratings` table (one row per rating with judge type, score, normalized, confidence, model) is the substrate for calibration analytics without parsing blobs. `api_keys` holds sha256-hashed keys per tenant; `DrizzleAuth` resolves them (with env keys as an optional bootstrap fallback). Postgres is also supported via `fromPostgres(url)`, with the same table plan in `schema/pg.ts` and migrations in `drizzle/pg/`. Row logic and auth are shared; Postgres uses jsonb, boolean and double precision columns, JSONB reservation operators and an async transaction; SQLite uses JSON text and an immediate transaction, and D1 uses an atomic batch. ISO timestamps remain text in both dialects. `fromPglite()` runs the Postgres dialect offline.

### Versions, datasets and runs
`versions/` (core) turns ad-hoc evaluations into comparable experiments, without calling judges anywhere except `runCases`:
- **Rubric versions** (`freezeRubric`): immutable, with an id derived from content (`rv_…`), so freezing the same rubric anywhere gives the same id. `splitRubric` divides a rubric into *judgment* (what judges read — a change needs a re-run), *policy* (aggregation, weights, thresholds, escalation — a change needs only re-scoring), *binding* (provider, model, endpoint, options) and *meta*; each part has its own hash. A field counts where it is used: the rubric name is judgment only when an `llm` judge reads it. Forks (`forkDraft` + `freezeRubric(draft, { parent })`) record the exact parent version and machine-computed `changeKinds`.
- **Dataset versions** (`createDatasetVersion`): gold cases with separate `casesHash` (ids + inputs; file inputs by content digest when a reader is given) and `labelsHash`. A label-only change keeps `casesHash`.
- **Runs** (`runCases`): one version over one dataset as a batch, with a fingerprint of everything that must match for two runs to differ only in the rubric: the hashes, the questions actually sent (read back from ratings), `QUESTION_FORMAT_VERSION`, the scoring rule, and the models that answered (verified only when the provider named them). `rescoreRun` scores stored evaluations against new labels and refuses when inputs changed.
- **Comparison** (`compareRuns`): per criterion and case — `fixed`, `regressed`, `kept_match`/`kept_miss`, unlabelled, `escalated`, `error`, `missing`, or `incomparable` when the answer contract (levels/options) changed. Classified `rubric_change` only when judgment alone differs; any other difference (model, policy, inputs, an unverified model) makes it `different_conditions`. Cases whose answer moved close to flipping are flagged `nearBoundary` from the stored probabilities. Rates are over cases both runs scored and that carry a label.
- `VersionStore` is implemented by `MemoryStore` and `FileStore`; the database stores adopt it with the hosted workbench.

### Public hub
`hub/` (core) builds **publications**: copies of what an author chose to make public — one rubric version, cases marked `visibility: public`, and the numbers of chosen runs (`buildPublication`; the preview and the stored document come from the same call). `PublicationStore` (Memory, File and Drizzle stores; `publications` table) is the only collection the hub reads without a tenant: public reads never touch rubrics, evaluations or runs. Withdrawal sets `withdrawn_at` and removes a publication from search. REST: `/v1/publications[/preview|/:id]`. The client side follows the same rule before anything is sent: `publicationRun` copies a run's conditions and counts field by field and names only the cases being published (a case that is not published is sent as a random stand-in), so a private case's id, name and labels never leave the author's machine.

### Control plane
`control/` (core) keeps what a team needs to run rubrics in production without the server ever seeing a case (design and decisions: `docs/design/control-plane.md`): **projects**, **environments**, the **rubric versions** kept in a project under the name services ask for, **pointers** (which version an environment runs), the **history** of pointer changes, and the **numbers** CI reports about runs and comparisons. `ControlStore` is exposed as `store.control` (`hasControl`) by `MemoryStore`, `FileStore` and the Drizzle stores; unlike `VersionStore` it holds no dataset and no case id.
- Everything is scoped to a tenant and a project. A missing tenant is its own scope, never a wildcard, and there is no read path without a tenant.
- `applyPromotions` applies the pointer changes of one environment all or none: each applies only while the pointer is at the version the caller saw and the target version is kept under that rubric name. A version can be deleted only while no pointer names it.
- The memory and file stores share one implementation (`DocumentControlStore`). The SQL store puts each condition inside its statement and runs the statements as one atomic unit, then reads the outcome back, because D1 has atomic batches but no interactive transaction. One contract (`packages/core/test/control-contract.ts`) runs against memory, files, SQLite, a D1-style batch, Postgres and a local D1 — Cloudflare's own runtime serving the D1 API over the real migrations, through `fromD1` (`packages/db/test/d1.test.ts`).
- REST (`/v1/projects…`, `packages/api/src/routes/{projects,project-versions,promotions}.ts`) and the SDK (`projects`, `environments`, `versions`) cover projects, environments, versions, promotions, rollbacks and history. Request shapes and the documents built from them live in `control/requests.ts`, so every surface applies the same rules: an upload is frozen again and must match its id; a rollback is the event that undoes a pointer's latest change. - **Services read, then judge locally.** `GET …/environments/:env?include=rubrics` returns every pointer with its document in one answer, so a service never sees half of a promotion that moved two rubrics; its `ETag` is derived from the pointers alone (versions are immutable), so polling an unchanged environment is one small read and a 304. The SDK's `environment()` (`packages/sdk/src/environment.ts`) holds the answer, asks again on the first call after `refreshMs` (no timers — Workers-safe), refuses a document that does not freeze to the id the server named, and on any failed or slow check keeps returning what it holds, marked `stale`; a `fallback` rubric covers a cold start. `examples/control-plane` runs the whole loop and is exercised by `packages/cli/test/action.test.ts`.
- **CLI** (`packages/cli/src/control/`, `commands/{project,promote,report}.ts`): `verdict project`, `env`, `push`, `promote`, `rollback`. The project and server come from the option, the environment, then the nearest `verdict.yaml`; keys are kept one per server address (`hub/credentials.ts`). `promote` reads the pointers, shows the change, asks, uploads the versions it holds and sends the change with the versions it showed (`control/pointers.ts`), so a concurrent change surfaces as a refusal that says where the pointer is. A rubric file is promoted only when it freezes to its `verdict.lock` version, and its server name is recorded in the lock entry. There are no MCP tools for these: an agent does not promote to production on its own.
- **Reports carry numbers only.** `control/reports.ts` holds the request schemas (`/v1/projects/:project/reports/{runs,comparisons}`) and the builders both ends use. The schemas have no field for a case id, an evaluation id, an input or an output, and `runReportRequest` / `comparisonReportRequest` copy a run's conditions and counts field by field, so a CLI cannot send more by passing a larger object. The server keeps a run report only for a version it holds (or receives with the report) whose judgment, policy and binding hashes the run names; every report is `author_reported`. The CLI (`verdict report`, `run --report`, `diff --report`) refuses mock runs and resolves the server and project before any judge is called. Tests on both sides check that the name, phone number and case id of a private case appear in no request.
- **One place allows or refuses.** `Auth.resolve` may return a tenant and an actor (`DrizzleAuth` returns the key's id and name; a bare tenant id means an unnamed key). Every control route calls `allow(action, target)` before it reads or writes; `createApp({ authorize })` decides, and the default allows everything. A hosted build plugs roles, plan limits and approvals in there. `packages/api/test/control.test.ts` walks every route under `/v1/projects` with a deny-all hook and a store that fails on use, so a route that skips the hook fails the test.
- **What a server with people plugs in** (that code and its design live outside this repository). `Auth.resolve(apiKey, request)` receives the request, so a server where one person belongs to several organisations can read which one a request names (`x-verdict-org`, sent by the SDK's `org` option and the CLI's `org:`), and a browser can be recognised by its session cookie instead of a key. An identity may carry `claims` (a role, what a key may reach); they reach `authorize` untouched. `createApp({ signIn })` announces a sign-in the embedding server runs itself, and `verdict login` follows it. A server built from this repository alone ignores all three and behaves as before.
- **Route groups.** `createApp({ routes })` picks which groups an app serves (`evaluations`, `rubrics`, `hub`, `control`; default all). A group left out answers 404 and is left out of `/v1/openapi.json`.

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
- **Single node**: `verdict serve --database ./verdict.sqlite` (Drizzle on SQLite, DB-managed keys) or `--data-dir ./data` (JSON files).
- **Cloudflare Workers + D1** (primary target): `packages/api/dist/worker.js` with `nodejs_compat`, a `DB` D1 binding, migrations applied with wrangler. Jev over `fetch`, Clef-flash on Workers AI in the same network. Without a binding the worker falls back to a per-isolate memory store for demos.
- **Embedded**: import `@verdict-ai/core` directly in your own service and skip HTTP.

## Roadmap
1. **Decision-model depth:** per-provider verified fixtures once official docs are reachable from CI, Clef media state on Workers AI, OpenAI Decisions GA shape.
2. **Calibration:** stored-evaluation reports now compare decision ratings (including escalations) with human consensus: agreement, normalized error/bias, confidence buckets, ECE, suggested `minConfidence`, and interval Krippendorff’s α, exposed through REST, SDK, CLI and MCP. Next: gold-standard sets per rubric, judge drift reports, per-rubric cost/latency stats.
3. Richer evidence: PDF page renders and video frames for media-capable decision models, audio transcription provider hooks.
4. Rubric versioning + migration of past evaluations; rubric templates library (hiring, grants, essays, hackathons, RFPs, model evals, ticket triage). Design draft for immutable versions, forks, dataset versions, run comparison and a public hub: [docs/design/hub.md](design/hub.md).
6. Human-rater UI kit (hosted task inbox) and SSO-aware rater identities; blind mode (strip names/brands from state).
