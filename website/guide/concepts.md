# Concepts

Use this map to locate the configuration or result field you need. The fragments show individual fields, not standalone rubrics; start with the [complete rubric](/reference/rubric) when creating a file.

## Rubric: the evaluation contract

A rubric names criteria and the policy used to combine their results. Each evaluation freezes its rubric, so later edits affect new evaluations without rewriting existing results.

```yaml
name: Application review
criteria:
  - id: problem
    name: Problem clarity
```

The [rubric reference](/reference/rubric) owns scales, judges, checks, and aggregation fields.

## Evidence: what a criterion reads

Inputs become text evidence. Tags let a criterion select a subset; `inputs: [deck]` selects the input tagged `deck` below. PDF ingestion extracts text, not visual layout.

```json
{
  "type": "text",
  "text": "Five clinics pay for our scheduling tool.",
  "tags": ["deck"]
}
```

Use the [CLI input syntax](/reference/cli) or [REST evaluation request](/reference/rest#post-v1-evaluations) to supply evidence.

## Scale: the units of a score

A scale defines numeric bounds or ordered labels. Anchors describe quality at selected values. A criterion result keeps both the raw score and its normalized 0..1 value for comparison across scales.

```yaml
scale: { type: numeric, min: 1, max: 5 }
anchors:
  "1": No customer evidence
  "3": Active pilots
  "5": Paying customers with retention data
```

See [scales and questions](/reference/rubric#scales-and-questions) for ordinal, binary, and routing choices.

## Judge: who supplies a rating

A judge supplies one or more ratings for a criterion. Decision judges return distributions; human judges create review tasks; benchmarks calculate deterministic results. Panels combine member judges.

```yaml
judge:
  type: human
  raters: [reviewer_a, reviewer_b]
  required: 2
```

Use [decision models](./decision-models) for automated scoring or [human review](./humans) for pending-task handling.

## Aggregation: how ratings become a decision

Rater aggregation combines ratings within a criterion. Overall aggregation combines criterion scores. For example, this policy reports a 0–100 weighted mean and requires at least 70 to pass.

```yaml
aggregation:
  method: weighted_mean
  normalize: [0, 100]
  passThreshold: 70
```

[Reaggregation](/reference/rest#post-v1-evaluations-eval-id-aggregate) applies another policy to stored ratings without calling judges.

## Evaluation: the result to act on

An evaluation holds status, criterion results, pending tasks, and an aggregate. A partial aggregate is provisional; inspect status before accepting a total as final.

```json
{
  "status": "pending_human",
  "aggregate": { "score": 70, "partial": true }
}
```

Next, [run the offline example](./getting-started#your-first-rubric), then inspect its `criteria` and `aggregate` fields.
