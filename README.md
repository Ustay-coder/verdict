# Verdict — one rubric, every decision model

**Write the rubric once. Run it on Jev, Clef, OpenAI's Decisions API, Gemini's and any other decision model, and see where they disagree on your own cases.**

Decision models answer typed questions (yes or no, one of these, a level on a scale) with probabilities instead of prose, in a fraction of a second. Every vendor publishes benchmarks; none of them is about your cases, and each vendor wants its questions in its own shape. Verdict turns a rubric — criteria, scales, levels — into the questions each model takes, sends the same questions to all of them, and puts the answers side by side.

```bash
npm install -g @verdict-ai/cli
verdict run -r examples/banking77/intent.yaml -d examples/banking77/cases.jsonl --models jev,clef,clef-flash,openrouter,openai,gemini
```

```text
Transfer intent × cases.jsonl: 80 case(s), 6 model(s), the same questions to each
  model        answered by                             agreed with labels   failed   asked a human   input tokens   calls   time
  jev          typesafe/jev-1.14.0                     66/80 (83%)          0        0               44,560         80      2.1 s
  clef         cloudflare/clef                         70/80 (88%)          0        0               31,259         80      6.9 s
  clef-flash   cloudflare/clef-flash                   73/80 (91%)          0        0               31,259         80      4.5 s
  openrouter   openrouter/typesafe/jev-1.13-20260917   67/80 (84%)          0        0               44,560         80      3.9 s
  openai       openai/gpt-6-luna                       69/80 (86%)          0        0               25,254         80      7.1 s
  gemini       gemini/gemini-decision-1                68/80 (85%)          0        0               25,364         80      7.1 s
the models gave one answer on 70 of 80 question(s) they all answered; they differ on 10:
  …
```

A real run (2026-11-12) of eighty customer messages from a public dataset, on six models: [examples/banking77](examples/banking77) has the rubric, the cases, the whole output and how to read it. It is not a ranking: eighty cases separate the models by a handful of answers. The ten cases where they differ are the ones worth reading, and on your cases they will be different ones.

## Try it

Node 22 or newer. No key is needed for the first run:

```bash
npm install -g @verdict-ai/cli
git clone https://github.com/Ustay-coder/verdict && cd verdict/examples/banking77
verdict run -r intent.yaml -d cases.jsonl --models mock           # a stand-in model: shows the flow, not real answers
```

With a key for any one service, name its model instead (`TYPESAFE_API_KEY` for `jev`; `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` for `clef`; `OPENROUTER_API_KEY`; `OPENAI_API_KEY`). A model that cannot answer keeps its row and says why.

Then your own cases:

```bash
verdict rubric init rubric.yaml                                   # a starter rubric to edit
verdict run -r rubric.yaml -d cases.jsonl --models jev,clef       # cases.jsonl: one {"id", "inputs", "expected"} per line
verdict diff --base run_… --head run_…                            # any two runs, case by case
```

The rubric file is not edited: `--models` re-points its decision judges, one run per model, and every run is kept. [Getting started](https://docs.verdict-ai.dev/guide/getting-started) walks through it; [Decision models](https://docs.verdict-ai.dev/guide/decision-models) explains the table.

## Models and inputs

| Name it | Model | Service | Checked against the live service | Images |
| --- | --- | --- | --- | --- |
| `jev` | Jev | TypeSafe | Yes | No, text only |
| `clef` | Clef | Cloudflare Workers AI | Yes | Up to 4 |
| `clef-flash` | Clef-flash | Cloudflare Workers AI | Yes | Up to 4 |
| `openrouter:<model>` | For example `typesafe/jev-1.13` | OpenRouter | Yes | No |
| `openai:<model>` | OpenAI's Decisions API, for example `gpt-6-luna` | OpenAI | Yes | No |
| `gemini` | Gemini Decision 1 | Google (Gemini API) | Yes | No |
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

**Checked against the live services: Jev, Clef, Clef-flash, OpenRouter and OpenAI's Decisions API** — what each was sent, what it answered and when is in [docs/PROVIDERS.md](docs/PROVIDERS.md).

## Once you have chosen a model

The same rubric keeps working after the comparison:

- **Version it.** `verdict version freeze` gives a rubric a content-addressed id; `verdict diff` shows what a change to the rubric did to each case, and a GitHub Action comments that on pull requests. [Versions, forks and CI](https://docs.verdict-ai.dev/guide/versions)
- **Use it from any machine.** A Verdict server (in this repository, self-hosted) keeps your frozen versions and says which one each environment runs: `verdict push`, `verdict promote`, then `verdict run -r <name> --env prod` anywhere. The server never receives a case or an answer. [Versions, forks and CI](https://docs.verdict-ai.dev/guide/versions)
- **Bring in people.** Low-confidence answers can go to a human reviewer, and `verdict check` compares a rubric with what people already decided. [Human review](https://docs.verdict-ai.dev/guide/humans)
- **Call it from code.** A REST API that runs on Node or Cloudflare Workers, a TypeScript SDK, and an MCP server for agents. [REST](https://docs.verdict-ai.dev/reference/rest) · [SDK](https://docs.verdict-ai.dev/reference/sdk) · [MCP](https://docs.verdict-ai.dev/reference/mcp)
- **Judge more than text.** PDFs, web pages, YouTube transcripts, JSON and images; rules, people and prompted models as judges beside decision models; weighted scores, gates and grades. [Everything Verdict does](https://docs.verdict-ai.dev/guide/overview)

## Packages

```bash
npm install -g @verdict-ai/cli                 # the `verdict` command
npm install @verdict-ai/sdk                    # typed REST client
npm install @verdict-ai/core                   # the engine, embedded
npm install @verdict-ai/api @verdict-ai/db     # self-hosted service and persistence
npx @verdict-ai/mcp                            # stdio tools for agents
```

## Documentation

[docs.verdict-ai.dev](https://docs.verdict-ai.dev): guides, the [rubric reference](https://docs.verdict-ai.dev/reference/rubric), [configuration](https://docs.verdict-ai.dev/reference/configuration), [deployment](https://docs.verdict-ai.dev/guide/deploy) and a cookbook of complete rubrics. What changed in each release: [CHANGELOG.md](CHANGELOG.md).

## Contributing

Found a bug, or a model that answers in a shape Verdict does not read? [Open an issue](https://github.com/Ustay-coder/verdict/issues/new/choose) with the command and what it printed. To build and test the code, see [CONTRIBUTING.md](CONTRIBUTING.md); to report a security problem, [SECURITY.md](SECURITY.md).

## License

MIT. The cases in `examples/banking77` are from BANKING77 by PolyAI, under CC BY 4.0.
