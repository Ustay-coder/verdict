import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Engine } from "../src/engine.js";
import { evidenceDocuments, ingest } from "../src/ingest/index.js";
import { DecisionJudge } from "../src/judges/decision.js";
import type { JudgeContext } from "../src/judges/types.js";
import { parseRubric } from "../src/schema/rubric.js";

const fixture = new URL("./fixtures/sample.pdf", import.meta.url).pathname;
// One page that is only a picture of an invoice: a PDF with no text layer, as a scanner makes.
const scanned = new URL("./fixtures/scanned.pdf", import.meta.url).pathname;

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

  it("keeps the file beside its text: metadata on the evidence, the bytes only in memory", async () => {
    const bytes = await readFile(fixture);
    const [e] = await ingest({ inputs: [{ type: "file", path: fixture }] }, { allowLocalFiles: true });
    expect(e!.documents).toEqual([{ mimeType: "application/pdf", bytes: bytes.length, pages: expect.any(Number) }]);
    expect(e!.documents![0]!.pages).toBeGreaterThan(0);
    // The file a judge that reads PDFs is sent is the file that was given, byte for byte.
    expect(evidenceDocuments(e!)).toEqual([`data:application/pdf;base64,${bytes.toString("base64")}`]);
    expect(JSON.stringify(e)).not.toContain(bytes.toString("base64").slice(0, 200));
    // Other files carry no document.
    const [text] = await ingest({ inputs: [{ type: "file", base64: Buffer.from("plain").toString("base64"), filename: "note.txt" }] });
    expect(text!.documents).toBeUndefined();
    expect(evidenceDocuments(text!)).toEqual([]);
  });

  it("takes a scanned PDF as evidence and says there is no text to show, instead of refusing it as empty", async () => {
    const [e] = await ingest({ inputs: [{ type: "file", path: scanned }] }, { allowLocalFiles: true });
    expect(e!.text).toBe("[document: scanned.pdf, 1 page; it has no text layer (a scan?), so there is no text to show. Judges that read PDFs are sent the file itself]");
    expect(e!.warnings).toEqual(["PDF contains little extractable text (scanned? consider OCR)"]);
    expect(evidenceDocuments(e!)).toHaveLength(1);
    // An evaluation of it runs: before, it stopped with "evidence is empty after ingestion".
    const engine = new Engine({ ingest: { allowLocalFiles: true } });
    const rubric = parseRubric({ name: "t", defaultJudge: { type: "decision", provider: "mock" }, criteria: [{ id: "ok", name: "OK", scale: { type: "binary" } }] });
    const evaluation = await engine.evaluate({ rubric, subject: { inputs: [{ type: "file", path: scanned }] } });
    expect(evaluation.status).toBe("completed");
    expect(JSON.stringify(await engine.store.getEvaluation(evaluation.id))).not.toContain("JVBERi0");
  });
});

describe("what a decision provider is sent for a PDF and a picture", () => {
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGKpsXrLAAZMDDAAAAAA//9F4ac5AAAABklEQVQDAB19AapnIGSYAAAAAElFTkSuQmCC";
  const rubric = parseRubric({ name: "Invoice", criteria: [{ id: "overdue", name: "Overdue", scale: { type: "binary", labels: ["no", "yes"] } }] });
  const subject = { inputs: [{ type: "file" as const, path: fixture }, { type: "image" as const, base64: PNG, filename: "stamp.png" }] };
  async function ask(provider: "gemini" | "openai" | "typesafe" | "cloudflare", reply: unknown) {
    const evidence = await ingest(subject, { allowLocalFiles: true });
    let body: Record<string, unknown> | undefined;
    const f: typeof fetch = async (_url, init) => { body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify(reply)); };
    const ctx: JudgeContext = { rubric, criterion: rubric.criteria[0]!, scale: rubric.criteria[0]!.scale!, evidence, evaluationId: "e", env: (n) => (n === "CLOUDFLARE_ACCOUNT_ID" ? "acct" : "k"), fetch: f, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 } };
    const [rating] = await new DecisionJudge({ type: "decision", provider, onLowConfidence: "accept", escalateTo: [] }).rate(ctx);
    return { body: body!, rating: rating!, pdf: (await readFile(fixture)).toString("base64") };
  }

  it("sends Gemini the PDF itself and the picture, and names the file in the text instead of repeating it", async () => {
    const { body, rating, pdf } = await ask("gemini", { answers: { overdue: { type: "noul", noul: 0.9, confidence: 0.9 } } });
    const input = body.input as Array<Record<string, string>>;
    // The shape the live API took on 2026-11-12: a list of parts, each file as its type, `mime_type` and base64 `data`.
    expect(input.map((part) => part.type)).toEqual(["text", "image", "document"]);
    expect(input[1]).toEqual({ type: "image", mime_type: "image/png", data: PNG });
    expect(input[2]).toEqual({ type: "document", mime_type: "application/pdf", data: pdf });
    expect(input[0]!.text).toMatch(/\[document: sample\.pdf, \d+ pages?, \d+ KB PDF; the file itself is attached\]/);
    expect(input[0]!.text).not.toContain("Acme Robotics");
    expect(rating.status).toBe("scored");
    expect(rating.raw).toMatchObject({ images: { attached: 1, sent: 1 }, documents: { attached: 1, sent: 1 } });
  });

  it("sends OpenAI the picture and the PDF's text, because it takes pictures and refuses files", async () => {
    const { body, rating } = await ask("openai", { model: "gpt-6-luna", answers: [{ type: "predicate", name: "overdue", probability: 0.9 }] });
    const [message] = body.input as Array<{ role: string; content: Array<Record<string, string>> }>;
    expect(message!.role).toBe("user");
    expect(message!.content.map((part) => part.type)).toEqual(["input_text", "input_image"]);
    expect(message!.content[1]).toEqual({ type: "input_image", image_url: `data:image/png;base64,${PNG}` });
    expect(message!.content[0]!.text).toContain("Acme Robotics");
    expect(JSON.stringify(body)).not.toContain("JVBERi0");
    expect(rating.raw).toMatchObject({ images: { attached: 1, sent: 1 }, documents: { attached: 1, sent: 0 } });
  });

  it("sends a text-only model the text and records that it was sent neither the picture nor the file", async () => {
    const { body, rating } = await ask("typesafe", { model: "jev-1.14.0", answers: { overdue: { type: "noul", noul: 0.9 } } });
    expect(Object.keys(body).sort()).toEqual(["model", "questions", "state"]);
    expect(body.state).toContain("Acme Robotics");
    expect(rating.raw).toMatchObject({ images: { attached: 1, sent: 0 }, documents: { attached: 1, sent: 0 } });
  });

  it("keeps a request with no picture and no file as plain text for Gemini and OpenAI", async () => {
    for (const [provider, reply] of [["gemini", { answers: { overdue: { noul: 0.9 } } }], ["openai", { answers: [{ type: "predicate", name: "overdue", probability: 0.9 }] }]] as const) {
      let body: Record<string, unknown> | undefined;
      const f: typeof fetch = async (_url, init) => { body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify(reply)); };
      const evidence = await ingest({ inputs: [{ type: "text", text: "Payment is overdue." }] });
      const ctx: JudgeContext = { rubric, criterion: rubric.criteria[0]!, scale: rubric.criteria[0]!.scale!, evidence, evaluationId: "e", env: () => "k", fetch: f, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 } };
      const [rating] = await new DecisionJudge({ type: "decision", provider, onLowConfidence: "accept", escalateTo: [] }).rate(ctx);
      expect(typeof body!.input, provider).toBe("string");
      expect(rating!.raw, provider).not.toHaveProperty("documents");
    }
  });
});
