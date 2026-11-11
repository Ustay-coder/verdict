# Rubric reference

A rubric is YAML or JSON validated by `@verdict-ai/core` (`schema/rubric.ts`). Unknown keys are stripped; defaults are filled.

```yaml
name: string                      # required
version: "1"                      # free-form
description: string               # shown to judges
context: string                   # who is evaluating what and why — strongly recommended for LLM judges
language: en | ko | ...           # rationale language (default: follow the inputs)
scale: <Scale>                    # default scale, default numeric 0..10
judges: { <name>: <Judge> }       # reusable judges, referenced with { type: ref, ref: <name> }
defaultJudge: <Judge>             # used by criteria without `judge`; default { type: decision, provider: typesafe }
inputSchema: <InputSchema>        # optional: what every json input must look like, checked before any judge runs
criteria: [ <Criterion>, ... ]    # at least one
aggregation: <Aggregation>
metadata: {}                      # yours
```

## Scale
```yaml
scale: { type: numeric, min: 0, max: 10, step: 0.5 }          # step optional
scale: { type: binary, labels: [fail, pass] }                   # 0 / 1
scale: { type: ordinal, labels: [poor, fair, good, excellent] } # values default to 0..n-1; override with values: [1,2,4,8]
```
Humans may submit labels (`"excellent"`, `"pass"`) or numbers; LLMs are told the mapping.

## Criterion
```yaml
- id: problem                 # identifier: letters, digits, _  (used in formulas)
  name: Problem clarity
  description: What a strong answer contains…
  weight: 2                   # default 1; 0 = reported but excluded from totals (still usable in gates)
  scale: <Scale>              # override rubric scale
  anchors:                    # what each level looks like — for decision models these ARE the rubric levels
    "1": No clear problem stated
    "3": Problem stated but audience or urgency vague
    "5": "Specific, painful, quantified problem for a named audience"
  levels:                     # explicit alternative to anchors: ordered worst → best, 2–10 entries, value on the scale
    - { value: 1, label: none, description: No clear problem stated }
    - { value: 5, label: sharp, description: Specific, quantified problem for a named audience }
  judge: <Judge> | [<Judge>, <Judge>]   # several = independent ratings, combined by `rater`
  rater: mean | median | trimmed_mean | min | max | majority   # override aggregation.rater
  inputs: [deck, brief]       # only evidence whose tag or label matches is shown to this criterion
  threshold: 0.6              # binary criteria only: P(true) at or above which a decision model's answer counts as true (default 0.5)
  optional: true              # missing score is excluded rather than subject to aggregation.missing
  group: Business             # reporting label
```

### Choice criteria

```yaml
- id: team
  name: Owning team
  choices: { support: General help, engineering: Bugs and outages, billing: Invoices and payments }
  # values: { support: 0, engineering: 10, billing: 5 }
```

Declare 2–255 options with identifier keys (`[a-zA-Z_][a-zA-Z0-9_]*`). `choices` cannot coexist with `levels`. Without `values`, the scale is ignored and the criterion is reported but excluded from totals, regardless of weight or missing policy. Optional `values` must cover every option with a raw score within the criterion scale; gates require values. Decision judges send a `choice` question and keep its option probabilities and confidence, including confidence escalation. Humans submit the option id as `score`; LLM judges return `choice`; benchmarks return an error. Results report the majority choice (ties follow declaration order) and mean option probabilities.

## Input schema

```yaml
inputSchema:
  type: object
  required: [utterance]
  properties:
    utterance: { type: string, minLength: 1 }
    recent_context: { type: string }
  additionalProperties: false
```

Declares what the subject's `json` inputs must contain. Every `json` input is checked before ingestion; a subject with no `json` input fails too. A mismatch fails the evaluation without fetching URLs or calling any judge: `status: failed`, `error: "invalid input: $.utterance is required"`, and `inputErrors: [{ input, path, message }]` (`input` is the input index, `null` when no json input was given). Invalid input is never retried by the queue, and `verdict check` counts such cases as `invalidInput` rather than as disagreements.

Supported keywords (a JSON Schema subset): `type` (one or a list of `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`), `properties`, `required`, `additionalProperties` (boolean or schema), `items`, `enum`, `const`, `minLength` / `maxLength` (code points), `pattern`, `minimum` / `maximum`, `minItems` / `maxItems`, plus `title` and `description`. Any other keyword (`format`, `oneOf`, `$ref`, …) is rejected when the rubric is parsed, so a schema never promises a check Verdict does not run. Text, file, url and other inputs are evidence for judges and are not checked.

## Pre-screen checks

```yaml
checks:
  - id: on_topic
    question: Is this a real support ticket?
    criteria: { true: A customer issue or request, false: Spam or unrelated text }
    expect: true
    threshold: 0.5
    action: abort
    message: Not a support ticket
checksJudge: { type: ref, ref: jev }
```

Checks run after ingestion and before criterion judging, in one decision request. `checksJudge` defaults to `defaultJudge` and must resolve to a decision judge. `criteria` is optional; `expect` defaults to true, `threshold` to 0.5, and `action` to flag. A check passes when `(P(true) >= threshold) == expect`.

`flag` records only; `fail` continues scoring and adds a failing `check:<id>` aggregate gate; `abort` completes with all criteria excluded, no score, and `passed: false`. Results appear in evaluation `checks` with id, probability, passed, action, and optional message. Provider errors record null probability and an error, and behave as flags unless action is abort, which completes with an evaluation error. Reaggregation preserves check results and fail gates without calling judges.

## Judges

### `decision` — decision models (default)
```yaml
{ type: decision, provider: typesafe | cloudflare | openrouter | openai | systemone | mock,
  model: jev-latest, baseUrl: https://…, apiKeyEnv: MY_KEY,
  instructions: "Extra guidance merged into every question",
  minConfidence: 0.35, onLowConfidence: accept | human | error, escalateTo: [alice, bob],
  options: { stateCharLimit: 80000, accountId: "…", request: { images: [] } } }   # only options.request is sent to the provider
```
How a criterion becomes a question:
- numeric / ordinal scale → `score` question whose ordered `criteria` are the criterion's **levels** (`levels` → `anchors` → ordinal labels → auto-buckets). The answer's per-level probabilities give an expected value on the scale (`Σ p_i · value_i`), snapped to `step` / ordinal values; `probabilities` and `confidence` are stored on the rating.
- binary scale → `noul` question; `anchors` keyed by the two labels (or `"0"` / `"1"`) describe the false / true cases. The answer is the true label when `p ≥ threshold` (criterion `threshold`, exclusive bounds 0–1, default 0.5). Decision models report no confidence for noul; Verdict derives a margin from the threshold — `(p − t)/(1 − t)` above it, `(t − p)/t` below, which is `|2p − 1|` at 0.5 — and uses it for `minConfidence`. Ratings record `raw.threshold` and `raw.thresholdSource` (`rubric` or `default`).
- Ratings keep `raw.requestedModel` (what was asked for — possibly an alias such as `jev-latest`), `raw.resolvedModel` (only when the provider's response names the model) and `raw.modelVerified`. `raw.model` keeps its earlier meaning: the resolved id when known, else the requested one.
- All criteria that share one decision judge spec **and** the same evidence are sent in a single request.

Providers and their env vars:

| provider | endpoint | key | default model |
| --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-latest` (`VERDICT_TYPESAFE_MODEL`) |
| `cloudflare` | `…/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{model}` (or `baseUrl` = AI Gateway) | `CLOUDFLARE_API_TOKEN` | `@cf/cloudflare/clef` (`clef-flash`, `typesafe/jev`) |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| `openai` | `https://api.openai.com/v1/decisions` (its own request shape; Verdict translates the questions) | `OPENAI_API_KEY` | `gpt-6-luna` |
| `systemone` | `baseUrl` + `/systemone` | `SYSTEMONE_API_KEY` | `jev-latest` |
| `mock` | in-process | — | options: `level`, `normalized`, `probabilities`, `noul` |

Limits to design around (Jev 1.13 public figures): 64k tokens per request, 32k for state + longest question, 2–10 score levels, text-only state. Decision models do not explain themselves; pair a criterion with an `llm` judge when a written rationale is required.

### `llm` — generative judge (optional)
```yaml
{ type: llm, provider: anthropic | openai | cloudflare | http | mock,
  model: claude-opus-5-5, effort: low|medium|high|xhigh|max, samples: 3,
  instructions: "Extra guidance appended to the judge prompt",
  baseUrl: https://…, apiKeyEnv: MY_KEY, options: { … provider passthrough … } }
```
- `anthropic`: Claude with structured output, prompt caching, refusal fallbacks. Default model `claude-opus-5-5`; `effort` default `medium`.
- `openai`: any OpenAI-compatible endpoint (`OPENAI_BASE_URL`), JSON-schema response format.
- `cloudflare`: Workers AI REST (`CLOUDFLARE_ACCOUNT_ID` + token) or an AI Gateway via `baseUrl`.
- `http`: POST `{system, user, criterion, scale, evidence, schema}` to your service; respond `{score, confidence?, rationale?, quotes?}`.
- `samples > 1`: self-consistency — median score, confidence reduced by disagreement.
- Use it for criteria that need a written rationale or quotes; decision models are faster and cheaper for the score itself.

### `human`
```yaml
{ type: human, raters: [alice, bob, carol], required: 2, instructions: "Shown in the task inbox" }
```
`required` ratings are needed before the criterion is final. If `raters` lists more people than `required`, any of them may fill a slot; if it lists exactly `required` (or fewer), each named rater has their own slot. Empty `raters` = anyone with API access to the tenant. Submit with `POST /v1/evaluations/:id/scores`, `verdict score`, or the MCP tool.

### `benchmark` — deterministic
| method | fields | score |
| --- | --- | --- |
| `regex` | `pattern`, `flags`, `perMatch`, `negate` | match → 1 (or `min(count*perMatch,1)`); `negate` inverts |
| `keywords` | `keywords[]`, `mode: all\|any\|ratio`, `caseSensitive` | fraction of keywords present (ratio) or 0/1 |
| `length` | `unit: words\|chars\|lines`, `min`, `max`, `tolerance` | 1 inside `[min,max]`, decays linearly to 0 at `tolerance × span` outside |
| `jsonpath` | `path` (dotted), `input` (tag/label), `map {value: score}`, `range [lo,hi]` | numbers rescaled by `range`; booleans; or mapped values |
| `formula` | `expression` | evaluated over `words`, `chars`, `lines`, `inputs` and every number in JSON inputs (flattened, dotted) — must yield 0..1 |
| `similarity` | `reference`, `threshold` | cosine similarity over token bags (binary if `threshold`) |
| `http` | `url`, `headers`, `apiKeyEnv` | POST evidence; expects `{normalized}` or `{score}` |

Benchmarks return normalized 0..1 and are mapped back onto the criterion scale.

### `panel`
```yaml
{ type: panel, combine: mean | median | min | max | majority, judges: [ <Judge>, … ] }
```
`min` = any member can veto; `majority` works best with binary/ordinal scales. Human members keep the panel pending until they submit.

### `ref`
`{ type: ref, ref: claude }` — reuse a judge declared under `judges:`.

## Aggregation
```yaml
aggregation:
  method: weighted_mean | weighted_sum | mean | median | min | max | geometric_mean | formula
  formula: "safety_n < 0.5 ? 0 : relevance_n * 0.6 + quality_n * 0.4"
  rater: mean                 # default rater aggregation
  normalize: [0, 100]         # output range; false = natural units of the method
  missing: exclude | zero | fail   # criteria with no score (errors / not yet rated)
  gates:                      # hard constraints in the criterion's own units
    - { criterion: safety, min: 7, message: "Brand safety below bar" }
  grades: [{ label: A, min: 90 }, { label: B, min: 75 }, { label: C, min: 0 }]
  passThreshold: 70           # passed = all gates pass AND score >= threshold
  precision: 2
```
Formula variables for each criterion `x`: `x` (raw score), `x_n` (0..1), `x_w` (weight), `x_present` (1 if numerically scored). Choices also expose `x_<option>` (1 for the majority option, otherwise 0) and `x_p_<option>` (mean probability). Functions: `min max sum avg abs round floor ceil sqrt log exp pow clamp scale if`; operators `+ - * / % ^`, comparisons, `and or not`, `cond ? a : b`. A formula result in 0..1 is rescaled to `normalize`; otherwise it is treated as 0..100.

Any evaluation can be re-aggregated later with a different block (`POST /v1/evaluations/:id/aggregate`, `verdict reaggregate`, MCP `reaggregate`) — judges are not re-run.

## Inputs (subject)
```yaml
inputs:
  - { type: text, text: "...", label: notes, tags: [notes] }
  - { type: json, data: { … }, label: brief, tags: [brief] }
  - { type: file, path: ./deck.pdf }                  # CLI / MCP local; API needs VERDICT_ALLOW_LOCAL_FILES=1
  - { type: file, base64: "...", filename: deck.pdf, mimeType: application/pdf }
  - { type: url, url: https://acme.example, tags: [site] }
  - { type: youtube, url: https://youtu.be/VIDEO, lang: en, tags: [video] }
  - { type: image, path: ./screens/home.png, tags: [ui] }        # PNG/JPEG/WebP, or base64; sent to vision judges only
  - { type: url, url: http://localhost:5173/, screenshot: { width: 1280, height: 800, fullPage: false, settleMs: 1500 } }
```
`label`/`tags` let criteria scope their evidence (`inputs: [video]`) and let `jsonpath` pick an input (`input: brief`).
