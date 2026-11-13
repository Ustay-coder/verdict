# Decision-model providers — verified contracts

What Verdict sends and expects per provider, and how much of it has been verified against a live endpoint or the
vendor's official documentation. Keep this honest: update the status column when you verify something.

| Provider | Endpoint | Request | Response | Verified |
| --- | --- | --- | --- | --- |
| `typesafe` (Jev) | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY` | `{ model, state, questions }` | `{ model, answers, usage }` | **Live** (2026-11-05, `jev-1.14.0`; again 2026-11-11 through `verdict run --models`) + official API reference |
| `cloudflare` (Clef) | `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef[-flash]`, `Authorization: Bearer $CLOUDFLARE_API_TOKEN` | `{ model: "clef"\|"clef-flash", state, questions, images? }` | `{ success, result: { model, answers, usage } }` | **Live** (2026-11-05, `clef-flash`, 0.40 s, HTTP 200; 2026-11-11 `clef` and `clef-flash` through `verdict run --models`) + official model pages |
| `openrouter` | `POST https://openrouter.ai/api/alpha/decisions`, `Authorization: Bearer $OPENROUTER_API_KEY` | System One shape, `model: typesafe/jev-1.13` | System One shape; `model` names the dated model that answered | **Live** (2026-11-11, `typesafe/jev-1.13`, answered by `typesafe/jev-1.13-20260917`, through `verdict run --models`) |
| `openai` (Decisions API) | `POST https://api.openai.com/v1/decisions`, `Authorization: Bearer $OPENAI_API_KEY` | Its own shape: `{ model, input, questions: [ … ] }` ([below](#openai-decisions-request-and-response)) | `{ model, answers: [ … ], usage }` | **Live** (2026-11-11, `gpt-6-luna`, through `verdict run --models`; the request shape was learned from the endpoint's own refusals) |
| `gemini` (Decisions API) | `POST https://generativelanguage.googleapis.com/v1beta/decisions`, `x-goog-api-key: $GEMINI_API_KEY` | System One with three fields renamed: `{ model, input, questions }` ([below](#gemini-decisions-request-and-response)) | `{ answers, usage }`, no `model` | **Live** (2026-11-12, `gemini-decision-1`, through `verdict run --models`; the three differences were confirmed by the endpoint's own refusals) |
| `systemone` | `baseUrl` + `/systemone` | System One shape | System One shape | By construction (same as Jev) |

## System One request (Jev; Clef-compatible)

```json
{
  "model": "jev-latest",
  "state": "<text or JSON — Verdict sends the rendered evidence>",
  "questions": {
    "urgency": { "type": "score", "instructions": "…", "criteria": ["none: …", "low: …", "high: …", "critical: …"] },
    "needs_engineer": { "type": "noul", "instructions": "…", "criteria": { "true": "…", "false": "…" } },
    "team": { "type": "choice", "instructions": "…", "criteria": { "support": "…", "engineering": "…" } }
  }
}
```

## System One response (verbatim from a live Jev call, `packages/core/test/fixtures/typesafe-systemone-response.json`)

```json
{
  "model": "jev-1.14.0",
  "answers": {
    "urgency": { "type": "score", "score": 3.0, "confidence": 1.0,
                 "legend": { "0": "none: …", "1": "low: …", "2": "high: …", "3": "critical: …" },
                 "probabilities": { "0": 0.0, "1": 0.0, "2": 0.0, "3": 1.0 } },
    "needs_engineer": { "type": "noul", "noul": 0.71 },
    "team": { "type": "choice", "choice": "engineering", "confidence": 1.0,
              "probabilities": { "support": 0.0, "engineering": 1.0, "billing": 0.0 } }
  },
  "usage": { "input_tokens": 480, "output_tokens": 71 }
}
```

Notes that matter for the engine:
- `score` is the probability-weighted level **index** (0-based, may be fractional). `probabilities` and `legend` are objects keyed by the index as a string, in level order. Verdict maps the distribution onto the criterion's level **values** (expected value), so a 1/3/5 anchor set yields a 1–5 score, not an index.
- Pre-screen checks are plain `noul` questions, batched in one request before criterion scoring.
- Choice answers use an option id in `choice` and an object keyed by option id in `probabilities`.
- `noul` has no `confidence`; Verdict derives a margin from the criterion `threshold` (`|2p − 1|` at the default 0.5) and records which threshold applied.
- `usage.output_tokens` is reported but free; `input_tokens` is billable. Both are added to the evaluation's usage.
- Models listed by `GET /v1/models`: `jev-latest` (currently 1.14.0) and `jev-preview`. Pin a version in production rubrics once TypeSafe exposes dated ids; log `answers.model` (Verdict stores it in `rating.raw.resolvedModel`, sets `raw.modelVerified`, and keeps the requested name — possibly the alias — in `raw.requestedModel`).
- Limits (Jev public docs): 64k tokens per request, 32k for state + longest question, score 2–10 levels, choice ≤255 options, text-only state.

## OpenAI Decisions request and response

OpenAI's endpoint asks the same three kinds of question in a shape of its own, and refuses any field it does not
know (`Unknown parameter: 'questions[0].criteria'`). Verdict translates the System One question for it:

| System One | OpenAI Decisions |
| --- | --- |
| `state` | `input` |
| `questions` as an object keyed by id | `questions` as an array; each carries its id as `name` |
| `score` with `criteria: ["label: description", …]` | `score` with `levels: [{ label, description }, …]` (at least 2) |
| `noul` with `criteria: { true, false }` | `predicate` with `instructions` only; the two descriptions are added to the instructions as "Yes means: … No means: …" |
| `choice` with `criteria: { value: description }` | `choice` with `choices: [{ value, description }, …]` (at least 2) |

```json
{
  "model": "gpt-6-luna",
  "input": "<the rendered evidence>",
  "questions": [
    { "name": "urgency", "type": "score", "instructions": "…", "levels": [{ "label": "none", "description": "…" }, { "label": "critical", "description": "…" }] },
    { "name": "needs_engineer", "type": "predicate", "instructions": "… Yes means: …. No means: …." },
    { "name": "team", "type": "choice", "instructions": "…", "choices": [{ "value": "support", "description": "…" }, { "value": "engineering", "description": "…" }] }
  ]
}
```

The answer (verbatim from a live call, `packages/core/test/fixtures/openai-decisions-response.json`):

```json
{
  "model": "gpt-6-luna",
  "answers": [
    { "type": "score", "name": "urgency", "score": 2.76, "probabilities": [{ "value": 0, "label": "none", "probability": 0.0 }, { "value": 1, "label": "low", "probability": 0.01 }, { "value": 2, "label": "high", "probability": 0.22 }, { "value": 3, "label": "critical", "probability": 0.77 }], "confidence": 0.76 },
    { "type": "predicate", "name": "needs_engineer", "probability": 0.98 },
    { "type": "choice", "name": "team", "choice": "engineering", "probabilities": [{ "value": "support", "probability": 0.0 }, { "value": "engineering", "probability": 1.0 }, { "value": "billing", "probability": 0.0 }], "confidence": 1.0 }
  ],
  "usage": { "input_tokens": 506, "output_tokens": 0, "total_tokens": 506 }
}
```

- A score's `value` is the level's place in the request (0 first) and `score` is the expected place, so Verdict reads it as it reads a System One score. A predicate's `probability` is P(yes).
- The same request asked twice gave `0.97` and `0.98` for the predicate: answers are close to, but not exactly, repeatable.
- Pictures (checked live 2026-11-12): with a picture, `input` is a list holding one user message whose `content` has an `input_text` part and an `input_image` part per picture, `{ "type": "input_image", "image_url": "data:image/png;base64,…" }`. It refuses a file part: `Invalid value: 'input_file'. Supported values are: 'input_text', 'input_image', and 'input_json'.` So a PDF reaches it as its text layer and, where pages can be drawn, a picture of each page as an `input_image` part (six pages in one request were taken, 2026-11-12).
- Not checked: how many pictures and how large, limits on the number of questions and on the length of a name.

## Gemini Decisions request and response

Checked against the live API on 2026-11-12 with `gemini-decision-1`. Google's endpoint takes the System One
question types (`score`, `noul`, `choice`) in a map keyed by question id, and renames three things. It refuses the
System One spelling of each, and says which field it does not know:

| System One | Gemini Decisions | What the endpoint says to the System One spelling |
| --- | --- | --- |
| `state` | `input` | `Unknown parameter 'state'.` |
| noul `criteria: { "true": …, "false": … }` | `criteria: { "true_description": …, "false_description": … }` | `Unknown parameter 'true' at 'questions.q.criteria'.` |
| `Authorization: Bearer …` | `x-goog-api-key: …` | 403, `Method doesn't allow unregistered callers` |
| `usage.input_tokens` | `usage.total_input_tokens` | |
| `model` in the response | not there | |

```json
{
  "model": "gemini-decision-1",
  "input": "<the rendered evidence>",
  "questions": {
    "urgency": { "type": "score", "instructions": "…", "criteria": ["none: …", "low: …", "high: …", "critical: …"] },
    "needs_engineer": { "type": "noul", "instructions": "…", "criteria": { "true_description": "…", "false_description": "…" } },
    "team": { "type": "choice", "instructions": "…", "criteria": { "support": "…", "engineering": "…", "billing": "…" } }
  }
}
```

The answer to that request, numbers shortened to four places (verbatim in
`packages/core/test/fixtures/gemini-decisions-response.json`):

```json
{
  "answers": {
    "team": { "type": "choice", "choice": "engineering", "confidence": 0.9637,
              "probabilities": { "billing": 0.0181, "support": 0.0182, "engineering": 0.9637 } },
    "needs_engineer": { "type": "noul", "noul": 0.9548, "confidence": 0.9548 },
    "urgency": { "type": "score", "score": 2.894, "confidence": 0.9059,
                 "probabilities": { "2": 0.0842, "0": 0.002, "1": 0.0079, "3": 0.9059 },
                 "legend": { "0": "none: …", "1": "low: …", "3": "critical: …", "2": "high: …" } }
  },
  "usage": { "total_tokens": 378, "total_input_tokens": 378,
             "input_tokens_by_modality": [{ "modality": "text", "tokens": 378 }], "total_output_tokens": 0 }
}
```

Notes that matter for the engine:
- A score's `probabilities` and `legend` are keyed by level index, and the keys arrive in no particular order.
  Verdict reads them by index.
- A noul answer carries a `confidence`, the probability of the likelier side (0.97 for a `noul` of 0.03). Verdict
  does not use it: it derives its margin from the criterion `threshold`, as for every provider.
- The response does not name the model, so `rating.raw.resolvedModel` is absent and `raw.modelVerified` is false.
  The table of a `--models` run shows the model that was asked for.
- `total_output_tokens` is 0: only input tokens are counted.
- Question ids must be 1 to 64 characters of `[A-Za-z0-9_-]` (`question IDs must be 1-64 characters matching
  [A-Za-z0-9_-]+`). Verdict's criterion and check ids are identifiers, so only a very long one is refused.
- A choice option's description may be an empty string or `null`; Verdict sends an empty string.
- A model the service does not have answers 404, `Requested model not found`. A key it does not know answers 400,
  `API key not valid. Please pass a valid API key.`
- Pictures and PDFs (checked live 2026-11-12): with either, `input` is a list of parts, the text first:
  `[{ "type": "text", "text": "…" }, { "type": "image", "mime_type": "image/png", "data": "<base64>" }, { "type": "document", "mime_type": "application/pdf", "data": "<base64>" }]`.
  It read a one-page PDF with a text layer and the same page as a scan with none. `usage.input_tokens_by_modality`
  counts them apart: 131 text and 522 image tokens for the scanned page. When the file is sent, Verdict's text names
  the file and does not repeat its text layer.
- Not checked: audio and video, several pages and large files, the limits (reported as 1 to 1,000 questions and a
  262,144-token context), and what a blocked input looks like.

## Clef-flash response (verbatim from a live call, `packages/core/test/fixtures/cloudflare-clef-flash-response.json`)

Same System One shape inside a `result` envelope; `score` is fractional (probability-weighted index), `choice` carries per-option probabilities, `output_tokens` is 0:

```json
{ "result": { "model": "clef-flash",
    "answers": { "urgency": { "type": "score", "score": 2.916, "legend": { "0": "…", "3": "…" }, "probabilities": { "0": 0.0062, "1": 0.0055, "2": 0.0545, "3": 0.9338 }, "confidence": 0.8335 },
                 "needs_engineer": { "type": "noul", "noul": 0.843 },
                 "team": { "type": "choice", "choice": "engineering", "probabilities": { "support": 0.0179, "engineering": 0.9722, "billing": 0.0099 }, "confidence": 0.9183 } },
    "usage": { "input_tokens": 370, "output_tokens": 0 } }, "success": true, "errors": [], "messages": [] }
```

Token permissions verified for this: **Workers AI → Read** is sufficient for inference; D1 → Edit, Workers Scripts → Edit, Account Settings → Read and User Details → Read cover wrangler (D1 create / migrations, deploy).

## Clef specifics (Workers AI model pages, 2026-11)

- Body **requires** `model: "clef"` or `"clef-flash"` — the selector, not the `@cf/…` id. Verdict derives it from the model id (`options.selector` overrides).
- `questions`: 1–64 entries; ids match `[A-Za-z0-9_.-]{1,100}` (criterion ids satisfy this).
- `images`: up to 4 embedded PNG/JPEG/WebP (≤4 MiB and 16 MP each; 8 MiB decoded total; 13 MiB body). Remote URLs are not accepted. Verdict sends the subject's own images automatically: `image` inputs and `url` inputs with `screenshot` (the CLI's `--screenshot`; needs Playwright in Node, or `VERDICT_SCREENSHOTS=1` on the Node API server). Images in `options.request.images` go first. The first 4 are sent; each rating's `raw.images` records `{ attached, sent }`. Text-only providers (Jev, System One, OpenAI) never receive images and see a one-line placeholder in the state instead. Stored evidence keeps image metadata only, never the bytes.
- Context: clef 65,536 tokens; clef-flash 24,576 tokens. Long text state is **truncated by the model** to fit — Verdict truncates first, to its own budget, so the cut is visible (`rating.raw.stateTruncated`).
- Pricing: clef $0.24 / M input tokens; clef-flash $0.038 / M; no output charge; media billed as input tokens (32×32 px per token, ≤1,024 per image).
- Zero data retention; multimodal (vision).

## State budgets

`defaultStateCharLimit(provider, model)` (chars ≈ 4 × tokens): clef-flash 72k chars, clef 200k, Jev/System One 112k. Override per judge with `options.stateCharLimit`. Use `criterion.inputs` tags to send each criterion only the evidence it needs.

## Cloud-session note

Node's built-in `fetch` ignores `HTTPS_PROXY`. In Claude Code cloud containers run Node with `NODE_USE_ENV_PROXY=1` (curl already honours the proxy). `scripts/codex-cloud.sh` exports it.
