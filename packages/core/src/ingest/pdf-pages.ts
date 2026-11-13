/**
 * Turns PDF pages into pictures, for judges that take pictures and do not read PDFs.
 * The drawing needs a canvas, which is a native module and a large one, so it is optional like the screenshot
 * renderer: `@napi-rs/canvas` is used when it is installed where the engine runs, and never on Workers. Without it
 * such a judge is given the PDF's text layer alone, and the count of pages sent says so.
 */
import { asUint8Array } from "./extract.js";

/** Pictures of the given pages (1-based) of a PDF, in that order. Null when no renderer is available. */
export type PdfPageRenderer = (pdf: Uint8Array, pages: number[]) => Promise<Array<{ data: Uint8Array; mimeType: "image/png" }> | null>;

// Wide enough to read small print on an A4 page, small enough that four pages fit in one request to Clef.
const PAGE_WIDTH_PX = 1240;

/** The canvas module, or undefined when it is not installed: turning pages into pictures is optional. */
export async function loadCanvas(): Promise<unknown> {
  try {
    const { createRequire } = await import("node:module");
    return createRequire(import.meta.url)("@napi-rs/canvas") as unknown;
  } catch { return undefined; }
}

/** A renderer backed by pdf.js and a canvas, or undefined when no canvas is available. */
export async function canvasPdfPages(load: () => Promise<unknown> = loadCanvas): Promise<PdfPageRenderer | undefined> {
  const canvas = await load();
  if (!canvas) return undefined;
  const { renderPageAsImage } = await import("unpdf");
  return async (pdf, pages) => {
    const out: Array<{ data: Uint8Array; mimeType: "image/png" }> = [];
    // why: pdf.js detaches the buffer it is given, so every page is drawn from a copy of its own.
    for (const page of pages) out.push({ data: new Uint8Array(await renderPageAsImage(asUint8Array(pdf), page, { canvasImport: async () => canvas as never, width: PAGE_WIDTH_PX })), mimeType: "image/png" });
    return out;
  };
}

/** Resolves the canvas on first use; later calls reuse the result. Returns null where no canvas is installed. */
export function lazyCanvasPdfPages(load: () => Promise<unknown> = loadCanvas): PdfPageRenderer {
  let renderer: Promise<PdfPageRenderer | undefined> | undefined;
  return async (pdf, pages) => {
    const r = await (renderer ??= canvasPdfPages(load));
    return r ? r(pdf, pages) : null;
  };
}
