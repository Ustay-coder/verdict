# Startup pitch review

Accelerator reviewers use this rubric to decide which pre-seed applicants merit an interview. It scores problem clarity and traction, then requires a partner’s founder-market-fit rating before the review is complete.

## Save the rubric

Save as `startup-pitch.yaml`:

```yaml
name: Startup pitch review
version: "1"
description: Scores a pitch deck / website / demo video for an early-stage program.
context: |
  You are reviewing applications to a pre-seed accelerator. Be rigorous; most applicants should score in the middle.
language: en
scale: { type: numeric, min: 1, max: 5 }

judges:
  jev:   { type: decision, provider: typesafe, model: jev-latest, minConfidence: 0.35, onLowConfidence: human, escalateTo: [partner_a, partner_b] }
  partner:
    type: human
    raters: [partner_a, partner_b]
    required: 1
    instructions: Rate founder-market fit from the deck and any call notes.

defaultJudge: { type: ref, ref: jev }

criteria:
  - id: problem
    name: Problem clarity
    weight: 2
    anchors:
      "1": No clear problem stated
      "3": Problem stated but audience/urgency vague
      "5": "Specific, painful, quantified problem for a named audience"
  - id: traction
    name: Traction evidence
    weight: 2
    anchors: { "1": No customer evidence, "3": Active pilots, "5": Paying customers with retention data }
  - id: team
    name: Team
    weight: 1.5
    judge: { type: ref, ref: partner }
  - id: deck_length
    name: Deck is concise
    weight: 0.5
    optional: true
    judge: { type: benchmark, method: length, unit: words, min: 300, max: 2500 }

aggregation:
  method: weighted_mean
  normalize: [0, 100]
  rater: mean
  gates: [{ criterion: problem, min: 2, message: Problem must be at least somewhat clear }]
  grades: [{ label: invite, min: 75 }, { label: maybe, min: 55 }, { label: pass, min: 0 }]
  passThreshold: 55
```

## Run an evaluation

Set `TYPESAFE_API_KEY` for Jev. No input tags are required: every criterion receives the supplied text.

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
cat > pitch.md <<'EOF'
Our payroll tool serves small clinics. Twelve clinics tested it; five pay $100 per month. The founder previously ran payroll for a clinic.
EOF
npx @verdict-ai/cli eval -r startup-pitch.yaml -i ./pitch.md
```

Inspect `status` and `pendingTasks` before using the total. Use the [human review inbox](/guide/humans#work-the-inbox) to complete pending ratings with the rater IDs in this rubric.

## What to change

Increase `traction.weight` from 2 to 3 to prioritize customer evidence. Raise `passThreshold` from 55 to 75 to require the invite band. Change `partner.required` from 1 to 2 when both partners must rate.

Validate your edited YAML with `npx @verdict-ai/cli rubric validate startup-pitch.yaml`. See the [rubric reference](/reference/rubric) for field definitions.
