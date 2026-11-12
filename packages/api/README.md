# @verdict-ai/api

Hono REST API for Node and Cloudflare Workers.

```bash
npm install @verdict-ai/api @verdict-ai/core
```

```ts
import { Engine, MemoryStore } from "@verdict-ai/core";
import { createApp } from "@verdict-ai/api";
const engine = new Engine({ store: new MemoryStore() });
const app = createApp({ engine });
const response = await app.request("/v1/health");
console.log(response.status);
console.log(await response.json());
// Export app.fetch for a compatible HTTP runtime.
// Configure authentication before exposing a public service.
export default app;
```

Requires Node 22 or newer. [Documentation](https://docs.verdict-ai.dev/reference/rest). MIT licensed.
