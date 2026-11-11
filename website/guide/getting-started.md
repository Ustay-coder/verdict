# Getting started

Verdict turns a rubric and evidence into criterion scores, a total, a grade, and a pass decision. Start with a benchmark to check your integration offline; then introduce decision models or reviewers.

## Install

Use Node 20 or newer (the repository builds and tests on Node 22).

```bash
npm install @verdict-ai/sdk
# Or run the CLI without installing globally:
npx @verdict-ai/cli --help
```

For an embedded engine install `@verdict-ai/core`. The server, persistence and agent tools live in `@verdict-ai/api`, `@verdict-ai/db`, and `@verdict-ai/mcp`.

## Your first rubric

Save `rubric.yaml`:

```yaml
name: Release notes
scale: { type: binary, labels: [missing, present] }
criteria:
  - id: migration
    name: Includes migration guidance
    judge: { type: benchmark, method: keywords, keywords: [migration], mode: any }
aggregation: { method: weighted_mean, normalize: [0, 100], passThreshold: 100 }
```

```bash
printf '%s\n' 'Migration: update your configuration.' > release-notes.txt
npx @verdict-ai/cli rubric validate rubric.yaml
npx @verdict-ai/cli eval -r rubric.yaml -i ./release-notes.txt
```

The CLI stores local evaluations in `.verdict`. The sample scores 100 and passes because its text contains `migration`.

## REST

```bash
VERDICT_API_KEYS="local-key:acme" npx @verdict-ai/cli serve -p 8787 --data-dir ./data
curl http://localhost:8787/v1/rubrics \
  -H 'Authorization: Bearer local-key' -H 'Content-Type: application/yaml' \
  --data-binary @rubric.yaml
```

Use the returned rubric ID:

```bash
curl http://localhost:8787/v1/evaluations \
  -H 'Authorization: Bearer local-key' -H 'Content-Type: application/json' \
  -d '{"rubric":"rub_ID","inputs":[{"type":"text","text":"Migration: update your configuration."}]}'
```

The response includes `status`, `criteria`, and `aggregate`. Provider errors and pending humans are represented in ratings; inspect status before acting on the score.

## SDK

```ts
import { Verdict } from '@verdict-ai/sdk';
const verdict = new Verdict({ baseUrl: 'http://localhost:8787', apiKey: 'local-key' });
const result = await verdict.evaluations.create({
  rubric: 'rub_ID', inputs: [{ type: 'text', text: 'Migration: update configuration.' }],
});
console.log(result.status, result.aggregate);
```

Next, replace a benchmark with a [decision judge](./decision-models), or add a [human review](./humans).
