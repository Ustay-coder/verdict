# @verdict-ai/sdk

Typed HTTP client for the Verdict REST API.

```bash
npm install @verdict-ai/sdk
```

```ts
import { Verdict } from "@verdict-ai/sdk";
const verdict = new Verdict({ baseUrl: "http://localhost:8787" });
const rubric = await verdict.rubrics.create({
  name: "Presence", criteria: [{ id: "present", name: "Has text",
    judge: { type: "benchmark", method: "length", min: 1 } }],
});
const evaluation = await verdict.evaluations.create({
  rubric: rubric.id, inputs: [{ type: "text", text: "Hello Verdict" }],
});
console.log(evaluation.aggregate.score);
```

Requires Node 20 or newer. [Documentation](https://verdict-docs.developerolim.workers.dev/reference/sdk). MIT licensed.
