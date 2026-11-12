# Decision models

A rubric question has a bounded set of answers. Jev and Clef return distributions over those answers, which Verdict maps to your scale. Use a generative LLM judge when you also need written feedback.

## One request per scoring batch

Top-level criteria with the same judge specification and evidence share one request. Numeric and ordinal criteria become `score` questions, binary criteria become `noul`, and routing criteria become `choice`. Different judge specs or input selections form separate batches. Checks run first in a separate batch; decision members inside panels run per criterion.

```yaml
defaultJudge:
  type: decision
  provider: typesafe
  model: jev-latest
  minConfidence: 0.4
  onLowConfidence: human
  escalateTo: [reviewer]
```

Configure credentials using the [provider reference](/reference/providers).

## Confidence gates

Scores retain probabilities and confidence even when escalated. Choose `accept`, `human`, or `error` as the low-confidence policy. A confident model can still be wrong; confidence is a routing signal, not a guarantee.

## Calibrate against reviewers

Collect human ratings on representative evaluations before choosing a threshold:

```bash
npx @verdict-ai/cli calibrate rub_ID
```

Reports compare stored decision ratings, including escalations, against human consensus. They include agreement, normalized error and bias, confidence buckets, ECE, inter-rater alpha, and a suggested threshold. A suggestion requires at least three pairs in each populated bucket at or above it meeting the target (default 0.8); insufficient metrics are null. Review performance by population and repeat after rubric or provider changes.

Next, [configure a provider](/reference/providers), run your rubric on representative evidence, and resolve escalations through the [human inbox](./humans#work-the-inbox).

## Which model, on your cases

A rubric does not have to name the model that answers it. `verdict run --models` runs the same rubric over the same cases once per model and reads the runs side by side:

```bash
verdict run -r intent.yaml -d cases.jsonl --models jev,clef,clef-flash
```

```text
Wants a human × cases.jsonl: 4 case(s), 3 model(s), the same questions to each
  model        answered by             agreed with labels   failed   asked a human   input tokens   calls   time
  jev          typesafe/jev-1.14.0     7/8 (88%)            0        0               2,041          4       0.4 s
  clef         cloudflare/clef         7/8 (88%)            0        0               1,547          4       1.4 s
  clef-flash   cloudflare/clef-flash   8/8 (100%)           0        0               1,547          4       3.6 s
the models gave one answer on 7 of 8 question(s) they all answered; they differ on 1:
  explicit · urgency   expected medium   jev low (0.79) | clef low (0.81) | clef-flash medium (0.43)
```

- **Agreed with labels** counts every labelled criterion the model decided itself, over all cases. Unlabelled cases still show up below the table when the models differ on them — those are the cases worth labelling next.
- **The number beside an answer is the probability the model gave it**: 0.79 means Jev put 79% on "low". It means the same for every model. It is not the `confidence` a provider reports, which each computes its own way: for an answer of probability `p` among `n` options Gemini reports `p`, Jev and OpenAI `(p − 1/n) / (1 − 1/n)`, and Clef `(Σp² − 1/n) / (1 − 1/n)`. `--json` has both. A score that falls between two levels has no number, because the model put no probability on it.
- **The same questions to each** is read from the runs: every run records the questions it sent. If the line says otherwise, the rows are not comparable.
- A model is `jev`, `jev-preview`, `clef`, `clef-flash`, `gemini`, or `provider:model`: `typesafe:jev-1.14.0`, `cloudflare:@cf/cloudflare/clef`, `openrouter:typesafe/jev-1.13`, `openai:<model>`, `systemone:<model>` (with `SYSTEMONE_BASE_URL`). Keys come from the environment, as for any run.
- Only decision judges are re-pointed. Criteria judged by rules, people or prompted models answer as the rubric says, and a rubric with no decision judge is refused.
- The rubric file and `verdict.lock` are not touched. Each model's run is of a version that differs only in which model answers, and is kept: `verdict diff --base run_… --head run_…` compares two case by case, and `--json` prints the whole comparison.
- A model that cannot answer (no key, a model the account cannot use) keeps its row with the reason, and is left out of the disagreements. The command exits 1 only when no model answered.
- The table does not pick a winner. On a handful of cases the difference between two models is noise; bring the cases you care about, then put the model you chose in the rubric (`defaultJudge: { type: decision, provider: cloudflare, model: "@cf/cloudflare/clef" }`) and freeze it.

Checked against the live services: Jev, Clef, Clef-flash, OpenRouter and OpenAI's Decisions API ([what was sent and when](https://github.com/Ustay-coder/verdict/blob/main/docs/PROVIDERS.md)).
