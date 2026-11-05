# Rubric reference

A rubric is YAML or JSON validated by `@verdict/core` (`schema/rubric.ts`). Unknown keys are stripped; defaults are filled.

```yaml
name: string                      # required
version: "1"                      # free-form
description: string               # shown to judges
context: string                   # who is evaluating what and why — strongly recommended for LLM judges
language: en | ko | ...           # rationale language (default: follow the inputs)
scale: <Scale>                    # default scale, default numeric 0..10
judges: { <name>: <Judge> }       # reusable judges, referenced with { type: ref, ref: <name> }
defaultJudge: <Judge>             # used by criteria without `judge`; default { type: decision, provider: typesafe }
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
  optional: true              # missing score is excluded rather than subject to aggregation.missing
  group: Business             # reporting label
```

## Judges

### `decision` — decision models (default)
```yaml
{ type: decision, provider: typesafe | cloudflare | openrouter | openai | systemone | mock,
  model: jev-latest, baseUrl: https://…, apiKeyEnv: MY_KEY,
  instructions: "Extra guidance merged into every question",
  minConfidence: 0.35, onLowConfidence: accept | human | error, escalateTo: [alice, bob],
  options: { accountId: "…", … } }
```
How a criterion becomes a question:
- numeric / ordinal scale → `score` question whose ordered `criteria` are the criterion's **levels** (`levels` → `anchors` → ordinal labels → auto-buckets). The answer's per-level probabilities give an expected value on the scale (`Σ p_i · value_i`), snapped to `step` / ordinal values; `probabilities` and `confidence` are stored on the rating.
- binary scale → `noul` question; `anchors` keyed by the two labels (or `"0"` / `"1"`) describe the false / true cases. `confidence = |2p − 1|`.
- All criteria that share one decision judge spec **and** the same evidence are sent in a single request.

Providers and their env vars:

| provider | endpoint | key | default model |
| --- | --- | --- | --- |
| `typesafe` | `https://api.typesafe.ai/v1/systemone` | `TYPESAFE_API_KEY` | `jev-latest` (`VERDICT_TYPESAFE_MODEL`) |
| `cloudflare` | `…/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/run/{model}` (or `baseUrl` = AI Gateway) | `CLOUDFLARE_API_TOKEN` | `@cf/cloudflare/clef` (`clef-flash`, `typesafe/jev`) |
| `openrouter` | `https://openrouter.ai/api/alpha/decisions` | `OPENROUTER_API_KEY` | `typesafe/jev-1.13` |
| `openai` | `https://api.openai.com/v1/decisions` (`noul` sent as `predicate`) | `OPENAI_API_KEY` | `gpt-6-luna` |
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
Formula variables for each criterion `x`: `x` (raw score), `x_n` (0..1), `x_w` (weight), `x_present` (1 if scored). Functions: `min max sum avg abs round floor ceil sqrt log exp pow clamp scale if`; operators `+ - * / % ^`, comparisons, `and or not`, `cond ? a : b`. A formula result in 0..1 is rescaled to `normalize`; otherwise it is treated as 0..100.

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
```
`label`/`tags` let criteria scope their evidence (`inputs: [video]`) and let `jsonpath` pick an input (`input: brief`).
