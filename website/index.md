---
layout: home
hero:
  name: Verdict
  text: One rubric, every decision model
  tagline: Write the rubric once. Ask Jev, Clef and any other decision model the same questions, and see which one agrees with your labels. Open source, on your machine, with your own keys.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Models and inputs
      link: /reference/models
    - theme: alt
      text: GitHub
      link: https://github.com/Ustay-coder/verdict
features:
  - title: Decision models first
    details: Jev and Clef return probabilities over your rubric levels. Shared judge and evidence means one request per rubric scoring batch.
  - title: Humans in the loop
    details: Assign reviewers, collect independent ratings, and escalate uncertain decisions through a task inbox.
  - title: Reproducible policy
    details: Mix deterministic benchmarks with model scores. Freeze each rubric and reaggregate stored ratings without another provider call.
---

## Models you can use

| Name it | Model | Service | Checked against the live service | Images |
| --- | --- | --- | --- | --- |
| `jev` | Jev | TypeSafe | Yes | No, text only |
| `clef` | Clef | Cloudflare Workers AI | Yes | Up to 4 |
| `clef-flash` | Clef-flash | Cloudflare Workers AI | Yes | Up to 4 |
| `openrouter:<model>` | For example `typesafe/jev-1.13` | OpenRouter | Yes | No |
| `openai:<model>` | OpenAI's Decisions API, for example `gpt-6-luna` | OpenAI | Yes | No |
| `gemini` | Gemini Decision 1 | Google (Gemini API) | Yes | No |
| `systemone:<model>` | Any endpoint that takes the same request | Yours | You check it | No |

One command runs a rubric on several of them and shows the answers side by side:

```bash
verdict run -r intent.yaml -d cases.jsonl --models jev,clef,clef-flash
```

Rules, people and prompted models can judge a criterion too. Keys, context sizes and what each scale becomes are on [Models and inputs](/reference/models).

## What you can hand it

| Input | With `verdict eval -i` | What the judge receives |
| --- | --- | --- |
| Text | `text:…`, a text file, or `-` | the text |
| File | a `.pdf`, `.html`, `.md`, `.txt` or `.json` path | its text |
| JSON | `json:{…}` | the document, checkable against a schema |
| Web page | a URL | the page's visible text; with `--screenshot`, a picture too |
| YouTube | a YouTube URL | the transcript |
| Image | a `.png`, `.jpg` or `.webp` path | the picture, for models that take images |

## Evaluate without a provider key

```bash
npx @verdict-ai/cli eval -r rubric.yaml -i ./release-notes.txt
```

Save this as `rubric.yaml`:

```yaml
name: Release notes
criteria:
  - id: migration
    name: Includes migration guidance
    judge: { type: benchmark, method: keywords, keywords: [migration], mode: any }
```

Use [REST](/reference/rest), the [SDK](/reference/sdk), or [MCP](/reference/mcp) to add the same evaluation step to a product or agent.
