# Verdict — one rubric, every decision model

**Write the rubric once. Run it on Jev, Clef and any other decision model, and see which one agrees with your labels.**

Decision models (TypeSafe **Jev**, Cloudflare **Clef**, OpenAI's Decisions API, …) answer typed questions with probabilities instead of prose. Every vendor publishes benchmarks; none of them is about your cases. Verdict turns a rubric — criteria, scales, levels — into the questions these models take, sends the same questions to each, and puts the answers side by side:

```bash
npm install -g @verdict-ai/cli
verdict run -r examples/models/intent.yaml -d examples/models/cases.jsonl --models jev,clef,clef-flash
```

```text
Wants a human × cases.jsonl: 4 case(s), 3 model(s), the same questions to each
  model        answered by             agreed with labels   failed   asked a human   input tokens   calls   time
  jev          typesafe/jev-1.14.0     7/8 (88%)            0        0               2,041          4       0.5 s
  clef         cloudflare/clef         7/8 (88%)            0        0               1,547          4       0.9 s
  clef-flash   cloudflare/clef-flash   8/8 (100%)           0        0               1,547          4       0.4 s
the models gave one answer on 7 of 8 question(s) they all answered; they differ on 1:
  explicit · urgency   expected medium   jev low (0.67) | clef low (0.53) | clef-flash medium (0.11)
```

That is a real run of the [example](examples/models) in this repository (2026-11-11); for your own, start from `verdict rubric init` and a file of cases. Four cases say nothing about which model is better — the point is that the table is about *your* cases once you bring them. The rubric file is not edited: `--models` re-points its decision judges, one run per model, and each run is kept, so `verdict diff --base run_… --head run_…` shows any two case by case. A model is `jev`, `clef`, `clef-flash`, or `provider:model` (`typesafe:jev-1.14.0`, `openrouter:typesafe/jev-1.13`, `openai:<model>`, `systemone:<model>` for any endpoint that speaks the same request). Each provider's key comes from your environment (`TYPESAFE_API_KEY`; `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`; `OPENROUTER_API_KEY`; `OPENAI_API_KEY`); a model that cannot answer gets a row that says why. **Checked against the live services: Jev, Clef, Clef-flash, OpenRouter and OpenAI's Decisions API** — what each was sent, what it answered and when is in [docs/PROVIDERS.md](docs/PROVIDERS.md).

**Then keep the rubric where every machine can reach it.** A Verdict server (this repository, self-hosted) stores every frozen version and says which one each environment runs. `verdict login`, then `verdict push intent.yaml` uploads a version; any other machine judges with it by name — `verdict run -r intent --env prod -d cases.jsonl` — with no rubric file and its own model keys. The server never receives a case, an input or an answer. See [Using a rubric from any machine](website/guide/versions.md#using-a-rubric-from-any-machine).

## Models and inputs

| Name it | Model | Service | Checked against the live service | Images |
| --- | --- | --- | --- | --- |
| `jev` | Jev | TypeSafe | Yes | No, text only |
| `clef` | Clef | Cloudflare Workers AI | Yes | Up to 4 |
| `clef-flash` | Clef-flash | Cloudflare Workers AI | Yes | Up to 4 |
| `openrouter:<model>` | For example `typesafe/jev-1.13` | OpenRouter | Yes | No |
| `openai:<model>` | OpenAI's Decisions API, for example `gpt-6-luna` | OpenAI | Yes | No |
| `systemone:<model>` | Any endpoint that takes the same request | Yours | You check it | No |

| Input | With `verdict eval -i` | What the judge receives |
| --- | --- | --- |
| Text | `text:…`, a text file, or `-` | the text |
| File | a `.pdf`, `.html`, `.md`, `.txt` or `.json` path | its text |
| JSON | `json:{…}` | the document, checkable against a schema |
| Web page | a URL | the page's visible text; with `--screenshot`, a picture too |
| YouTube | a YouTube URL | the transcript |
| Image | a `.png`, `.jpg` or `.webp` path | the picture, for models that take images |

Rules (`benchmark`), people (`human`) and prompted models (`llm`) can judge a criterion too. Keys, context sizes and what each scale becomes: [Models and inputs](https://docs.verdict-ai.dev/reference/models).

## Verdict — the evaluation engine API

**Score anything, your way.** Send documents, websites, YouTube links, JSON or raw text; define *what* to grade (criteria), *who* grades it (decision models such as Jev or Clef, humans, deterministic benchmarks) and *how* scores roll up (aggregation). Get a number, a grade, a pass/fail and per-criterion probability distributions back in one call — via REST, CLI, MCP or the TypeScript SDK.


Think "Resend for evaluation": one small, well-typed API that every product with a grading step can call.

**Built on decision models, not chat models.** A rubric is a set of typed questions. Decision models ("System One" models: TypeSafe **Jev**, Cloudflare **Clef** / Clef-flash, OpenAI **Decisions API**, Inception Mercury Decide, …) take a `state` plus typed questions and return calibrated probabilities over the allowed answers in ~100–500 ms, with no prose to parse, at a fraction of LLM cost. Verdict turns every criterion into one `score` (ordered rubric levels), `noul` (yes/no probability), or `choice` (categorisation) question and answers the **whole rubric in a single request**. Choice criteria support categorisation and routing; pre-screen checks can flag, fail, or abort an evaluation before scoring. Generative LLMs remain available as an optional judge where you need a written rationale.

**Calibration.** Compare stored decision ratings (including escalations) with human consensus using `verdict calibrate <rubricId>`, `rubrics.calibration(id)` in the SDK, or the MCP `calibration_report` tool. Reports include agreement, normalized error and bias, confidence buckets, ECE, human inter-rater alpha, and a suggested `minConfidence` (default target agreement 0.8). A threshold is suggested only when every populated bucket at or above it meets the target with at least three pairs (empty buckets are skipped); empty metrics and uncomputable alpha are null. Bins include their lower bound; confidence 1 belongs to the last bin. Local tools use up to 1,000 stored evaluations; REST/SDK accept `limit`.

**Check a rubric against people.** Before trusting a rubric as a judge, run it over subjects people already judged: `verdict check -r rubric.yaml -g gold.jsonl` or the MCP `check_against_humans` tool. A gold set is a JSON array or JSON lines of `{ id?, name, inputs, expected?: { <criterion>: label }, human?: { passed?, criteria? }, labelSource?, split? }`: `expected` is the newer name for `human.criteria`, choice criteria take an option id, `labelSource` is `human | ai_unreviewed | ai_reviewed | external | unknown`, and `split` is `development | evaluation`. Labels the rubric cannot read are rejected before any judge runs. The report gives how many of Verdict's verdicts match the humans, agreement per labelled criterion and per split, label-source counts, how many subjects low-confidence escalation handed to a human (counted neither way), and each disagreement. Local engine only.

**Version, fork and compare rubrics.** `verdict version freeze rubric.yaml` freezes a rubric into a content-addressed version (`rv_…`; the same rubric gets the same id anywhere) and records it in `verdict.lock`. `verdict fork rv_… --to mine.yaml` copies a version to edit, keeping its parent. `verdict run -r mine.yaml -d cases.jsonl` runs a version over gold cases and stores the run. `verdict diff --base rubric.yaml --head mine.yaml -d cases.jsonl` compares the two case by case: fixed, regressed, kept, asked a human, errors, and answers that moved close to flipping. It is called a rubric change only when nothing but the rubric differed (same cases, model, policy) and a policy change when only thresholds, values, weights or aggregation differ — then the base run's recorded answers are re-scored under the new policy with no judge calls; stored runs are reused, and `--fail-on regressed` makes it a CI gate. `--labels new.jsonl` and `verdict rescore run_… -d new.jsonl` re-score stored runs against corrected labels without calling judges. `verdict version verify` fails when a committed rubric file no longer matches its locked version. `verdict eval`, `check` and `compare` warn when a locked rubric file changed or now sends other questions or reaches another model than its locked run (`--strict` fails). In pull requests, the [`actions/diff`](actions/diff/action.yml) GitHub Action posts the comparison as a comment and fails on regressions ([guide](website/guide/versions.md)). `verdict run … --report`, `verdict diff … --report` and `verdict report run_…` send a run's numbers — never its cases, inputs or answers — to a project on your team's Verdict server. `verdict watch` shows any two stored runs side by side at `/compare`: the kind of comparison first, the rubric diff, then each case with both answer distributions, regressions first. Local engine only.

**Publish to a hub.** `verdict hub login --hub https://hub.example` signs in with GitHub's device flow. `verdict publish rubric.yaml --slug agent-intent --license CC-BY-4.0 --cases cases.jsonl --case c1 c2 --run run_…` shows the hub's preview (exactly what would become public: the version, only the named cases, the numbers of the named runs) and publishes after you confirm; `verdict withdraw pub_…` takes it down. Nothing else leaves your machine. Anyone can browse published cards at `https://hub.example/hub` (no account) and take one: `verdict pull hub:alice/agent-intent@rv_…` copies it exactly — the file freezes to the same version id, checked locally — with its public cases; `verdict fork hub:alice/agent-intent@rv_… --to mine.yaml` starts your own version with the hub card recorded as its parent and licence in `verdict.lock`.

**Run a version per environment.** A Verdict server keeps your team's frozen rubric versions and says which one each environment runs; it never receives a case, an input or an answer. Commit a `verdict.yaml` (`project: support-bot`, optionally `server: https://verdict.example.com`), sign in with `verdict login` (`--with-key` saves a key your server's operator issued; one key per server), then `verdict project create support-bot` and `verdict env create prod`. `verdict promote rubrics/intent.yaml --env prod` uploads the version the lock says was frozen, shows `intent: rv_old → rv_new`, asks, and applies it only if `prod` is still where it was shown — someone else's change in between is refused, not overwritten. `verdict promote --from staging --env prod` copies what staging runs, `verdict rollback intent --env prod` undoes the latest change, and `verdict env history` says who changed what, when and why. The name services ask for a rubric by (`--name`, else the rubric's `id`, else its file name) is recorded in `verdict.lock` on first upload. Another machine needs no rubric file: after `verdict login`, `verdict run -r intent --env prod -d cases.jsonl` (also `eval`, `check`, `compare`, `diff`) fetches the version prod runs, checks that it freezes to the id the server named, and judges with it there, with that machine's own model keys; `-r intent@latest` is the newest upload and `-r intent@rv_…` one version, used without the server once it has been fetched. `verdict push rubrics/intent.yaml` freezes and uploads in one step, which is how a rubric still being worked on is shared, and `verdict pull intent --env prod` writes a version into a file to edit. A service then reads its environment with the SDK and judges on its own machine: `const prod = verdict.environment({ project: "support-bot", environment: "prod" }); const { rubric, versionId, source } = await prod.rubric("intent");` keeps what it received, asks the server again at most once a minute (so a promotion or rollback arrives without a deploy), and keeps answering with the version it holds when the server cannot be reached. [`examples/control-plane`](examples/control-plane) runs the whole loop locally with no model key.

**Watch evaluations live.** `verdict watch` serves a local page (http://127.0.0.1:4600) over the evaluations in `.verdict/` or `VERDICT_DATA_DIR`. A single evaluation shows its score, gates, criteria and the lines of its text that changed since the previous evaluation of the same rubric. A batch (`verdict compare`, `POST /v1/batches`) shows a leaderboard; when the same rubric compares the same subjects again, each row shows its score in every round and how many places it moved.

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
| **Any input** | `text`, `json`, `file` (PDF/MD/TXT/CSV/HTML/JSON — path or base64), `url` (optionally with a `screenshot` for vision judges), `image` (PNG/JPEG/WebP), `youtube` (transcript + description). Ingestors are pluggable. |
| **Any criteria** | Numeric / binary / ordinal scales per criterion, weights, anchors (level descriptions), groups, optional criteria, per-criterion input filters. |
| **Any judge** | `decision` (**default** — Jev via TypeSafe, Clef on Cloudflare Workers AI, OpenRouter, OpenAI Decisions, any `/v1/systemone`-compatible endpoint; per-level probabilities, confidence gates, escalation to humans), `human` (multi-rater, inbox, submit via API), `benchmark` (regex, keywords, length, JSON path, formula, similarity, external scorer), `llm` (generative judge with rationale + quotes), `panel` (combine several judges: mean/median/min/max/majority). Mix freely per criterion. |
| **Any aggregation** | `weighted_mean`, `weighted_sum`, `mean`, `median`, `min`, `max`, `geometric_mean`, or a custom **formula** over criterion scores. Rater aggregation (mean/median/trimmed/majority), gates, grades/tiers, pass thresholds, missing-score policy, output range. Re-aggregate any past evaluation without re-judging. |
| **Any surface** | REST API (Node or Cloudflare Workers), `verdict` CLI, MCP server (for agents), TypeScript SDK. Multi-tenant API keys, webhooks with HMAC signatures, batches with rankings. |

## Documentation

Read the [Verdict documentation](https://docs.verdict-ai.dev) for guides, API references, and complete example rubrics.

## Install

Requires Node 20 or newer. Choose the surface you need:

```bash
npm install @verdict-ai/sdk                    # typed REST client
npm install @verdict-ai/core                   # embedded engine
npm install @verdict-ai/api @verdict-ai/db         # self-hosted service and persistence
npx @verdict-ai/cli eval -r rubric.yaml -i ./evidence.txt
npx @verdict-ai/mcp                            # stdio tools for agents
```

The default npm scope is `@verdict`. If unavailable, use the fallback `@verdicthq`: run `scripts/set-scope.sh @verdicthq` before release. It updates manifests, internal imports/tests, lockfile references, README examples, and website text, printing changed files. It is idempotent and can switch back with `scripts/set-scope.sh @verdict`.

### Maintainer release

From a clean tree, run `scripts/release.sh 0.1.0 --dry-run` to bump only publishable package versions temporarily, build, test, preview publication, and inspect each tarball. The preview restores manifests on exit. `scripts/verify-packages.sh` also checks file allowlists and inspects manifests packed by pnpm to verify that `workspace:*` becomes a concrete version.

Run `scripts/release.sh 0.1.0 --tag-only` to bump the publishable package versions, build, test, and push a `Release v0.1.0` commit to `main`. The release workflow publishes every package whose version is not on npm yet with provenance (`NPM_TOKEN` secret) and then creates the `v0.1.0` tag. It leaves the private root, examples, and website versions untouched. `scripts/release.sh 0.1.0` without a flag publishes from the local machine instead and pushes the tag itself; a locally published version does not gain provenance retroactively, so prefer the workflow path.

Configure `NPM_TOKEN` in GitHub Actions as a **granular automation token** with publish access to the selected scope. The workflow uses Node 22, registry authentication, and `id-token: write` for provenance. Root LICENSE is copied into packages by `prepack`; generated copies are ignored by git.

Build docs with `pnpm --filter verdict-website build`. `scripts/deploy-docs.sh` deploys it as a Cloudflare Worker with static assets (`website/wrangler.toml`) at `docs.verdict-ai.dev`. The docs workflow deploys main using the `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` secrets; the token needs Workers Scripts: Edit and, for the domain, Workers Routes: Edit on the zone.

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
# SQLite file through Drizzle (same schema + migrations as Cloudflare D1), DB-managed API keys
pnpm verdict keys create --database ./verdict.sqlite --tenant acme --name ci      # prints vk_live_… once
VERDICT_ADMIN_KEY=change-me pnpm verdict serve -p 8787 --database ./verdict.sqlite

# or zero-setup: env keys + JSON files
VERDICT_API_KEYS="sk_live_abc:acme,sk_live_def:globex" pnpm verdict serve -p 8787 --data-dir ./data
curl -s localhost:8787/v1/evaluations -H "authorization: Bearer sk_live_abc" -H "content-type: application/json" \
  -d '{"rubric":{"name":"kw","criteria":[{"id":"k","name":"Mentions pricing","judge":{"type":"benchmark","method":"keywords","keywords":["pricing","plans"]}}]},"inputs":[{"type":"url","url":"https://example.com"}]}'
```

### Storage

Use a SQLite file (`--database ./verdict.sqlite`), Cloudflare D1 (`fromD1(env.DB)`), or a Postgres URL for self-hosting, Supabase, Neon or RDS. API keys stay hashed in the database. Both Node backends apply their migrations on startup.

```bash
VERDICT_DATABASE=postgres://user:password@localhost:5432/verdict pnpm verdict serve
pnpm verdict keys create --database postgres://user:password@localhost:5432/verdict --tenant acme --name ci

# Generate migrations after updating both schemas:
pnpm --filter @verdict-ai/db db:generate
pnpm --filter @verdict-ai/db db:generate:pg
# Apply Postgres migrations explicitly (build first):
DATABASE_URL=postgres://user:password@localhost:5432/verdict pnpm --filter @verdict-ai/db db:migrate:pg
# D1:
pnpm --filter @verdict-ai/db db:migrate:local
pnpm --filter @verdict-ai/db db:migrate:remote
```

### SDK

```ts
import { Verdict } from "@verdict-ai/sdk";
const verdict = new Verdict({ apiKey: process.env.VERDICT_API_KEY, baseUrl: "https://api.yourhost" });

const rubric = await verdict.rubrics.create(yamlOrObject);
const ev = await verdict.evaluations.create({ rubric: rubric.id, name: "Acme", inputs: [{ type: "youtube", url }] });
ev.aggregate.score; ev.aggregate.grade; ev.criteria[0].ratings[0].rationale;

await verdict.evaluations.submitScore(ev.id, { criterionId: "team", raterId: "partner_a", score: 4 });
await verdict.evaluations.reaggregate(ev.id, { method: "min" });
const { ranking } = await verdict.batches.create({ rubric: rubric.id, subjects: [...] });

const { evaluation, replayed } = await verdict.evaluations.createIdempotent(
  { rubric: rubric.id, name: "Acme", inputs: [{ type: "youtube", url }] },
  "acme-review-123",
);
// batches.createIdempotent(params, key) returns { evaluations, ranking, replayed }.
// create(), createAsync(), and batches.create() also accept { idempotencyKey } as a second argument.

```

### MCP (agents)

```jsonc
// claude_desktop_config.json / any MCP host
{ "mcpServers": { "verdict": { "command": "verdict", "args": ["mcp"], "env": { "ANTHROPIC_API_KEY": "…" } } } }
// or point at a hosted API:  "env": { "VERDICT_API_URL": "https://api.yourhost", "VERDICT_API_KEY": "sk_…" }
```

Tools: `validate_rubric`, `create_rubric`, `list_rubrics`, `evaluate`, `compare`, `get_evaluation`, `submit_human_score`, `reaggregate`, `list_human_tasks`, `calibration_report`, `check_against_humans`, and for a hub (`VERDICT_HUB_URL`) `hub_search`, `hub_get`, `fork_rubric` — fork a published card into your rubrics and `evaluate` with it.

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

**Idempotency.** Send `Idempotency-Key: <key>` (1–255 characters) on `POST /v1/evaluations` or `POST /v1/batches` to retry safely within a tenant. A matching request returns the stored result with HTTP 200 and `Idempotency-Replayed: true`, without running judges again. Reusing a key with a different body returns HTTP 409 (`idempotency_conflict`). Keys expire after 24 hours by default. `async` and `includeEvidence` do not affect request identity. Async replays return the stored `{ id, status, url }` summary. Evaluation documents expose `idempotencyKey`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/rubrics` | Create (JSON body, or YAML with `content-type: application/yaml`) |
| `POST` | `/v1/rubrics/validate` | Validate without storing |
| `GET` | `/v1/rubrics?limit=100` | List tenant rubrics |
| `GET/PUT/DELETE` | `/v1/rubrics/:id` | Read / replace / delete |
| `POST` | `/v1/evaluations` | Evaluate. `rubric` = id or inline. `inputs` or `subject`. `async:true` → `202 {id,status:"queued",url}`; queue retries when configured. `webhook` for completion. |
| `GET` | `/v1/evaluations?rubric=&status=&limit=50` | List tenant evaluations |
| `GET` | `/v1/evaluations/:id` | Status, per-criterion scores, ratings, rationales, quotes (`?evidence=true` includes ingested text) |
| `POST` | `/v1/evaluations/:id/retry` | Re-enqueue a failed evaluation; reset attempts (202; 404 unknown, 409 not failed) |
| `POST` | `/v1/evaluations/:id/scores` | Human rater submits `{criterionId, raterId, score, rationale?}` |
| `POST` | `/v1/evaluations/:id/aggregate` | Re-aggregate with a different `aggregation` (optionally `persist`) |
| `GET` | `/v1/tasks?rater=` | Pending human tasks |
| `POST` | `/v1/batches` | Many subjects, one rubric → ranking; the evaluations share a `batchId` |
| `GET` | `/v1/hub/config` | No key needed: `{ github: { clientId } \| null, publishing, signIn? }` — how authors sign in. `signIn: { kind: "browser", start, token }` means the server runs sign-in itself and `verdict login` follows it: a code to approve in the browser, then a key |
| `POST` | `/v1/hub/login` | No key needed: `{ githubToken }` from GitHub's device flow → 201 `{ apiKey, keyId, handle, tenantId }`. The token is verified with GitHub (against this OAuth app when `GITHUB_CLIENT_SECRET` is set) and not stored |
| `GET` | `/v1/hub/me` | Who this key publishes as |
| `DELETE` | `/v1/hub/keys/:id` | Revoke one of this account's hub keys (sign out) |
| `POST` | `/v1/publications/preview` | Build a hub publication without storing it: `{ ok, issues, warnings, publication }` — exactly what `POST /v1/publications` would store |
| `POST` | `/v1/publications` | Publish a rubric version (one criterion; licence; yes/no criteria need a `threshold`), cases marked `visibility: public` (text/json/url inputs) and run summaries (numbers only). 201 new, 200 same version again, 400 with `issues`, 409 withdrawn version, 413 over 1 MB |
| `GET` | `/v1/publications` | This tenant's publications, withdrawn included |
| `DELETE` | `/v1/publications/:id` | Withdraw (leaves search; public reads answer 410) |
| `GET` | `/v1/public/rubrics?q=&domain=&locale=&type=&owner=&limit=` | No key needed: search published cards, one result per `owner/slug` at its newest live version (limit ≤ 50) |
| `GET` | `/v1/public/rubrics/:owner/:slug?version=` | No key needed: `{ publication, versions }` — a card at a version (default: newest live) and its history. 404 unknown, 410 withdrawn |
| `GET` | `/v1/public/publications/:id` | No key needed: one publication. 410 withdrawn |
| `GET` | `/hub`, `/hub/:owner/:slug` | No key needed: the same reads as HTML pages (no scripts), with copyable `verdict pull` / `verdict fork` commands |
| `POST/GET` | `/v1/projects` | Create a project (`{ name }`: lowercase letters, digits, dashes; 409 `already_exists`) / list this tenant's projects |
| `DELETE` | `/v1/projects/:project` | Delete a project and everything in it. Body `{ confirm: "<name>" }` |
| `POST/GET` | `/v1/projects/:project/environments` | Create an environment (`{ name }`) / list |
| `GET` | `/v1/projects/:project/environments/:env[?include=rubrics]` | The environment and its pointers: `{ name, createdAt, pointers: [{ name, versionId, updatedAt }] }`. `include=rubrics` adds each `rubric` document — everything a service needs in one answer. Answers carry an `ETag`; `If-None-Match` gets 304 while nothing changed |
| `DELETE` | `/v1/projects/:project/environments/:env` | Delete an environment and its pointers; its history stays. Body `{ confirm: "<name>" }` |
| `POST` | `/v1/projects/:project/rubrics/:name/versions` | Upload an immutable rubric version `{ id, rubric, parentVersionId?, fork? }` under the name services ask for. The server freezes the rubric again and refuses another id. 201 new, 200 already there, 413 over 1 MB |
| `GET` | `/v1/projects/:project/rubrics` | Rubric names with version counts |
| `GET` | `/v1/projects/:project/rubrics/:name/versions[/:id]` | Versions newest first (without rubric documents, `?limit=`) / one version with its rubric |
| `DELETE` | `/v1/projects/:project/rubrics/:name/versions/:id` | Delete a version no environment points at (409 `in_use`) |
| `POST` | `/v1/projects/:project/environments/:env/promotions` | Move pointers, all or none: `{ changes: [{ name, versionId, expected }], note? }` (≤ 20). `expected` is the version you saw (`null`: none); `versionId: null` removes the pointer. 409 `pointer_conflict` with `error.current` when stale, 400 `unknown_version` |
| `POST` | `/v1/projects/:project/environments/:env/rollbacks` | Undo a pointer's latest change: `{ name, expected, note? }`. 409 `pointer_conflict` / `nothing_to_roll_back` |
| `GET` | `/v1/projects/:project/history?environment=&name=&limit=` | Pointer changes, newest first: who, when, from, to, kind (`promote` / `rollback` / `unset`), note |
| `POST` | `/v1/projects/:project/reports/runs` | Report a run's numbers `{ name, run, report, datasetName?, source?, version? }`: conditions, counts, agreement, usage, commit/branch/CI link. No case ids, inputs or outputs. `version` uploads the run's rubric version when the server lacks it. 201 new, 200 already reported, 400 `unknown_version` |
| `GET` | `/v1/projects/:project/reports/runs[/:runId]?name=&versionId=&dataset=&limit=` | Run reports, newest run first / one report |
| `POST` | `/v1/projects/:project/reports/comparisons` | Report a comparison of two reported runs `{ name, comparison, source? }`: counts per criterion, no per-case rows. 400 `unknown_run` |
| `GET` | `/v1/projects/:project/reports/comparisons?name=&head=&limit=` | Comparison reports, newest first |
| `POST/GET/DELETE` | `/v1/admin/keys[/:id]` | Create / list (`?tenant=`) / revoke API keys. Needs `VERDICT_ADMIN_KEY` and a database store. |
| `GET` | `/v1/admin/publications?q=&owner=&slug=` | Every publication on the hub, withdrawn included, with its tenant. Needs `VERDICT_ADMIN_KEY` |
| `POST` | `/v1/admin/publications/:id/takedown` | `{ reason }`: take a publication down; public reads answer 410 with the reason |
| `POST` | `/v1/admin/publications/:id/restore` | Put back a publication the operators took down (409 for one its author withdrew) |
| `GET` | `/v1/rubrics/:id/calibration?target=0.8&buckets=5&limit=1000` | Decision confidence calibration against humans |
| `GET` | `/v1/openapi.json`, `/v1/health` | Discovery |

Auth: `Authorization: Bearer <key>`. With a database store, keys live hashed in the `api_keys` table (create them via `/v1/admin/keys` or `verdict keys create`); `VERDICT_API_KEYS="key:tenant,..."` adds bootstrap keys, and with no database and no env keys the API runs open as a single tenant. Errors: `{ "error": { "type": "validation|not_found|idempotency_conflict|rate_limited|http|internal", "message", "issues?" } }`. The hub's open doors are rate-limited: sign-in 10/min per client, publishing (previews included) 30/min per account, public reads 300/min per client; over the limit is 429 with `Retry-After` (on Workers, bind `HUB_*_LIMITER` rate limits to share counts across isolates; see `packages/api/wrangler.example.toml`). Webhooks carry `verdict-signature: sha256=<hmac>` when `VERDICT_WEBHOOK_SECRET` is set.

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
| `VERDICT_DATABASE` | SQLite file for the Node server (Drizzle + better-sqlite3; same schema and migrations as D1). Enables DB-managed keys. |
| `VERDICT_API_KEYS` | `key:tenant,key2:tenant2` bootstrap keys for the API |
| `VERDICT_ADMIN_KEY` | Bearer token for `/v1/admin/*` (key management, hub takedowns) |
| `VERDICT_ROUTES` | Route groups to serve, comma-separated: `evaluations`, `rubrics`, `hub`, `control` (projects). Unset serves all; a group left out answers 404 |
| `VERDICT_DATA_DIR` | Persist to JSON files instead (CLI default `./.verdict`; API default memory) |
| `VERDICT_WEBHOOK_SECRET` | HMAC signing of webhook deliveries |
| `VERDICT_ALLOW_LOCAL_FILES=1` | Let the API read `file.path` inputs (off by default; CLI/MCP local mode allow it) |
| `VERDICT_API_URL`, `VERDICT_API_KEY` | Make the CLI / MCP server talk to a hosted API instead of the local engine |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Hub sign-in with GitHub (OAuth App with Device Flow enabled). With a client id set, only signed-in GitHub accounts can publish, under their login |
| `VERDICT_HUB_URL`, `VERDICT_HUB_KEY` | The server `verdict hub` / `publish` / `withdraw` / `pull` / `fork hub:…`, the management commands (`project`, `env`, `push`, `promote`, `rollback`, `report`) and the MCP hub tools talk to, and a key for CI (otherwise `verdict login` keeps one key per server in `~/.config/verdict/hub.json`) |
| `VERDICT_PROJECT` | Project the management commands and `--report` work on. Read after `--project` and before the `project:` of the nearest `verdict.yaml` (which may also name the `server:`) |
| `VERDICT_ORG` | Organization those commands work in, on servers where one sign-in reaches several (`--org`, else this, else `org:` in `verdict.yaml`; default: your own). Sent as `x-verdict-org`; servers without organizations ignore it |

Secrets never live in rubrics: judges reference them with `apiKeyEnv: MY_KEY_VAR`.

## Developing with Codex CLI (ChatGPT subscription, OAuth)

Implementation work on this repo is meant to run through [OpenAI Codex CLI](https://github.com/openai/codex) authenticated with your ChatGPT plan rather than an API key:

```bash
scripts/setup-codex.sh            # installs codex, writes a headless-friendly config, runs `codex login` (ChatGPT OAuth)
scripts/setup-codex.sh --device   # headless machines: device-code login
codex login status                # should say logged in via ChatGPT
codex                             # start from the repo root; AGENTS.md carries the project rules
```

Running Codex **inside a cloud container** (Claude Code cloud, CI, a devbox) instead: the container's network policy must allow `auth.openai.com`, `chatgpt.com` and `api.openai.com`, then `scripts/codex-cloud.sh` writes a headless config and restores credentials from a `CODEX_AUTH_JSON` (or `CODEX_AUTH_JSON_B64`) secret — the contents of `~/.codex/auth.json` from any machine where you completed `codex login` — or falls back to `codex login --device-auth`. Drive it non-interactively with `codex exec "<task>"`.

`AGENTS.md` is the agent-facing guide (invariants, build/test commands, package layering). Logging in with `codex login` (browser or `--device-auth`) stores ChatGPT OAuth credentials in `~/.codex/auth.json`, so usage is billed to the subscription; keep `OPENAI_API_KEY` unset in the shell you run Codex from, and do not pin `model` in `config.toml` (explicit `gpt-5-codex` is rejected on ChatGPT accounts).

## Repository layout

```
packages/core   engine: schemas (zod), ingestion, judges, aggregation, stores, expression language
packages/db     Drizzle ORM schema, migrations, DrizzleStore + DrizzleAuth — Cloudflare D1 now, Postgres next
packages/api    Hono REST API — Node server (memory / JSON / SQLite) + Cloudflare Workers entry (D1)
packages/cli    `verdict` CLI (local engine or remote API)
packages/mcp    MCP server (stdio) — local engine or remote API
packages/sdk    TypeScript client
examples/       rubrics, inputs, SDK + MCP client scripts
docs/           ARCHITECTURE.md, RUBRICS.md
```

```bash
pnpm test        # core, db (SQLite + embedded Postgres), api, sdk, cli, mcp — 190 tests
pnpm typecheck
pnpm lint        # ESLint: typescript-eslint + sonarjs cognitive complexity + unit-size rules
pnpm quality     # Verdict scoring Verdict: measured metrics + a decision-model review of every source file
```

### Code quality, measured with Verdict

The repository scores itself with two rubrics (`examples/rubrics/code-quality-repo.yaml`, `code-quality-file.yaml`) grounded in ISO/IEC 25010 maintainability, the SIG/TÜViT property model and SonarQube's default gate: half the score is measured (v8 coverage, cognitive complexity ≤ 15, functions ≤ 60 lines, files ≤ 400 lines, duplication, lint, strict typing, `pnpm audit`), half is a line-weighted decision-model review of each file (cohesion, analysability, naming, error handling, types, comments, testability, dead code). `pnpm quality` prints both halves; judge failures are reported as ERR rather than scored.

| | Baseline | Now |
| --- | --- | --- |
| Overall | 73.0 | **90.0** |
| Measured half | 75.2 (C) | 98.0 (A) |
| File review (line-weighted) | 70.8 | 82.0 |
| Functions over cognitive complexity 15 | 16 | 0 |
| Duplicated lines | 1.98 % | 1.1 % (mirrored DB schemas) |
| Line / branch coverage | 91.5 / 88.0 % | 100 / 99.3 % of target |

Keeping the score: `pnpm lint` must pass with no warnings and the behaviour goldens (`pnpm smoke`) must be unchanged — CI checks both on every pull request and the full score on `main`. Raising it again is automated: `pnpm quality:improve` runs the [quality harness](docs/HARNESS.md) (score → brief → coding agent → verify → re-score → commit) until the target holds.

### Deploy to Cloudflare Workers + D1

```bash
scripts/deploy-cloudflare.sh                   # migrations → deploy → secrets → first tenant key → live smoke test
```

Or by hand:

```bash
cd packages/api                                # wrangler.toml is committed (D1 "verdict" as env.DB, Workers AI as env.AI)
wrangler d1 migrations apply verdict --remote  # migrations_dir = ../db/drizzle (generated by drizzle-kit)
wrangler deploy                                # bundle ≈ 1.4 MB gzip (unpdf dominates)
wrangler secret put TYPESAFE_API_KEY           # Jev. Clef-flash runs through the AI binding — no Cloudflare token in the Worker
wrangler secret put VERDICT_ADMIN_KEY          # enables /v1/admin/keys
```

For a fresh account: `wrangler d1 create verdict`, paste the new `database_id` into `wrangler.toml`, then the steps above. `wrangler.example.toml` documents every secret.

Schema changes: edit `packages/db/src/schema/sqlite.ts`, run `pnpm --filter @verdict-ai/db db:generate`, commit the new file under `packages/db/drizzle/`, apply with wrangler (D1) — the Node server applies pending migrations itself on start.

## Status

v0.2 — decision-model-first engine (Jev / Clef / OpenAI Decisions / System One-compatible), API, CLI, MCP, SDK with in-memory and file stores. Every decision adapter (TypeSafe, Cloudflare, OpenRouter, OpenAI Decisions) has been checked against its live service; [docs/PROVIDERS.md](docs/PROVIDERS.md) records what was sent, what came back and when. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#roadmap) for what's next.

MIT.


### Async & retries

POST /v1/evaluations with `async: true` returns 202 with a queued id and polling URL when a queue is configured. Node uses MemoryQueue (in-process; restart recovery requires a durable queue). Retries use exponential backoff starting at 2 seconds, capped at 5 minutes, with ±20% jitter and 5 attempts by default. Transient provider and ingestion failures retry; exhausted jobs become failed and dead-lettered. The evaluation's `job` field reports attempts, maxAttempts, lastError, nextAttemptAt and deadLettered. Terminal webhooks fire after retry classification.

Cloudflare Queues require Workers Paid. Run `wrangler queues create verdict-jobs && wrangler queues create verdict-dlq`, then uncomment the producer and consumer sections in packages/api/wrangler.toml. Without QUEUE, Workers use waitUntil to finish async requests in the background with no retries.
