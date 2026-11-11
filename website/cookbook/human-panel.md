# Hiring debrief

Hiring-tool engineers use this rubric to collect independent interview ratings and enforce a majority hiring vote. The coding pre-screen supplements the interviewers; the final decision remains pending until the required human scores arrive.

## Save the rubric

Save as `human-panel.yaml`:

```yaml
name: Engineering hiring debrief
scale: { type: numeric, min: 1, max: 4 }
judges:
  screen: { type: decision, provider: typesafe, minConfidence: 0.4, onLowConfidence: human, escalateTo: [interviewer_1, interviewer_2] }
criteria:
  - id: coding
    name: Coding exercise
    weight: 2
    anchors:
      "1": Does not compile or solve the task
      "2": Works but unclear or untested
      "3": "Correct, readable, some tests"
      "4": "Correct, idiomatic, well tested"
    judge: { type: ref, ref: screen }
  - id: system_design
    name: System design
    weight: 2
    judge: { type: human, raters: [interviewer_1, interviewer_2], required: 2 }
    rater: mean
  - id: communication
    name: Communication
    weight: 1
    judge: [{ type: human, raters: [interviewer_1], required: 1 }, { type: human, raters: [interviewer_2], required: 1 }, { type: ref, ref: screen }]
    rater: median
  - id: hire
    name: Hire?
    weight: 0
    scale: { type: binary, labels: [no hire, hire] }
    judge: { type: human, raters: [interviewer_1, interviewer_2, hiring_manager], required: 3 }
    rater: majority
aggregation:
  method: weighted_mean
  gates: [{ criterion: hire, min: 1, message: Majority of the panel must vote hire }]
  passThreshold: 70
```

## Run an evaluation

Set `TYPESAFE_API_KEY` for Jev. No input tags are required: every criterion receives the supplied text.

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
cat > interview.txt <<'EOF'
The candidate implemented a working cache with eviction tests. In the design interview they described replication but did not address failover.
EOF
npx @verdict-ai/cli eval -r human-panel.yaml -i ./interview.txt
```

Inspect `status` and `pendingTasks` before using the total. Use the [human review inbox](/guide/humans#work-the-inbox) to complete pending ratings with the rater IDs in this rubric.

## What to change

Increase `system_design.weight` for a senior role. Raise `passThreshold` from 70 to 80 for a stricter total. Replace the `screen` judge with a human judge when automated pre-screening is inappropriate.

Validate your edited YAML with `npx @verdict-ai/cli rubric validate human-panel.yaml`. See the [rubric reference](/reference/rubric) for field definitions.
