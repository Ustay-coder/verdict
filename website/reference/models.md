# Models and inputs

What Verdict can ask, and what you can hand it, on one page. The rubric stays the same whichever model answers it.

## Decision models

| Name it | Model | Service | Checked against the live service | Pictures and PDFs |
| --- | --- | --- | --- | --- |
| `jev` | Jev (`jev-latest`) | TypeSafe | Yes (2026-11-11, `jev-1.14.0`) | No, text only |
| `jev-preview` | Jev preview | TypeSafe | Not separately: the same endpoint as `jev` | No |
| `clef` | Clef | Cloudflare Workers AI | Yes (2026-11-11) | Pictures, up to 4 |
| `clef-flash` | Clef-flash | Cloudflare Workers AI | Yes (2026-11-11; with an image 2026-11-05) | Pictures, up to 4 |
| `openrouter:<model>` | For example `typesafe/jev-1.13` | OpenRouter | Yes (2026-11-11, `typesafe/jev-1.13`) | No |
| `openai:<model>` | OpenAI's Decisions API, for example `gpt-6-luna` | OpenAI | Yes (2026-11-11, `gpt-6-luna`) | Pictures (2026-11-12). It refuses PDFs, so a PDF reaches it as text |
| `gemini` | Gemini Decision 1 (`gemini-decision-1`), through Google's Decisions API | Google (Gemini API) | Yes (2026-11-12, `gemini-decision-1`) | Pictures and PDFs, a scanned PDF included (2026-11-12) |
| `systemone:<model>` | Any endpoint that takes the same request: a self-hosted Clef, a gateway | Yours | You check it | No |
| `mock` | A deterministic stand-in, for trying things without a key | None | — | — |

"Name it" is what you write after `--models` to [compare models on your cases](../guide/decision-models#which-model-on-your-cases), for example `--models jev,clef,clef-flash`. In a rubric the same model is a judge: `defaultJudge: { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef" }` ([providers](./providers)).

### Keys and limits

Each model is called from where Verdict runs, with keys from that environment.

| Service | Keys | Context |
| --- | --- | --- |
| TypeSafe | `TYPESAFE_API_KEY` | 64k tokens a request |
| Cloudflare Workers AI | `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (Workers AI: Read) | Clef 65,536 tokens; Clef-flash 24,576 |
| OpenRouter | `OPENROUTER_API_KEY` | the model's own |
| OpenAI | `OPENAI_API_KEY` | the model's own |
| Google (Gemini API) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) | the model's own; question ids of 1 to 64 letters, digits, `_` or `-` |
| Your endpoint | `SYSTEMONE_BASE_URL`, and `SYSTEMONE_API_KEY` if it wants one | the model's own |

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
| File | a path: `.pdf`, `.html`, `.md`, `.txt`, `.json` and other text | `{ "type": "file", "path": "…" }` | its text: a PDF's text layer, an HTML page's visible text. A model that reads PDFs is sent the PDF itself |
| JSON | `json:{…}` or a `.json` file | `{ "type": "json", "data": { … } }` | the document; a rubric's `inputSchema` can check it first, and rules can read its fields |
| Web page | a URL | `{ "type": "url", "url": "…" }` | the page's visible text; with `--screenshot`, a picture of it too |
| YouTube | a YouTube URL | `{ "type": "youtube", "url": "…" }` | the transcript from its captions, or the title and description when it has none |
| Image | a `.png`, `.jpg` or `.webp` path | `{ "type": "image", "path": "…" }` | the picture, for models that take pictures |

- Pictures (an image input, or a page's screenshot) reach the models that take pictures: Clef, Clef-flash, OpenAI and Gemini. A text-only model judges the text, which for a picture is one line saying a picture was there.
- A PDF is sent as the file to a model that reads PDFs (Gemini), and the text names the file instead of repeating it. Every other model is given the PDF's text layer.
- A scanned PDF has no text layer. A model that reads PDFs still reads it; any other model is told there was no text to show, and its answer is a guess. Turning a PDF's pages into pictures for the models that take only pictures is not built yet.
- When the cases carry pictures or PDFs, the table of `verdict run --models` gains a column for each that says how many every model was sent: `1/1`, or `0/2` for a model that was given text instead.
- How many pictures, and how large, OpenAI and Gemini take in one request has not been measured; Clef takes 4, of 4 MiB each and 8 MiB together.
- A screenshot needs Playwright where the engine runs.
- Over REST and the SDK the same inputs are sent as objects; a file or an image travels as `base64`.
