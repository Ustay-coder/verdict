# Human review

Use human judges for final approvals, specialist judgment, or uncertain model answers.

```yaml
criteria:
  - id: team
    name: Founder-market fit
    judge: { type: human, raters: [partner_a, partner_b], required: 2 }
    rater: mean
```

This criterion creates two pending slots. The evaluation returns `pending_human`; available aggregate scores remain provisional. When fewer ratings than listed raters are required, allowed raters can fill generic slots.

## Work the inbox

```bash
npx @verdict-ai/cli tasks --rater partner_a
npx @verdict-ai/cli score eval_ID team --rater partner_a --score 4 --rationale "Relevant operating experience"
```

Over REST, fetch `GET /v1/tasks?rater=partner_a` and submit to `POST /v1/evaluations/eval_ID/scores`:

```json
{ "criterionId": "team", "raterId": "partner_a", "score": 4, "rationale": "Relevant operating experience" }
```

Scores are validated against the frozen rubric and allowed raters. Submissions reaggregate the evaluation; the final required submission can complete it and trigger its webhook. A panel stays pending while any human member is pending.

## Escalation

On a decision judge set `minConfidence`, `onLowConfidence: human`, and `escalateTo: [partner_a]`. The pending rating keeps the model distribution as context. Use [calibration](./decision-models#calibrate-against-reviewers) to choose thresholds from actual reviewer agreement.
