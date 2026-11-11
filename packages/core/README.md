# @verdict-ai/core

The embeddable evaluation engine: ingestion, rubric validation, judges and aggregation.

```bash
npm install @verdict-ai/core
```

```ts
import { Engine, MemoryStore } from "@verdict-ai/core";
const engine = new Engine({ store: new MemoryStore() });
const evaluation = await engine.evaluate({
  rubric: { name: "Presence", criteria: [{ id: "present", name: "Has text",
    judge: { type: "benchmark", method: "length", min: 1 } }] },
  subject: { inputs: [{ type: "text", text: "Hello Verdict" }] },
});
console.log(evaluation.id);
console.log(evaluation.status);
console.log(evaluation.aggregate.score);
```

Requires Node 20 or newer. [Documentation](https://docs.verdict-ai.dev/reference/rest). MIT licensed.
