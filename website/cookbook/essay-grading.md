# Essay grading

Engineers building a writing-course review queue can use this rubric to assign a provisional grade from an essay. Thesis and organization drive the grade; length and citation checks expose unmet submission requirements.

## Save the rubric

Save as `essay-grading.yaml`:

```yaml
name: Essay grading
version: "3"
context: Grade an undergraduate argumentative essay for a first-year writing seminar.
scale: { type: ordinal, labels: [poor, developing, proficient, excellent] }
judges:
  jev: { type: decision, provider: typesafe, model: jev-latest }
defaultJudge: { type: ref, ref: jev }
criteria:
  - id: thesis
    name: Thesis & argument
    weight: 3
    anchors:
      poor: No identifiable thesis
      developing: Thesis present but vague or unsupported
      proficient: Clear thesis supported by relevant evidence
      excellent: Precise, arguable thesis sustained with well-integrated evidence
  - id: structure
    name: Organization
    weight: 2
    anchors:
      poor: Paragraphs lack topic sentences; order feels random
      developing: Some structure but transitions are weak
      proficient: Logical order with clear transitions
      excellent: Structure actively strengthens the argument
  - id: style
    name: Style & mechanics
    weight: 1
  - id: length
    name: Length requirement (800–1500 words)
    weight: 0
    judge: { type: benchmark, method: length, unit: words, min: 800, max: 1500, tolerance: 0.2 }
  - id: citations
    name: Has citations
    weight: 0.5
    scale: { type: binary, labels: [missing, present] }
    judge: { type: benchmark, method: regex, pattern: "\\(\\w+,? \\d{4}\\)|\\[\\d+\\]" }
aggregation:
  method: weighted_mean
  normalize: [0, 100]
  gates: [{ criterion: length, min: 1, message: Essay must be within the required length }]
  grades: [{ label: A, min: 90 }, { label: B, min: 80 }, { label: C, min: 70 }, { label: D, min: 60 }, { label: F, min: 0 }]
```

## Run an evaluation

Set `TYPESAFE_API_KEY` for Jev. No input tags are required: every criterion receives the supplied text.

```bash
export TYPESAFE_API_KEY="your-typesafe-key"
cat > essay.txt <<'EOF'
Public libraries should extend evening hours because shift workers need access after work. A city survey supports this proposal (Lee, 2024).
EOF
npx @verdict-ai/cli eval -r essay-grading.yaml -i ./essay.txt
```

The short sample deliberately fails the 800–1500-word requirement. Replace it with a full essay before interpreting the grade. This trimmed recipe uses Jev and benchmarks; it does not generate written feedback.

## What to change

Increase `thesis.weight` from 3 to 4 to emphasize argument. Change the length judge’s `min` and `max` to match the assignment. Adjust grade minima to match course policy.

Validate your edited YAML with `npx @verdict-ai/cli rubric validate essay-grading.yaml`. See the [rubric reference](/reference/rubric) for field definitions.
