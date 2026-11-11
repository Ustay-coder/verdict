# Decision-model providers — verified contracts

What Verdict sends and expects per provider, and how much of it has been verified against a live endpoint or the
vendor's official documentation. Keep this honest: update the status column when you verify something.

| Provider | Endpoint | Request | Response | Verified |
| --- | --- | --- | --- | --- |
| `typesafe` (Jev) | `POST https://api.typesafe.ai/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY` | `{ model, state, questions }` | `{ model, answers, usage }` | **Live** (2026-11-05, `jev-1.14.0`) + official API reference |
| `cloudflare` (Clef) | `POST https://api.cloudflare.com/client/v4/accounts/{id}/ai/run/@cf/cloudflare/clef[-flash]`, `Authorization: Bearer $CLOUDFLARE_API_TOKEN` | `{ model: "clef"\|"clef-flash", state, questions, images? }` | `{ success, result: { model, answers, usage } }` | **Live** (2026-11-05, `clef-flash`, 0.40 s, HTTP 200) + official model pages |
| `openrouter` | `POST https://openrouter.ai/api/alpha/decisions` | System One shape, `model: typesafe/jev-1.13` | System One shape | Public write-ups only |
| `openai` (Decisions API) | `POST https://api.openai.com/v1/decisions` | `noul` sent as `predicate` | parsed defensively (`noul` / `predicate` / `probability`) | Public write-ups only (beta) |
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
