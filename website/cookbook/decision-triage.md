# Support ticket triage

Support-platform engineers use this rubric to assign an owning team and a priority band. The initial check rejects unrelated submissions; urgency and churn risk determine the priority.

## Save the rubric

Save as `decision-triage.yaml`:

```yaml
name: Support ticket triage
language: en
scale: { type: numeric, min: 0, max: 3 }
defaultJudge: { type: decision, provider: typesafe, model: jev-latest, minConfidence: 0.3, onLowConfidence: human, escalateTo: [support_lead] }
checks:
  - id: on_topic
    question: Is the state a real support ticket (not spam, a test, or empty)?
    criteria: { true: A customer describing an issue or request, false: Spam or unrelated text }
    expect: true
    action: abort
    message: Not a support ticket
criteria:
  - id: team
    name: Owning team
    choices: { support: General help and how-to questions, engineering: "Bugs, errors and outages", billing: Invoices and payments }
  - id: urgency
    name: Urgency
    weight: 3
    levels:
      - { value: 0, label: none, description: Question or feedback, nothing is broken }
      - { value: 1, label: low, description: Minor issue with an obvious workaround }
      - { value: 2, label: high, description: Core feature degraded for this customer }
      - { value: 3, label: critical, description: Outage, data loss, security or billing error }
  - id: churn_risk
    name: Churn risk
    weight: 2
    levels:
      - { value: 0, description: Neutral or positive tone }
      - { value: 1, description: Frustrated but engaged }
      - { value: 2, description: Threatens to cancel or mentions a competitor }
      - { value: 3, description: Has already cancelled or demands a refund }
  - id: needs_engineer
    name: Needs an engineer
    weight: 1
    scale: { type: binary, labels: [no, yes] }
    anchors: { yes: Requires code or infrastructure changes to resolve, no: Support can resolve with configuration or guidance }
  - id: abusive
    name: Abusive content
    weight: 0
    scale: { type: binary }
aggregation:
  method: formula
  formula: "max(urgency_n, churn_risk_n * 0.8)"
  normalize: [0, 100]
  gates: [{ criterion: abusive, max: 0, message: Route abusive tickets to trust & safety }]
  grades: [{ label: P0, min: 90 }, { label: P1, min: 60 }, { label: P2, min: 30 }, { label: P3, min: 0 }]
```

## Run an evaluation

Set `TYPESAFE_API_KEY` for Jev. No input tags are required: every criterion receives the supplied text.

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
cat > ticket.txt <<'EOF'
Our production API returns 500 for every request. All customers are blocked and we will cancel if service is not restored today.
EOF
npx @verdict-ai/cli eval -r decision-triage.yaml -i ./ticket.txt
```

Inspect `status` and `pendingTasks` before using the total. Use the [human review inbox](/guide/humans#work-the-inbox) to complete pending ratings with the rater IDs in this rubric.

## What to change

Change the P1 minimum from 60 to 70 to narrow that queue. Adjust the `0.8` churn multiplier in `formula`. Change `escalateTo` to the support lead’s actual rater ID.

Validate your edited YAML with `npx @verdict-ai/cli rubric validate decision-triage.yaml`. See the [rubric reference](/reference/rubric) for field definitions.
