/**
 * Shapes MCP tool replies. Every tool answers with JSON text; failures become MCP error content instead of
 * rejecting, so a client sees the message rather than a transport error.
 */
export const text = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v, null, 2) }] });

/** Runs a tool handler; a rejection, including from a local adapter, becomes `isError` content. */
export async function toolResult<T>(work: () => Promise<T>) {
  try { return await work(); }
  catch (error) { return { isError: true, ...text({ error: error instanceof Error ? error.message : String(error) }) }; }
}
