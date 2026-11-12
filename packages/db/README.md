# @verdict-ai/db

Tenant-scoped Drizzle persistence for SQLite, Postgres and Cloudflare D1.

```bash
npm install @verdict-ai/db @verdict-ai/core
```

```ts
import { fromSqliteFile } from "@verdict-ai/db/sqlite";
import { Engine } from "@verdict-ai/core";
const handle = await fromSqliteFile("./verdict.sqlite");
const engine = new Engine({ store: handle.store });
const rubric = await engine.createRubric({
  name: "Review", criteria: [{ id: "quality", name: "Quality",
    judge: { type: "human", raters: ["reviewer"], required: 1 } }],
});
console.log(rubric.id);
handle.sqlite.close();
```

Requires Node 22 or newer. [Documentation](https://docs.verdict-ai.dev/reference/rest). MIT licensed.
