import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { Engine } from "../src/engine.js";
import { evidenceDocuments, evidencePdfPages, imageInfo, ingest, lazyCanvasPdfPages, type PdfPageRenderer } from "../src/ingest/index.js";
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
    expect(e!.text).toBe("[document: scanned.pdf, 1 page; it has no text layer (a scan?), so there is no text to show. A judge that reads PDFs is sent the file itself, and one that takes pictures is sent pictures of its pages]");
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

describe("PDF pages as pictures, for a provider that takes pictures and does not read PDFs", () => {
  // Six pages, each saying which it is; the last one says the invoice is overdue.
  const sixPages = new URL("./fixtures/six-pages.pdf", import.meta.url).pathname;
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGKpsXrLAAZMDDAAAAAA//9F4ac5AAAABklEQVQDAB19AapnIGSYAAAAAElFTkSuQmCC";
  const rubric = parseRubric({ name: "Invoice", criteria: [{ id: "overdue", name: "Overdue", scale: { type: "binary", labels: ["no", "yes"] } }] });
  // Stands in for the canvas: one small picture per page asked for, and a record of which pages were asked.
  function fakePages() {
    const asked: number[][] = [];
    const render: PdfPageRenderer = async (_pdf, pages) => { asked.push(pages); return pages.map(() => ({ data: Uint8Array.from(Buffer.from(PNG, "base64")), mimeType: "image/png" as const })); };
    return { asked, render };
  }
  async function ask(provider: "gemini" | "openai" | "typesafe" | "cloudflare", reply: unknown, o: { pdfPages?: PdfPageRenderer; options?: Record<string, unknown> } = {}) {
    const evidence = await ingest({ inputs: [{ type: "file", path: sixPages }] }, { allowLocalFiles: true });
    let body: Record<string, unknown> | undefined;
    const f: typeof fetch = async (_url, init) => { body = JSON.parse(String(init?.body)) as Record<string, unknown>; return new Response(JSON.stringify(reply)); };
    const ctx: JudgeContext = { rubric, criterion: rubric.criteria[0]!, scale: rubric.criteria[0]!.scale!, evidence, evaluationId: "e", env: (n) => (n === "CLOUDFLARE_ACCOUNT_ID" ? "acct" : "k"), fetch: f, usage: { decisionCalls: 0, llmCalls: 0, inputTokens: 0, outputTokens: 0 }, ...(o.pdfPages ? { pdfPages: o.pdfPages } : {}) };
    const [rating] = await new DecisionJudge({ type: "decision", provider, onLowConfidence: "accept", escalateTo: [], ...(o.options ? { options: o.options } : {}) }).rate(ctx);
    return { body, rating: rating! };
  }
  const openaiReply = { model: "gpt-6-luna", answers: [{ type: "predicate", name: "overdue", probability: 0.9 }] };
  const clefReply = { success: true, result: { model: "clef", answers: { overdue: { type: "noul", noul: 0.9 } } } };

  it("draws a real page with the canvas when it is installed: a scan becomes a picture a model can read", async () => {
    const [e] = await ingest({ inputs: [{ type: "file", path: scanned }] }, { allowLocalFiles: true });
    const uris = await evidencePdfPages(e!, lazyCanvasPdfPages(), 4);
    expect(uris).toHaveLength(1);
    const picture = imageInfo(Uint8Array.from(Buffer.from(uris![0]!.slice(uris![0]!.indexOf(",") + 1), "base64")));
    // 1,240 pixels wide whatever the page: wide enough for small print.
    expect(picture).toMatchObject({ mimeType: "image/png", width: 1240 });
    expect(picture!.height).toBeGreaterThan(400);
    // Where the canvas is not installed the renderer says so with null, and nothing is drawn.
    expect(await lazyCanvasPdfPages(async () => undefined)(new Uint8Array(), [1])).toBeNull();
  });

  it("sends OpenAI every page as a picture beside the text, and Gemini the file with no pictures", async () => {
    const pages = fakePages();
    const { body, rating } = await ask("openai", openaiReply, { pdfPages: pages.render });
    const [message] = body!.input as Array<{ content: Array<Record<string, string>> }>;
    expect(message!.content.map((part) => part.type)).toEqual(["input_text", ...Array.from({ length: 6 }, () => "input_image")]);
    // The text layer still goes: the pictures add what text cannot carry.
    expect(message!.content[0]!.text).toContain("Page 1 of 6");
    expect(pages.asked).toEqual([[1, 2, 3, 4, 5, 6]]);
    expect(rating.raw).toMatchObject({ documents: { attached: 1, sent: 0 }, pages: { attached: 6, sent: 6 } });
    expect(rating.raw).not.toHaveProperty("images");

    const forGemini = fakePages();
    const gemini = await ask("gemini", { answers: { overdue: { noul: 0.9 } } }, { pdfPages: forGemini.render });
    expect((gemini.body!.input as Array<{ type: string }>).map((part) => part.type)).toEqual(["text", "document"]);
    expect(forGemini.asked).toEqual([]);
    expect(gemini.rating.raw).toMatchObject({ documents: { attached: 1, sent: 1 } });
    expect(gemini.rating.raw).not.toHaveProperty("pages");
  });

  it("sends Clef the four pictures it takes of a six-page document and records that two pages were cut", async () => {
    const pages = fakePages();
    const { body, rating } = await ask("cloudflare", clefReply, { pdfPages: pages.render });
    expect((body!.images as string[])).toHaveLength(4);
    expect(pages.asked).toEqual([[1, 2, 3, 4]]);
    expect(rating.status).toBe("scored");
    expect(rating.raw).toMatchObject({ pages: { attached: 6, sent: 4 } });
  });

  it("refuses instead of cutting when the judge says so, and takes a smaller limit from the judge", async () => {
    const refused = await ask("cloudflare", clefReply, { pdfPages: fakePages().render, options: { cutDocuments: "refuse" } });
    expect(refused.body).toBeUndefined();
    expect(refused.rating.status).toBe("error");
    expect(refused.rating.error).toBe('cloudflare: decide: the documents have 6 page(s) and only 4 can be sent as pictures (options.cutDocuments is "refuse")');
    // A whole document is not refused.
    const whole = await ask("openai", openaiReply, { pdfPages: fakePages().render, options: { cutDocuments: "refuse" } });
    expect(whole.rating.status).toBe("scored");
    const two = await ask("openai", openaiReply, { pdfPages: fakePages().render, options: { maxPdfPages: 2 } });
    expect(two.rating.raw).toMatchObject({ pages: { attached: 6, sent: 2 } });
  });

  it("gives the text alone where nothing can draw a page, and says no page was sent", async () => {
    const none = await ask("openai", openaiReply);
    expect(typeof none.body!.input).toBe("string");
    expect(none.rating.raw).toMatchObject({ pages: { attached: 6, sent: 0 } });
    // A text-only model is never shown pages, with or without a renderer.
    const pages = fakePages();
    const jev = await ask("typesafe", { model: "jev-1.14.0", answers: { overdue: { type: "noul", noul: 0.9 } } }, { pdfPages: pages.render });
    expect(pages.asked).toEqual([]);
    expect(jev.rating.raw).not.toHaveProperty("pages");
  });
});
