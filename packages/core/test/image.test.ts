import { describe, expect, it } from "vitest";
import { Engine } from "../src/engine.js";
import { attachImages, evidenceImages, imageInfo, ingest } from "../src/ingest/index.js";
import { answerToScore, checkClefImages, criterionLevels } from "../src/judges/decision.js";
import { parseRubric } from "../src/schema/rubric.js";
import clefImageFixture from "./fixtures/cloudflare-clef-flash-image-response.json" with { type: "json" };

// 3×2 solid images rendered by Chromium (PNG / JPEG via screenshot, WebP via canvas).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAIAAAASFvFNAAAAEklEQVR4nGKpsXrLAAZMDDAAAAAA//9F4ac5AAAABklEQVQDAB19AapnIGSYAAAAAElFTkSuQmCC";
const JPG = "/9j/4AAQSkZJRgABAQAAAQABAAD/4gHYSUNDX1BST0ZJTEUAAQEAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADb/2wBDABALDA4MChAODQ4SERATGCgaGBYWGDEjJR0oOjM9PDkzODdASFxOQERXRTc4UG1RV19iZ2hnPk1xeXBkeFxlZ2P/2wBDARESEhgVGC8aGi9jQjhCY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2NjY2P/wAARCAACAAMDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAT/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAABAb/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCABSkP/9k=";
const WEBP = "UklGRgACAABXRUJQVlA4WAoAAAAgAAAAAgAAAQAASUNDUMgBAAAAAAHIAAAAAAQwAABtbnRyUkdCIFhZWiAH4AABAAEAAAAAAABhY3NwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQAA9tYAAQAAAADTLQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAlkZXNjAAAA8AAAACRyWFlaAAABFAAAABRnWFlaAAABKAAAABRiWFlaAAABPAAAABR3dHB0AAABUAAAABRyVFJDAAABZAAAAChnVFJDAAABZAAAAChiVFJDAAABZAAAAChjcHJ0AAABjAAAADxtbHVjAAAAAAAAAAEAAAAMZW5VUwAAAAgAAAAcAHMAUgBHAEJYWVogAAAAAAAAb6IAADj1AAADkFhZWiAAAAAAAABimQAAt4UAABjaWFlaIAAAAAAAACSgAAAPhAAAts9YWVogAAAAAAAA9tYAAQAAAADTLXBhcmEAAAAAAAQAAAACZmYAAPKnAAANWQAAE9AAAApbAAAAAAAAAABtbHVjAAAAAAAAAAEAAAAMZW5VUwAAACAAAAAcAEcAbwBvAGcAbABlACAASQBuAGMALgAgADIAMAAxADZWUDhMEQAAAC8CQAAAB1Cd8rW9/4GI6H8AAA==";
const bytes = (b64: string) => Uint8Array.from(Buffer.from(b64, "base64"));

describe("image metadata", () => {
  it("sniffs PNG, JPEG and WebP and reads their pixel size", () => {
    expect(imageInfo(bytes(PNG))).toMatchObject({ mimeType: "image/png", width: 3, height: 2 });
    expect(imageInfo(bytes(JPG))).toMatchObject({ mimeType: "image/jpeg", width: 3, height: 2 });
    expect(imageInfo(bytes(WEBP))).toMatchObject({ mimeType: "image/webp", width: 3, height: 2 });
    expect(imageInfo(new TextEncoder().encode("GIF89a not supported"))).toBeUndefined();
  });
});

describe("image ingestion", () => {
  it("ingests an image input: placeholder text + metadata on the evidence, bytes only in memory", async () => {
    const [e] = await ingest({ inputs: [{ type: "image", base64: PNG, filename: "shot.png", tags: ["ui"] }] });
    expect(e!.kind).toBe("image");
    expect(e!.text).toContain("3×2 PNG");
    expect(e!.images).toEqual([{ mimeType: "image/png", bytes: bytes(PNG).length, width: 3, height: 2 }]);
    expect(evidenceImages(e!)).toEqual([`data:image/png;base64,${PNG}`]);
    expect(JSON.stringify(e)).not.toContain(PNG);
  });

  it("accepts a data URI as base64 and rejects unsupported formats", async () => {
    const [e] = await ingest({ inputs: [{ type: "image", base64: `data:image/webp;base64,${WEBP}` }] });
    expect(e!.images![0]!.mimeType).toBe("image/webp");
    await expect(ingest({ inputs: [{ type: "image", base64: Buffer.from("GIF89a").toString("base64") }] })).rejects.toThrow(/unsupported image/);
  });

  const page = (async () => new Response("<html><head><title>Dash</title></head><body><h1>Revenue</h1></body></html>", { headers: { "content-type": "text/html" } })) as unknown as typeof fetch;

  it("screenshots a url input when the engine has a renderer", async () => {
    const calls: unknown[] = [];
    const [e] = await ingest({ inputs: [{ type: "url", url: "http://localhost:5173/", screenshot: { width: 1024 } }] }, {
      fetch: page, screenshot: async (url, o) => { calls.push([url, o]); return { data: bytes(PNG) }; },
    });
    expect(calls).toEqual([["http://localhost:5173/", { width: 1024, height: 800, fullPage: false, settleMs: 1500 }]]);
    expect(e!.text).toMatch(/revenue/i);
    expect(e!.text).toContain("[screenshot of http://localhost:5173/ attached: 3×2 PNG]");
    expect(evidenceImages(e!)).toHaveLength(1);
  });

  it("stores no image bytes at all for url screenshots", async () => {
    const engine = new Engine({ fetch: page, ingest: { screenshot: async () => ({ data: bytes(PNG) }) } });
    const r = parseRubric({ name: "t", criteria: [{ id: "k", name: "k", judge: { type: "benchmark", method: "keywords", keywords: ["revenue"] } }] });
    const ev = await engine.evaluate({ rubric: r, subject: { inputs: [{ type: "url", url: "http://localhost:5173/", screenshot: true }] } });
    expect(ev.evidence[0]!.images).toHaveLength(1);
    expect(JSON.stringify(await engine.store.getEvaluation(ev.id))).not.toContain(PNG);
  });

  it("keeps the text and warns when no renderer is configured", async () => {
    const [e] = await ingest({ inputs: [{ type: "url", url: "http://localhost:5173/", screenshot: true }] }, { fetch: page });
    expect(e!.images).toBeUndefined();
    expect(e!.warnings?.[0]).toMatch(/no screenshot renderer/);
  });
});

describe("images reach vision-capable decision models only", () => {
  const rubric = parseRubric({
    name: "ui",
    criteria: [{ id: "template", name: "Template look", levels: [{ value: 0, label: "generic", description: "Generic AI template" }, { value: 10, label: "deliberate", description: "Deliberate design" }] }],
  });
  const subject = { inputs: [{ type: "image" as const, base64: PNG, filename: "shot.png" }] };
  const capture = (answer: unknown) => {
    const bodies: Array<Record<string, unknown>> = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { bodies, fetchImpl };
  };
  const answer = { answers: { template: { type: "score", score: 1, probabilities: { "0": 0.1, "1": 0.9 }, confidence: 0.8 } } };

  it("Clef gets the image as a data URI; stored evidence keeps metadata only", async () => {
    const { bodies, fetchImpl } = capture({ success: true, result: answer });
    const engine = new Engine({ fetch: fetchImpl, env: (n) => ({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" })[n] });
    const ev = await engine.evaluate({ rubric: { ...rubric, defaultJudge: { type: "decision", provider: "cloudflare", model: "@cf/cloudflare/clef-flash" } }, subject });
    expect(bodies[0]!.images).toEqual([`data:image/png;base64,${PNG}`]);
    expect(ev.criteria[0]!.ratings[0]!.raw).toMatchObject({ images: { attached: 1, sent: 1 } });
    expect(ev.aggregate.score).toBeGreaterThan(80);
    // The request's own `subject.inputs` keeps what the caller sent (as with `file` base64); evidence never copies the bytes.
    const stored = await engine.store.getEvaluation(ev.id);
    expect(JSON.stringify(stored!.evidence)).not.toContain(PNG);
    expect(stored!.evidence[0]!.images).toEqual([{ mimeType: "image/png", bytes: 93, width: 3, height: 2 }]);
  });

  it("text-only providers (Jev) never receive images; the drop is recorded", async () => {
    const { bodies, fetchImpl } = capture(answer);
    const engine = new Engine({ fetch: fetchImpl, env: (n) => (n === "TYPESAFE_API_KEY" ? "k" : undefined) });
    const ev = await engine.evaluate({ rubric: { ...rubric, defaultJudge: { type: "decision", provider: "typesafe" } }, subject });
    expect(bodies[0]!.images).toBeUndefined();
    expect(String(bodies[0]!.state)).toContain("[image: shot.png, 3×2 PNG");
    expect(ev.criteria[0]!.ratings[0]!.raw).toMatchObject({ images: { attached: 1, sent: 0 } });
  });

  it("caps Clef at 4 images and enforces its size limits", async () => {
    const { bodies, fetchImpl } = capture({ success: true, result: answer });
    const engine = new Engine({ fetch: fetchImpl, env: (n) => ({ CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_API_TOKEN: "tok" })[n] });
    const many = { inputs: Array.from({ length: 5 }, () => ({ type: "image" as const, base64: PNG })) };
    const ev = await engine.evaluate({ rubric: { ...rubric, defaultJudge: { type: "decision", provider: "cloudflare" } }, subject: many });
    expect(bodies[0]!.images).toHaveLength(4);
    expect(ev.criteria[0]!.ratings[0]!.raw).toMatchObject({ images: { attached: 5, sent: 4 } });
    expect(() => checkClefImages(["https://example.com/a.png"])).toThrow(/data URI/);
    expect(() => checkClefImages([`data:image/png;base64,${"A".repeat(6 * 1024 * 1024)}`])).toThrow(/4 MiB/);
  });

  it("attachImages refuses non-image bytes", () => {
    const e = { inputIndex: 0, kind: "text" as const, label: "x", tags: [], text: "", stats: { chars: 0, words: 0, lines: 0 } };
    expect(() => attachImages(e, [{ data: new TextEncoder().encode("nope") }])).toThrow(/unsupported image/);
  });
});

describe("live Clef-flash image fixture", () => {
  it("parses the verbatim response from a real screenshot call (2026-11-05)", () => {
    const r = clefImageFixture.result;
    expect(clefImageFixture.success).toBe(true);
    expect(r.answers.grad.noul).toBeGreaterThan(0.9);
    const levels = [{ value: 0, label: "generic", description: "" }, { value: 1, label: "mixed", description: "" }, { value: 2, label: "deliberate", description: "" }];
    const s = answerToScore(r.answers.template as never, levels, { type: "numeric", min: 0, max: 2 });
    expect(s.probabilities.generic).toBeGreaterThan(0.85);
    void criterionLevels;
  });
});

describe("image input sources", () => {
  it("reads a local path only when local files are allowed, and needs a source", async () => {
    const readFile = async () => bytes(PNG);
    const [e] = await ingest({ inputs: [{ type: "image", path: "/screens/home.png" }] }, { allowLocalFiles: true, readFile });
    expect(e).toMatchObject({ label: "home.png", source: "home.png" });
    await expect(ingest({ inputs: [{ type: "image", path: "/screens/home.png" }] }, { readFile })).rejects.toThrow(/local file paths are disabled/);
    await expect(ingest({ inputs: [{ type: "image" }] })).rejects.toThrow(/needs `path` or `base64`/);
  });
});
