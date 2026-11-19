import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { extractDocument, ExtractionError, sniff } from "../src/extract.js";
import { fakeLlm } from "./helpers.js";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../fixtures/${name}`, import.meta.url)));

describe("document extraction", () => {
  it("keeps page positions for text PDFs", async () => {
    const ex = await extractDocument(fixture("가온테크_신청서류.pdf"), { ocrModel: "none" });
    expect(ex.kind).toBe("pdf");
    expect(ex.pages).toHaveLength(2);
    expect(ex.pages[0]!.text).toMatch(/개업연월일/);
    expect(ex.pages[0]!.text).toMatch(/울산광역시 남구/);
    expect(ex.pages[1]!.text).toMatch(/1,250,000,000/);
    expect(ex.pages.every((p) => p.source === "text")).toBe(true);
  });

  it("renders scanned pages and sends them to the OCR model, marking the text as OCR", async () => {
    const seen: string[] = [];
    const llm = fakeLlm({ ocr_page: (call) => { const part = (call.user as Array<{ type: string; image_url?: { url: string } }>).find((p) => p.type === "image_url"); seen.push(part!.image_url!.url.slice(0, 22)); return { text: `판독 ${seen.length}`, legible: true }; } });
    const ex = await extractDocument(fixture("한빛기계_스캔본.pdf"), { llm, ocrModel: "fake" });
    expect(seen).toEqual(["data:image/png;base64,", "data:image/png;base64,"]);
    expect(ex.pages.map((p) => [p.page, p.source, p.text])).toEqual([[1, "ocr", "판독 1"], [2, "ocr", "판독 2"]]);
  });

  it("fails clearly on damaged, empty and unsupported files", async () => {
    await expect(extractDocument(fixture("손상된_파일.pdf"), { ocrModel: "none" })).rejects.toThrow(/PDF를 열 수 없습니다/);
    await expect(extractDocument(new Uint8Array(), { ocrModel: "none" })).rejects.toBeInstanceOf(ExtractionError);
    await expect(extractDocument(fixture("한빛기계_스캔본.pdf"), { ocrModel: "none" })).rejects.toThrow(/OCR/);
    expect(sniff(new Uint8Array([0x50, 0x4b, 3, 4]))).toBeUndefined();
    expect(sniff(new TextEncoder().encode("개업연월일"))).toBe("text");
  });
});
