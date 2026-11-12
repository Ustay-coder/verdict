# Everything Verdict does

Comparing decision models is where most people start. This page is the long version: every kind of input, judge and aggregation, and what else the engine does once you have a rubric.

**Score anything, your way.** Send documents, websites, YouTube links, JSON or raw text; define *what* to grade (criteria), *who* grades it (decision models such as Jev or Clef, humans, deterministic benchmarks) and *how* scores roll up (aggregation). Get a number, a grade, a pass/fail and per-criterion probability distributions back in one call — via REST, CLI, MCP or the TypeScript SDK.


Think "Resend for evaluation": one small, well-typed API that every product with a grading step can call.

**Built on decision models, not chat models.** A rubric is a set of typed questions. Decision models ("System One" models: TypeSafe **Jev**, Cloudflare **Clef** / Clef-flash, OpenAI **Decisions API**, Inception Mercury Decide, …) take a `state` plus typed questions and return calibrated probabilities over the allowed answers in ~100–500 ms, with no prose to parse, at a fraction of LLM cost. Verdict turns every criterion into one `score` (ordered rubric levels), `noul` (yes/no probability), or `choice` (categorisation) question and answers the **whole rubric in a single request**. Choice criteria support categorisation and routing; pre-screen checks can flag, fail, or abort an evaluation before scoring. Generative LLMs remain available as an optional judge where you need a written rationale.

**Calibration.** Compare stored decision ratings (including escalations) with human consensus using `verdict calibrate <rubricId>`, `rubrics.calibration(id)` in the SDK, or the MCP `calibration_report` tool. Reports include agreement, normalized error and bias, confidence buckets, ECE, human inter-rater alpha, and a suggested `minConfidence` (default target agreement 0.8). A threshold is suggested only when every populated bucket at or above it meets the target with at least three pairs (empty buckets are skipped); empty metrics and uncomputable alpha are null. Bins include their lower bound; confidence 1 belongs to the last bin. Local tools use up to 1,000 stored evaluations; REST/SDK accept `limit`.

**Check a rubric against people.** Before trusting a rubric as a judge, run it over subjects people already judged: `verdict check -r rubric.yaml -g gold.jsonl` or the MCP `check_against_humans` tool. A gold set is a JSON array or JSON lines of `{ id?, name, inputs, expected?: { <criterion>: label }, human?: { passed?, criteria? }, labelSource?, split? }`: `expected` is the newer name for `human.criteria`, choice criteria take an option id, `labelSource` is `human | ai_unreviewed | ai_reviewed | external | unknown`, and `split` is `development | evaluation`. Labels the rubric cannot read are rejected before any judge runs. The report gives how many of Verdict's verdicts match the humans, agreement per labelled criterion and per split, label-source counts, how many subjects low-confidence escalation handed to a human (counted neither way), and each disagreement. Local engine only.

**Version, fork and compare rubrics.** `verdict version freeze rubric.yaml` freezes a rubric into a content-addressed version (`rv_…`; the same rubric gets the same id anywhere) and records it in `verdict.lock`. `verdict fork rv_… --to mine.yaml` copies a version to edit, keeping its parent. `verdict run -r mine.yaml -d cases.jsonl` runs a version over gold cases and stores the run. `verdict diff --base rubric.yaml --head mine.yaml -d cases.jsonl` compares the two case by case: fixed, regressed, kept, asked a human, errors, and answers that moved close to flipping. It is called a rubric change only when nothing but the rubric differed (same cases, model, policy) and a policy change when only thresholds, values, weights or aggregation differ — then the base run's recorded answers are re-scored under the new policy with no judge calls; stored runs are reused, and `--fail-on regressed` makes it a CI gate. `--labels new.jsonl` and `verdict rescore run_… -d new.jsonl` re-score stored runs against corrected labels without calling judges. `verdict version verify` fails when a committed rubric file no longer matches its locked version. `verdict eval`, `check` and `compare` warn when a locked rubric file changed or now sends other questions or reaches another model than its locked run (`--strict` fails). In pull requests, the [`actions/diff`](actions/diff/action.yml) GitHub Action posts the comparison as a comment and fails on regressions ([guide](./versions)). `verdict run … --report`, `verdict diff … --report` and `verdict report run_…` send a run's numbers — never its cases, inputs or answers — to a project on your team's Verdict server. `verdict watch` shows any two stored runs side by side at `/compare`: the kind of comparison first, the rubric diff, then each case with both answer distributions, regressions first. Local engine only.

**Publish to a hub.** `verdict hub login --hub https://hub.example` signs in with GitHub's device flow. `verdict publish rubric.yaml --slug agent-intent --license CC-BY-4.0 --cases cases.jsonl --case c1 c2 --run run_…` shows the hub's preview (exactly what would become public: the version, only the named cases, the numbers of the named runs) and publishes after you confirm; `verdict withdraw pub_…` takes it down. Nothing else leaves your machine. Anyone can browse published cards at `https://hub.example/hub` (no account) and take one: `verdict pull hub:alice/agent-intent@rv_…` copies it exactly — the file freezes to the same version id, checked locally — with its public cases; `verdict fork hub:alice/agent-intent@rv_… --to mine.yaml` starts your own version with the hub card recorded as its parent and licence in `verdict.lock`.

**Run a version per environment.** A Verdict server keeps your team's frozen rubric versions and says which one each environment runs; it never receives a case, an input or an answer. Commit a `verdict.yaml` (`project: support-bot`, optionally `server: https://verdict.example.com`), sign in with `verdict login` (`--with-key` saves a key your server's operator issued; one key per server), then `verdict project create support-bot` and `verdict env create prod`. `verdict promote rubrics/intent.yaml --env prod` uploads the version the lock says was frozen, shows `intent: rv_old → rv_new`, asks, and applies it only if `prod` is still where it was shown — someone else's change in between is refused, not overwritten. `verdict promote --from staging --env prod` copies what staging runs, `verdict rollback intent --env prod` undoes the latest change, and `verdict env history` says who changed what, when and why. The name services ask for a rubric by (`--name`, else the rubric's `id`, else its file name) is recorded in `verdict.lock` on first upload. Another machine needs no rubric file: after `verdict login`, `verdict run -r intent --env prod -d cases.jsonl` (also `eval`, `check`, `compare`, `diff`) fetches the version prod runs, checks that it freezes to the id the server named, and judges with it there, with that machine's own model keys; `-r intent@latest` is the newest upload and `-r intent@rv_…` one version, used without the server once it has been fetched. `verdict push rubrics/intent.yaml` freezes and uploads in one step, which is how a rubric still being worked on is shared, and `verdict pull intent --env prod` writes a version into a file to edit. A service then reads its environment with the SDK and judges on its own machine: `const prod = verdict.environment({ project: "support-bot", environment: "prod" }); const { rubric, versionId, source } = await prod.rubric("intent");` keeps what it received, asks the server again at most once a minute (so a promotion or rollback arrives without a deploy), and keeps answering with the version it holds when the server cannot be reached. [`examples/control-plane`](https://github.com/Ustay-coder/verdict/tree/main/examples/control-plane) runs the whole loop locally with no model key.

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

Full reference: [docs/RUBRICS.md](https://github.com/Ustay-coder/verdict/blob/main/docs/RUBRICS.md). Design and extension points: [docs/ARCHITECTURE.md](https://github.com/Ustay-coder/verdict/blob/main/docs/ARCHITECTURE.md). More examples in [examples/rubrics](https://github.com/Ustay-coder/verdict/tree/main/examples/rubrics).

## Async and retries

POST /v1/evaluations with `async: true` returns 202 with a queued id and polling URL when a queue is configured. Node uses MemoryQueue (in-process; restart recovery requires a durable queue). Retries use exponential backoff starting at 2 seconds, capped at 5 minutes, with ±20% jitter and 5 attempts by default. Transient provider and ingestion failures retry; exhausted jobs become failed and dead-lettered. The evaluation's `job` field reports attempts, maxAttempts, lastError, nextAttemptAt and deadLettered. Terminal webhooks fire after retry classification.

Cloudflare Queues require Workers Paid. Run `wrangler queues create verdict-jobs && wrangler queues create verdict-dlq`, then uncomment the producer and consumer sections in packages/api/wrangler.toml. Without QUEUE, Workers use waitUntil to finish async requests in the background with no retries.

## Status

v0.3 — decision-model-first engine (Jev / Clef / OpenAI Decisions / System One-compatible), API, CLI, MCP, SDK, with in-memory, file, SQLite, D1 and Postgres stores. What changed in each release is in the [changelog](https://github.com/Ustay-coder/verdict/blob/main/CHANGELOG.md). Every decision adapter (TypeSafe, Cloudflare, OpenRouter, OpenAI Decisions) has been checked against its live service; [docs/PROVIDERS.md](https://github.com/Ustay-coder/verdict/blob/main/docs/PROVIDERS.md) records what was sent, what came back and when. See [docs/ARCHITECTURE.md](https://github.com/Ustay-coder/verdict/blob/main/docs/ARCHITECTURE.md#roadmap) for what's next.
