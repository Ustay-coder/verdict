# MCP

## Connect a host

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "verdict": {
      "command": "npx",
      "args": ["-y", "@verdict-ai/mcp"],
      "env": {
        "VERDICT_API_URL": "http://localhost:8787",
        "VERDICT_API_KEY": "your-tenant-key"
      }
    }
  }
}
```

## Local storage and credentials

Without a remote API URL, the server uses a local engine and in-memory store; set `VERDICT_DATA_DIR` to persist evaluations in a file store. Set the relevant judge credentials in the host environment for local model evaluations. The CLI also exposes `verdict mcp`.

## Author rubrics

Use `validate_rubric` to check YAML or JSON, `create_rubric` to store it, and `list_rubrics` to retrieve IDs.

## Evaluate and compare

`evaluate` accepts a stored rubric ID or inline rubric plus `inputs`. `compare` accepts a rubric and at least two named `subjects`, each with inputs. `get_evaluation` takes `{ "id": "eval_ID" }` to retrieve status and criterion results.

## Complete human tasks

`list_human_tasks` accepts an optional `rater`. `submit_human_score` requires `evaluationId`, `criterionId`, `raterId`, and `score`. Follow [human review](/guide/humans) for allowed raters and score validation.

## Recompute and calibrate

`reaggregate` takes `evaluationId` and an `aggregation` object; `persist` defaults to false. It does not call judges. `calibration_report` takes `rubricId` and optional `target` and `buckets` to compare decision ratings with human consensus.

## Check a rubric against people

`check_against_humans` runs a rubric over a gold set: subjects people already judged, as a local JSON array or JSON-lines file of `{ id?, name, inputs, expected?: { <criterion>: label }, human?: { passed?, criteria? }, labelSource?, split? }` (choice criteria take an option id; unreadable labels are rejected before any judge runs). Pass `rubricPath` (a local YAML or JSON file, re-read on every call, so an agent can edit it and check again) or `rubric`, plus `gold`. The reply gives how many of Verdict's verdicts match the humans, agreement per labelled criterion and per split, label-source counts, how many subjects the judge handed to a human (those count neither way), and each disagreement with a preview. Local mode only; the CLI equivalent is `verdict check -r rubric.yaml -g gold.jsonl`.

## Use cards from a hub

Set `VERDICT_HUB_URL` (or pass `hub` to each call). `hub_search` takes `q`, `domain`, `locale`, `type` (`noul` for yes/no, `score`, `choice`), `owner` and `limit`, and returns refs such as `hub:alice/agent-intent@rv_…`. `hub_get` takes a `ref` and returns the question and its answers, threshold, licence, lineage, the author's reported agreement numbers, versions and up to 20 public cases. `fork_rubric` copies the card into this server's rubrics under a new id (optionally a new `name`), with `metadata.forkedFrom` recording the hub, ref and licence; `evaluate` can then use the returned id. All three are public reads: no key is sent. A card is used only if its rubric freezes, here, to the version the hub names.

Next, [run the agent example](/guide/codex#evaluate-an-artifact). See [tool schemas](https://github.com/Ustay-coder/verdict/blob/main/packages/mcp/src/index.ts) for exact arguments.
