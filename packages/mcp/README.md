# @verdict-ai/mcp

Stdio MCP server exposing evaluation tools to agents.

```bash
npm install @verdict-ai/mcp
```

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "verdict": {
      "command": "npx",
      "args": ["-y", "@verdict-ai/mcp"],
      "env": {
        "VERDICT_API_URL": "http://localhost:8787"
      }
    }
  }
}
```

Requires Node 20 or newer. [Documentation](https://docs.verdict-ai.dev/reference/mcp). MIT licensed.
