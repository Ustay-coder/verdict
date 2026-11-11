# Rubric reference

Save this complete rubric as `problem.yaml`. It uses Jev to score one criterion and reports a 0–100 total. Rubrics accept YAML or JSON; validation strips unknown keys and fills defaults.

```yaml
name: Problem review
scale: { type: numeric, min: 1, max: 5 }
defaultJudge: { type: decision, provider: typesafe }
criteria:
  - id: problem
    name: Problem clarity
    weight: 2
    anchors:
      "1": No problem stated
      "3": Clear problem without supporting evidence
      "5": Specific problem supported by customer evidence
aggregation:
  method: weighted_mean
  normalize: [0, 100]
  passThreshold: 60
```

Set `TYPESAFE_API_KEY`, validate the file, and supply evidence:

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
printf '%s\n' 'Five clinics pay for our scheduling tool after a three-month pilot.' > pitch.txt
npx @verdict-ai/cli rubric validate problem.yaml
npx @verdict-ai/cli eval -r problem.yaml -i pitch.txt
```

## Scales and questions

Numeric scales define `min`, `max`, and optional `step`. Binary scales have two labels; ordinal scales have ordered labels and optional numeric values. For example, `scale: { type: ordinal, labels: [poor, adequate, strong] }` defines three ordered positions. Explicit `levels` describe 2–10 scored positions; anchors provide an alternative. `choices` defines routing options and cannot coexist with levels. Without a complete `values` mapping, choices are excluded from totals. A rubric may declare `inputSchema`, a JSON Schema subset (`type`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`, string length and `pattern`, number and array bounds) that every `json` input must satisfy. A mismatch fails the evaluation with `inputErrors` before any judge runs; keywords outside the subset are rejected when the rubric is parsed. Binary criteria may set `threshold` (between 0 and 1, exclusive; default 0.5): the probability at or above which a decision model's yes/no answer counts as the true label. Ratings record the threshold used and whether it came from the rubric or the default.

## Judges and evidence

Reusable judges are selected by name:

```yaml
judges:
  reviewer: { type: human, raters: [partner], required: 1 }
defaultJudge: { type: ref, ref: reviewer }
```

Criteria override the default judge, scale and rater policy, select evidence via `inputs`, and set `optional`, `group`, or weight. Weight zero reports a criterion without adding it to the total; gates may still use it. Use [decision models](/guide/decision-models), [humans](/guide/humans), deterministic benchmarks, LLM judges, or panels.

## Checks and aggregation

Checks run before scoring with actions `flag`, `fail`, or `abort`. Overall aggregation supports normalized means, min/max, geometric mean, raw weighted sum, and formulas. Define missing-score policy, output range, gates, grade bands and pass thresholds explicitly for production.

Formulas access `id` (raw), `id_n` (normalized), `id_w` (weight), and `id_present`. They use a constrained parser, never JavaScript evaluation. See [reaggregation](./rest#post-v1-evaluations-eval-id-aggregate) to apply policy changes to stored ratings.

For example, add this gate under `aggregation` to require a raw problem score of at least 3, regardless of the total:

```yaml
gates:
  - criterion: problem
    min: 3
    message: Customer evidence is required
```

The [complete field and formula tables](https://github.com/Ustay-coder/verdict/blob/main/docs/RUBRICS.md) are maintained in the repository. Next, adapt the [startup review recipe](/cookbook/startup-pitch) for multiple criteria and a partner approval.
