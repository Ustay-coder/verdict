import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { ingest } from "../src/ingest/index.js";

const fixture = new URL("./fixtures/sample.pdf", import.meta.url).pathname;

describe("PDF ingestion", () => {
  it("reads a PDF from a local path (Node Buffer must be accepted by the parser)", async () => {
    const [e] = await ingest({ inputs: [{ type: "file", path: fixture }] }, { allowLocalFiles: true });
    expect(e!.text).toContain("Acme Robotics");
    expect(e!.stats.words).toBeGreaterThan(10);
  });
  it("reads a PDF through an injected readFile and from base64 without detaching the caller's bytes", async () => {
    const bytes = await readFile(fixture);
    const [viaInjected] = await ingest({ inputs: [{ type: "file", path: "ignored.pdf" }] }, { allowLocalFiles: true, readFile: async () => bytes });
    expect(viaInjected!.text).toContain("Acme Robotics");
    expect(bytes.byteLength).toBeGreaterThan(0); // pdf.js transfers its input buffer; the caller's copy must survive
    const [viaBase64] = await ingest({ inputs: [{ type: "file", base64: bytes.toString("base64"), filename: "deck.pdf" }] });
    expect(viaBase64!.text).toContain("Acme Robotics");
  });
});
