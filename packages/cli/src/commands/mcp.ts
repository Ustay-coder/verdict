/**
 * Registers the mcp command and its presentation boundary.
 * Local and remote execution share command semantics; rejected operations propagate to the CLI failure handler.
 */
import { Command } from "commander";

/** Registers mcp operations; handler failures propagate to the transport error boundary. */
export function registerMcp(program: Command) {
  program.command("mcp").description("run the MCP server over stdio (local engine, or remote if VERDICT_API_URL is set)").action(async () => {
    const { createMcpServer } = await import("@verdict-ai/mcp");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    await createMcpServer().connect(new StdioServerTransport());
  });

}
