// Spawns the Verdict MCP server over stdio and calls its tools. Run: cd examples && pnpm mcp
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const client = new Client({ name: "smoke", version: "0" });
await client.connect(new StdioClientTransport({ command: "node", args: ["../packages/cli/dist/bin.js", "mcp"], env: { ...process.env, VERDICT_DATA_DIR: ".verdict-mcp" } }));
const tools = await client.listTools();
console.log("tools:", tools.tools.map(t => t.name).join(", "));
const rubric = { name: "mcp test", criteria: [{ id: "kw", name: "Keywords", judge: { type: "benchmark", method: "keywords", keywords: ["alpha", "beta"] } }, { id: "ai", name: "AI", judge: { type: "llm", provider: "mock", options: { score: 8 } } }, { id: "h", name: "Human", judge: { type: "human" } }] };
const r = await client.callTool({ name: "evaluate", arguments: { rubric, name: "doc", inputs: [{ type: "text", text: "alpha and beta" }] } });
const ev = JSON.parse(r.content[0].text);
console.log("evaluate:", ev.status, ev.score, ev.criteria.map(c => `${c.id}=${c.score ?? c.status}`).join(" "));
const s = await client.callTool({ name: "submit_human_score", arguments: { evaluationId: ev.id, criterionId: "h", raterId: "me", score: 9 } });
const ev2 = JSON.parse(s.content[0].text); console.log("after human:", ev2.status, ev2.score);
const cmp = await client.callTool({ name: "compare", arguments: { rubric: { name: "c", criteria: [{ id: "kw", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["x"] } }] }, subjects: [{ name: "a", inputs: [{ type: "text", text: "x" }] }, { name: "b", inputs: [{ type: "text", text: "y" }] }] } });
console.log("compare:", JSON.parse(cmp.content[0].text).map(x => `${x.rank}.${x.subject}=${x.score}`).join(" "));
const bad = await client.callTool({ name: "validate_rubric", arguments: { rubric: "name: x\ncriteria: []" } });
console.log("validate:", JSON.parse(bad.content[0].text).valid);
await client.close();
