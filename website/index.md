---
layout: home
hero:
  name: Verdict
  text: The evaluation engine API
  tagline: Score evidence with decision models, bring humans into the loop, and apply a policy you control.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: Explore rubrics
      link: /reference/rubric
features:
  - title: Decision models first
    details: Jev and Clef return probabilities over your rubric levels. Shared judge and evidence means one request per rubric scoring batch.
  - title: Humans in the loop
    details: Assign reviewers, collect independent ratings, and escalate uncertain decisions through a task inbox.
  - title: Reproducible policy
    details: Mix deterministic benchmarks with model scores. Freeze each rubric and reaggregate stored ratings without another provider call.
---

## Evaluate without a provider key

```bash
npx @verdict-ai/cli eval -r rubric.yaml -i ./release-notes.txt
```

Save this as `rubric.yaml`:

```yaml
name: Release notes
criteria:
  - id: migration
    name: Includes migration guidance
    judge: { type: benchmark, method: keywords, keywords: [migration], mode: any }
```

Use [REST](/reference/rest), the [SDK](/reference/sdk), or [MCP](/reference/mcp) to add the same evaluation step to a product or agent.
