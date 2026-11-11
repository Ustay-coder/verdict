import type { Evidence, Input } from "../schema/subject.js";
import type { ScreenshotRenderer } from "./screenshot.js";

export interface IngestOptions {
  /** Max characters per evidence block (judges see at most this much). */
  maxChars?: number;
  /** Reads local bytes after allowLocalFiles authorization; rejects on I/O failure. */
  readFile?: (path: string) => Promise<Uint8Array>;
  fetch?: typeof fetch;
  /** Allow reading local file paths (disable on multi-tenant servers). */
  allowLocalFiles?: boolean;
  /** Timeout for network inputs (ms). */
  timeoutMs?: number;
  /** Pluggable YouTube transcript provider (e.g. a paid API). */
  youtubeTranscript?: (videoId: string, lang?: string) => Promise<{ text: string; title?: string } | null>;
  /** Renders `url` inputs that ask for a screenshot (e.g. `lazyPlaywrightScreenshot()` in Node). Without one they keep their text and get a warning. */
  screenshot?: ScreenshotRenderer;
}

export type Ingestor = (input: Input, index: number, opts: Required<Pick<IngestOptions, "maxChars" | "fetch" | "allowLocalFiles" | "timeoutMs">> & IngestOptions) => Promise<Evidence>;
