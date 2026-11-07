# Verdict rubric notes (short)

```yaml
criteria:
  - id: why                       # letters, digits, _ ; used in formulas as why_n (0..1)
    name: Says why
    inputs: [message]             # the gold set's input label
    scale: { type: binary, labels: [no, yes] }
    anchors: { no: "what a 'no' looks like", yes: "what a 'yes' looks like" }   # the judge picks between these
aggregation:
  method: formula                 # or weighted_mean
  formula: "what_n * why_n"       # comparisons and ?: work too
  normalize: [0, 100]
  passThreshold: 50               # passed = score >= 50; compared with the human pass/fail
```

- `context:` at the top is read by the judge for every criterion.
- Hand unsure messages to a human: on the judge, `minConfidence: 0.3, onLowConfidence: human`. Ratings whose
  confidence is below it wait for a person instead of counting. `check_against_humans` reports how many.
- `check_against_humans` also reports per-criterion agreement for criteria named `what` and `why`, the labels the
  gold set has.
