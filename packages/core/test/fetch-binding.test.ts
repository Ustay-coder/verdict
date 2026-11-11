import { afterEach, describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { ingest } from "../src/ingest/index.js";

// Cloudflare Workers throw "Illegal invocation" when `fetch` is invoked with a `this` other than globalThis.
// Simulate that strictness so a regression fails in Node too.
const original = globalThis.fetch;
function strictFetch(this: unknown, input: RequestInfo | URL, init?: RequestInit) {
  if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation: function called with incorrect `this` reference");
  // Check binding synchronously without starting an unobserved network request.
  return new Response("ok");
}
afterEach(() => { globalThis.fetch = original; });

describe("fetch binding", () => {
  it("engine and ingest call the global fetch without a foreign `this`", async () => {
    let called = 0;
    globalThis.fetch = (async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
      called++;
      strictFetch.call(this, input, init); // throws on a bad `this` before any network
      return new Response("<html><body>ok</body></html>", { headers: { "content-type": "text/html" } });
    }) as unknown as typeof fetch;
    const engine = new Engine();
    const ev = await engine.evaluate({
      rubric: { name: "f", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["ok"] } }] },
      subject: { inputs: [{ type: "url", url: "https://example.test/page" }] },
    });
    expect(ev.status).toBe("completed");
    expect(ev.criteria[0]!.score).toBe(10);
    expect(called).toBe(1);
    const [e] = await ingest({ inputs: [{ type: "url", url: "https://example.test/page" }] });
    expect(e!.text).toContain("ok");
  });
});
