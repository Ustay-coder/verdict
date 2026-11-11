# Using Verdict from an agent

Use Verdict as an explicit evaluation step after an agent produces a document or code artifact. MCP hosts call typed tools; terminal agents run the CLI and inspect the saved result. Keep human approval tasks assigned to reviewers rather than having the agent invent their scores.

## Connect an MCP host

Add this entry to `claude_desktop_config.json`, then restart the host. Start a Verdict API at the configured URL first; see [deployment](./deploy).

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

## Evaluate an artifact

Call the MCP tool `evaluate` with these arguments. This inline benchmark needs no model credentials:

```json
{
  "rubric": {
    "name": "Release notes",
    "criteria": [{
      "id": "migration",
      "name": "Includes migration guidance",
      "judge": {"type": "benchmark", "method": "keywords", "keywords": ["migration"], "mode": "any"}
    }]
  },
  "inputs": [{"type": "text", "text": "Migration: rename the timeout setting."}]
}
```

The response includes `id`, `status`, `score`, `passed`, `partial`, and criterion details. Check status and pending work before making an approval decision. The [MCP reference](/reference/mcp) groups all tools and describes local persistence.

## Run from a terminal agent or CI

Save the [getting-started rubric](./getting-started#your-first-rubric) as `rubric.yaml`, then run:

```bash
printf '%s\n' 'Migration: rename the timeout setting.' > release-notes.txt
npx @verdict-ai/cli eval -r rubric.yaml -i ./release-notes.txt
```

For a non-interactive Codex run from the directory containing those files:

```bash
codex exec "Run npx @verdict-ai/cli eval -r rubric.yaml -i ./release-notes.txt and report status, criterion scores, and the aggregate." < /dev/null
```

In CI, keep the rubric under version control and retain the evaluation ID for inspection. Use the [CLI reference](/reference/cli) to export results, or the [SDK](/reference/sdk) to branch explicitly on evaluation status and aggregate fields.

## Close the loop on your own code

Verdict's repository runs its quality harness on itself: the code is scored with the `code-quality-repo` and `code-quality-file` rubrics, a coding agent receives a brief built from the weakest files and criteria, and the result is kept only if the build, tests, lint, behaviour goldens and metric floors pass and the score does not fall. `scripts/harness/` in the repository is a template for the same loop on any codebase; `docs/HARNESS.md` explains the gates and why each exists.
