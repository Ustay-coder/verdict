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
