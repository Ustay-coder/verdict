# Running a rubric version per environment

A walk-through of Verdict's control plane with nothing but this directory: a self-hosted server, a repository whose CI
reports its runs, a promotion to `prod`, and a service that reads `prod` and judges on its own machine.

```bash
pnpm install && pnpm build                                   # in a checkout of the Verdict repository
VERDICT_CLI="node $PWD/packages/cli/dist/bin.js" bash examples/control-plane/demo.sh
```

To run the same loop against a server that is already running — a deployment you want to check — give its address
and a key: `VERDICT_HUB_URL=https://… VERDICT_HUB_KEY=… bash demo.sh`. It then works in a project of its own
(`demo-…`) and deletes it when it is done.

Outside a checkout, `bash demo.sh` uses `npx @verdict-ai/cli` and needs `@verdict-ai/sdk` and `@verdict-ai/core`
installed next to `service.mjs`.

| File | What it is |
| --- | --- |
| `verdict.yaml` | Which project this repository's rubrics belong to |
| `rubrics/intent.yaml` | The rubric. Offline (keyword match), so no model key is needed |
| `cases.jsonl` | Labelled cases CI runs the rubric on. They never leave the machine that runs them |
| `service.mjs` | The service: asks the server which version `prod` runs, evaluates locally |
| `demo.sh` | The whole loop, on a temporary copy |

What goes where:

- **To the server**: the frozen rubric version, which version each environment runs, and the numbers of CI's runs
  (counts, agreement, hashes, commit). 
- **Never to the server**: the cases, the messages the service judges, and the answers.

In the service, the part that matters is three lines:

```js
const prod = verdict.environment({ project: "support-bot", environment: "prod" });
const { rubric, versionId, source } = await prod.rubric("intent");
const evaluation = await engine.evaluate({ rubric, subject: { inputs: [{ type: "text", text: message }] } });
```

`prod.rubric` keeps what it received and asks the server again at most once a minute, so a promotion or a rollback
reaches the service within that time without a deploy. If the server cannot be reached it keeps returning the version
it holds (`source: "stale"`); pass `fallback: { intent: rubric }` to have something to run at a cold start.
