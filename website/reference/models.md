# Models and inputs

What Verdict can ask, and what you can hand it, on one page. The rubric stays the same whichever model answers it.

## Decision models

| Name it | Model | Service | Keys in your environment | Checked against the live service | Images | Context |
| --- | --- | --- | --- | --- | --- | --- |
| `jev` | Jev (`jev-latest`) | TypeSafe | `TYPESAFE_API_KEY` | Yes (2026-11-11, `jev-1.14.0`) | No, text only | 64k tokens a request |
| `jev-preview` | Jev preview | TypeSafe | `TYPESAFE_API_KEY` | Not separately: the same endpoint as `jev` | No | — |
| `clef` | Clef | Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Yes (2026-11-11) | Up to 4 | 65,536 tokens |
| `clef-flash` | Clef-flash | Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` | Yes (2026-11-11; with an image 2026-11-05) | Up to 4 | 24,576 tokens |
| `openrouter:<model>` | For example `typesafe/jev-1.13` | OpenRouter | `OPENROUTER_API_KEY` | Not yet: written from public documentation | No | — |
| `openai:<model>` | OpenAI's Decisions API | OpenAI | `OPENAI_API_KEY` | Not yet: written from public documentation | No | — |
| `systemone:<model>` | Any endpoint that takes the same request: a self-hosted Clef, a gateway | Yours | `SYSTEMONE_BASE_URL`, `SYSTEMONE_API_KEY` | You check it | No | — |
| `mock` | A deterministic stand-in | None | None | — | — | — |

"Name it" is what you write after `--models` to [compare models on your cases](../guide/decision-models#which-model-on-your-cases), for example `--models jev,clef,clef-flash`. In a rubric the same model is a judge: `defaultJudge: { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef" }` ([providers](./providers)).

- A token for Clef needs Workers AI: Read.
- Images are PNG, JPEG or WebP, at most 4 MiB each and 8 MiB in a request.
- Long evidence is cut to the model's context before it is sent, and the rating says so (`raw.stateTruncated`).
- The request and response of each service, and the dates they were checked, are in [docs/PROVIDERS.md](https://github.com/Ustay-coder/verdict/blob/main/docs/PROVIDERS.md).

## What a criterion becomes

Every decision model is asked the same typed questions. Which type depends on the criterion's scale, not on the model.

| In the rubric | The question | The answer |
| --- | --- | --- |
| A `binary` scale | yes or no (`noul`) | the probability of yes; your `threshold` turns it into a label |
| An `ordinal` scale, or a `numeric` one with described levels | where on the ordered levels (`score`), 2 to 10 of them | a probability for each level |
| `choices` | which one (`choice`), up to 255 options | the option chosen, and a probability for each |

All criteria that share a judge and the same evidence go out in one request.

## Other judges

A criterion does not have to be judged by a decision model.

| Judge | For | Needs |
| --- | --- | --- |
| `benchmark` | what a rule can decide: `keywords`, `regex`, `length`, `jsonpath`, `formula`, `similarity`, or your own `http` endpoint | nothing |
| `human` | what needs a person; also where a model hands off when it is unsure | someone to answer the task |
| `llm` | a written rationale with quotes: `anthropic`, `openai`, `cloudflare`, or any `http` endpoint | that provider's key |
| `panel` | several judges on one criterion, combined by mean, median, min, max or majority | its members' keys |

`--models` re-points decision judges only; these answer as the rubric says.

## Inputs

What you can hand Verdict to be judged. Several inputs can make up one subject, and a criterion can be limited to some of them by tag.

| Input | With `verdict eval -i` | In a file of cases | What the judge receives |
| --- | --- | --- | --- |
| Text | `text:…`, a text file, or `-` for standard input | `{ "type": "text", "text": "…" }` | the text |
| File | a path: `.pdf`, `.html`, `.md`, `.txt`, `.json` and other text | `{ "type": "file", "path": "…" }` | its text: a PDF's text layer, an HTML page's visible text |
| JSON | `json:{…}` or a `.json` file | `{ "type": "json", "data": { … } }` | the document; a rubric's `inputSchema` can check it first, and rules can read its fields |
| Web page | a URL | `{ "type": "url", "url": "…" }` | the page's visible text; with `--screenshot`, a picture of it too |
| YouTube | a YouTube URL | `{ "type": "youtube", "url": "…" }` | the transcript from its captions, or the title and description when it has none |
| Image | a `.png`, `.jpg` or `.webp` path | `{ "type": "image", "path": "…" }` | the picture, for models that take images |

- Pictures (an image input, or a page's screenshot) reach only models that take images: Clef and Clef-flash. A text-only model judges the text.
- A scanned PDF has no text layer; Verdict says so in the evidence rather than guessing.
- A screenshot needs Playwright where the engine runs.
- Over REST and the SDK the same inputs are sent as objects; a file or an image travels as `base64`.
