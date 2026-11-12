# Eighty real support messages, six decision models

One rubric, run on Jev, Clef, Clef-flash, OpenRouter, OpenAI's Decisions API and Gemini's, on messages nobody here
wrote or labelled. The point is not which model is best. It is that the models do not always give the same answer, and that
you can see where on your own cases with one command.

```bash
npm install -g @verdict-ai/cli
verdict run -r intent.yaml -d cases.jsonl --models jev,clef,clef-flash,openrouter,openai,gemini
```

Each model answers with your key for its service ([which keys](https://docs.verdict-ai.dev/reference/models)).
Leave out the ones you have no key for; `--models mock` runs the whole thing with no key at all.

## The run

A real run, 2026-11-12. The whole output is in [run-2026-11-12-six-models.txt](run-2026-11-12-six-models.txt). An
earlier run the same day, before Gemini was added, is in [run-2026-11-12.txt](run-2026-11-12.txt): the five models
agreed with the labels on the same number of cases both times, and their probabilities moved a little.

```
Transfer intent × cases.jsonl: 80 case(s), 6 model(s), the same questions to each
  model        answered by                             agreed with labels   failed   asked a human   input tokens   calls   time
  jev          typesafe/jev-1.14.0                     66/80 (83%)          0        0               44,560         80      2.1 s
  clef         cloudflare/clef                         70/80 (88%)          0        0               31,259         80      6.9 s
  clef-flash   cloudflare/clef-flash                   73/80 (91%)          0        0               31,259         80      4.5 s
  openrouter   openrouter/typesafe/jev-1.13-20260917   67/80 (84%)          0        0               44,560         80      3.9 s
  openai       openai/gpt-6-luna                       69/80 (86%)          0        0               25,254         80      7.1 s
  gemini       gemini/gemini-decision-1                68/80 (85%)          0        0               25,364         80      7.1 s
the models gave one answer on 70 of 80 question(s) they all answered; they differ on 10:
```

Three of the ten, shortened. The number is the confidence the model reported with its answer. It is not the
probability of the answer, and the services do not mean the same thing by it (see below):

| Message | Labelled | Jev | Clef | Clef-flash | OpenRouter (Jev 1.13) | OpenAI | Gemini |
| --- | --- | --- | --- | --- | --- | --- | --- |
| "How long does it take for a transfer to get to a recipient?" | not received by recipient | timing (1.00) | not received (0.43) | timing (0.56) | timing (1.00) | timing (0.94) | timing (1.00) |
| "Why is my transfer not done yet?" | pending | timing (0.66) | pending (0.28) | pending (0.45) | pending (0.55) | pending (0.54) | pending (0.62) |
| "I didn't get the money I transferred" | balance not updated | not received (0.81) | not received (0.66) | balance not updated (0.76) | not received (0.59) | balance not updated (0.75) | not received (0.47) |

## How to read it

- **It is not a ranking.** Eighty cases separate the models by three to seven answers, and the same request asked
  twice does not always come back with the same probabilities. Run it again and the numbers move a little.
- **"Agreed with labels" is agreement with this dataset's labels**, which are arguable for intents this close. The
  first row above is labelled "not received by recipient", and five of six models read it as a question about
  timing. A case every model gets "wrong" is often a label, or a line of the rubric, to look at again.
- **The ten cases where the models differ are the ones worth reading.** They sit on the border between two intents,
  and the numbers often show it: 0.28, 0.45, 0.47.
- **The number in parentheses is each service's own "confidence", and they define it three ways.** With eight
  options and `p` the probability of the answer: Gemini reports `p` itself; Jev and OpenAI report
  `(p - 1/8) / (1 - 1/8)`; Clef and Clef-flash report `(sum of p² - 1/8) / (1 - 1/8)`. For "Why is my transfer not done
  yet?" the probabilities of the answers were 0.70, 0.48, 0.68, 0.61, 0.60 and 0.62, which the table shows as 0.66,
  0.28, 0.45, 0.55, 0.54 and 0.62. Compare a model's numbers with its own, not with another model's. The
  probabilities themselves are kept in every stored evaluation.
- **The rubric is part of the result.** The one-line descriptions in `intent.yaml` are ours. Change one, run again,
  and `verdict diff --base run_… --head run_…` shows which cases moved.

## Where the cases come from

The messages and their labels are from **BANKING77** by PolyAI: 13,083 customer messages to a bank, labelled with 77
intents ([repository](https://github.com/PolyAI-LDN/task-specific-datasets), Casanueva et al., 2020,
[Efficient Intent Detection with Dual Sentence Encoders](https://arxiv.org/abs/2003.04807)). The dataset is licensed
under [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/), and so is
`cases.jsonl`, which is a part of it.

What was changed: nothing in the text or the labels. Eight of the 77 intents were chosen, the eight about
transfers, because they are easy to confuse with one another. For each, the first ten messages of the test split
were taken in the order the file has them, so none was picked by hand. [build-cases.mjs](build-cases.mjs) rebuilds
`cases.jsonl` from the published file:

```bash
curl -sLO https://raw.githubusercontent.com/PolyAI-LDN/task-specific-datasets/master/banking_data/test.csv
node build-cases.mjs test.csv > cases.jsonl
```

The descriptions of the intents in `intent.yaml` were written here, after reading messages from the training split
only. The dataset is well known, so the models may have seen it.
