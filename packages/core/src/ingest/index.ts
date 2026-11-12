import type { Evidence, Input, Subject } from "../schema/subject.js";
import type { IngestOptions, Ingestor } from "./contracts.js";
import { textIngestor, jsonIngestor } from "./text.js";
import { fileIngestor } from "./file.js";
import { urlIngestor } from "./url.js";
import { youtubeIngestor } from "./youtube.js";
import { imageIngestor } from "./image.js";
export type { IngestOptions, Ingestor } from "./contracts.js";
export { stats } from "./evidence.js";
export { extractFromBuffer, htmlToPlain } from "./extract.js";
export { youtubeId, fetchYoutubeTranscript } from "./youtube.js";
export { attachImages, evidenceImages, imageInfo } from "./images.js";
export { attachPdf, evidenceDocuments } from "./documents.js";
export { playwrightScreenshot, lazyPlaywrightScreenshot, loadChromium, type BrowserLauncher, type ScreenshotRenderer } from "./screenshot.js";

// why: bound source size and network wait before judging; callers can override for known larger documents.
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_TIMEOUT_MS = 20_000;

const registry = new Map<Input["type"], Ingestor>([
  ["text", textIngestor], ["json", jsonIngestor], ["file", fileIngestor], ["url", urlIngestor], ["youtube", youtubeIngestor], ["image", imageIngestor],
]);

/** Replace or add an ingestor for an input type (e.g. route `url` through a headless browser). */
export function registerIngestor(type: Input["type"], fn: Ingestor) { registry.set(type, fn); }

/** Ingests subject inputs in order; rejects if any source cannot be read or parsed. */
export async function ingest(subject: Subject, options: IngestOptions = {}): Promise<Evidence[]> {
  const opts = { maxChars: DEFAULT_MAX_CHARS, fetch: ((input, init) => globalThis.fetch(input, init)) as typeof fetch, allowLocalFiles: false, timeoutMs: DEFAULT_TIMEOUT_MS, ...options };
  // why: Promise.all preserves input order even when remote sources finish out of order.
  return Promise.all(
    subject.inputs.map(async (input, i) => {
      const fn = registry.get(input.type);
      if (!fn) throw new Error(`no ingestor for input type ${input.type}`);
      return fn(input, i, opts);
    }),
  );
}
