# TypeScript SDK

## Install and connect

```bash
npm install @verdict-ai/sdk
```

```ts
import { Verdict, VerdictError } from '@verdict-ai/sdk';
const client = new Verdict({ baseUrl: 'http://localhost:8787', apiKey: process.env.VERDICT_API_KEY });
const { evaluation, replayed } = await client.evaluations.createIdempotent({
  rubric: 'rub_ID', inputs: [{ type: 'text', text: 'Customer evidence' }],
}, 'review-123');
console.log(evaluation.aggregate, replayed);
```

`baseUrl` defaults to `VERDICT_API_URL` or `http://localhost:8787`; `apiKey` defaults to `VERDICT_API_KEY`. Options include injected `fetch` and `timeoutMs` (default ten minutes).

## Rubrics and resource methods

| Resource | Methods |
| --- | --- |
| `rubrics` | `create`, `validate`, `get`, `list`, `update`, `delete`, `calibration` |
| `evaluations` | `create`, `createIdempotent`, `createAsync`, `get`, `list`, `retry`, `submitScore`, `reaggregate`, `wait` |
| `tasks` | `list(rater?)` |
| `batches` | `create`, `createIdempotent` |
| `publications` | `preview`, `create`, `list`, `withdraw` (public hub) |
| `projects` | `create(name)`, `list`, `delete(name)`, `history(project, { environment, name, limit })` |
| `environments` | `create(project, name)`, `list(project)`, `get(project, name, { include? })` (with pointers; `include: "rubrics"` adds each pointer's rubric document), `delete(project, name)`, `promote(project, name, { changes, note })`, `rollback(project, name, { name, expected, note })` |
| `versions` | `names(project)`, `push(project, name, { id, rubric })`, `list(project, name)`, `get(project, name, id)`, `delete(project, name, id)` |
| `reports` | `run(project, request)`, `runs(project, { name, versionId, dataset, limit })`, `getRun(project, runId)`, `comparison(project, request)`, `comparisons(project, { name, head, limit })`. Build requests with `runReportRequest` / `comparisonReportRequest` from `@verdict-ai/core`: they copy conditions and counts only |
| `hub` | `config`, `login(githubToken)`, `me`, `revokeKey(id)` (hub sign-in); `search(q)`, `card(owner, slug, { version })`, `publication(id)` (public reads, no key) |

## Reading what an environment runs

A service that judges on its own machine asks one thing of the server: which version of each rubric does my environment run?

```ts
const prod = client.environment({ project: 'support-bot', environment: 'prod' });   // keep one per process

const { rubric, versionId, source } = await prod.rubric('intent');
const evaluation = await engine.evaluate({ rubric, subject: { inputs: [{ type: 'text', text: message }] } });
log.info({ versionId, source });   // which rubric decided this
```

The reader receives the whole environment in one answer, keeps it, and after `refreshMs` (default 60 s) the next call asks again — no timer runs, so it works in Workers, and an unchanged environment costs a 304. Every rubric is used only if it freezes, locally, to the version id the server named. `source` is `server` (confirmed by the last check), `stale` (the last check failed or took longer than `timeoutMs`, default 2 s; this is the version already held) or `fallback`. Failed checks go to `onError` and are not retried before the next interval.

Options: `refreshMs`, `timeoutMs`, `onError(error)`, and `fallback: { intent: rubric }` — rubrics to run while the server has given none (a cold start it cannot answer, or a rubric not promoted yet). Without a fallback, `rubric(name)` throws `VerdictError` `environment_unavailable` when nothing was ever received, and `not_promoted` when the environment does not run that rubric. `refresh()` asks now and resolves to whether the check succeeded. To read one exact version instead, use `versions.get(project, name, 'rv_…')`.

## Evaluations, batches, and retries

`create`, `createAsync`, and batch `create` accept `{ idempotencyKey }` as a second argument. `createIdempotent` returns replay metadata. `wait(id)` polls until settled, including `pending_human` unless `waitForHumans: true`.

```ts
const job = await client.evaluations.createAsync({ rubric: 'rub_ID', inputs: [{ type: 'text', text: 'Evidence' }] });
const result = await client.evaluations.wait(job.id, { timeoutMs: 60_000 });
```

## Human tasks and policy changes

List work with `await client.tasks.list("reviewer")`, then submit the assigned score:

```ts
await client.evaluations.submitScore(result.id, { criterionId: 'team', raterId: 'reviewer', score: 4 });
await client.evaluations.reaggregate(result.id, { method: 'min' }); // persist defaults to false
```

## Errors and raw requests

Errors throw `VerdictError` with `status`, `type`, optional `issues`, and `details` (the API's whole error object: a refused promotion, `type: "pointer_conflict"`, lists where the pointers are in `details.current`). A 422 evaluation response without an error envelope is returned as an evaluation, so check its `status`. For admin or discovery routes use `request` / `requestWithMeta` with appropriate credentials. See [REST](./rest) and [the typed client source](https://github.com/Ustay-coder/verdict/blob/main/packages/sdk/src/index.ts) for exact signatures.

Next, use the [REST examples](./rest) to choose request fields, or [deploy the API](/guide/deploy) for durable storage.
