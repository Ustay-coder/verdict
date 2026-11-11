# Offline release benchmark

Release engineers use this rubric in CI to decide whether test metrics and release notes meet a shipping threshold. All judges are deterministic, so this recipe runs without provider credentials.

## Save the rubric

Save as `offline-benchmark.yaml`:

```yaml
name: Release readiness
scale: { type: numeric, min: 0, max: 100 }
criteria:
  - id: tests
    name: Test pass rate
    weight: 3
    judge: { type: benchmark, method: jsonpath, path: ci.pass_rate, input: ci }
  - id: coverage
    name: Coverage >= 80%
    weight: 1
    judge: { type: benchmark, method: formula, expression: "ci.coverage >= 80 ? 1 : ci.coverage / 80" }
  - id: changelog
    name: Changelog mentions breaking changes section
    weight: 1
    judge: { type: benchmark, method: keywords, keywords: [breaking changes, migration], mode: any }
  - id: readme
    name: README length
    weight: 0.5
    judge: { type: benchmark, method: length, unit: words, min: 200 }
aggregation: { method: weighted_mean, normalize: [0, 100], passThreshold: 80, grades: [{ label: ship, min: 80 }, { label: hold, min: 0 }] }
```

## Run an evaluation

No environment variables are required. The JSON input must be tagged `ci`; the Markdown input supplies release text. From a repository checkout:

```bash
npx @verdict-ai/cli eval -r offline-benchmark.yaml \
  -i ci=examples/inputs/ci.json -i examples/inputs/CHANGELOG.md
```

## What to change

Raise `passThreshold` from 80 to 90 for a stricter release policy. Change the coverage formula’s 80 target. Increase `tests.weight` from 3 to 4 to prioritize test pass rate.

Validate your edited YAML with `npx @verdict-ai/cli rubric validate offline-benchmark.yaml`. See the [rubric reference](/reference/rubric) for field definitions.
