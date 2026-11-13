/**
 * Validates subject inputs and defines ingested evidence.
 * Inputs preserve tags and labels so criteria can select evidence without changing source content.
 */
import { z } from "zod";

/** Viewport for `url` screenshots. Defaults: 1280×800, viewport only (about 1,000 Clef image tokens). */
export const ScreenshotOptions = z.object({
  width: z.number().int().min(320).max(2560).optional(),
  height: z.number().int().min(240).max(4096).optional(),
  fullPage: z.boolean().optional(),
  /** Wait this long after load before capturing, so entrance and count-up animations finish (default 1500). */
  settleMs: z.number().int().min(0).max(10_000).optional(),
});
export type ScreenshotOptions = z.infer<typeof ScreenshotOptions>;

/** Bytes supplied by the caller, shared by `file` and `image` inputs. */
const binarySource = {
  /** Local path (CLI / server-side) ... */
  path: z.string().optional(),
  /** ... or inline base64 content. */
  base64: z.string().optional(),
  filename: z.string().optional(),
  mimeType: z.string().optional(),
  label: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

/** Something to evaluate. Each input is ingested into one or more Evidence blocks. */
export const Input = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("json"), data: z.unknown(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("file"), ...binarySource }),
  z.object({
    type: z.literal("url"),
    url: z.string().url(),
    /** Also capture a screenshot for vision-capable decision models (needs an engine with a screenshot renderer). */
    screenshot: z.union([z.boolean(), ScreenshotOptions]).optional(),
    label: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  /** A PNG, JPEG or WebP image for vision-capable decision models. Embedded only: remote image URLs are not fetched. */
  z.object({ type: z.literal("image"), ...binarySource }),
  z.object({ type: z.literal("youtube"), url: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional(), lang: z.string().optional() }),
]);
export type Input = z.infer<typeof Input>;

export const Subject = z.object({
  id: z.string().optional(),
  /** Human-readable name for leaderboards / reports. */
  name: z.string().optional(),
  inputs: z.array(Input).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type Subject = z.infer<typeof Subject>;

/** Normalized, judge-ready representation of one input. */
export interface Evidence {
  /** Index of the originating input. */
  inputIndex: number;
  kind: Input["type"];
  label: string;
  tags: string[];
  /** Plain-text content shown to judges. */
  text: string;
  /** Structured content when the input was JSON (or JSON-like). */
  json?: unknown;
  /** Source descriptor (url, filename, ...). */
  source?: string;
  truncated?: boolean;
  /**
   * Images attached to this evidence (an `image` input or a `url` screenshot). Metadata only: the bytes stay in memory
   * for the judges (`evidenceImages`) and are never persisted with the evaluation.
   */
  images?: ImageMeta[];
  /**
   * Whole documents attached to this evidence (a PDF given as a `file` input or fetched from a `url`). Metadata only:
   * the bytes stay in memory for judges that read the file itself (`evidenceDocuments`) and are never persisted.
   */
  documents?: DocumentMeta[];
  stats: { chars: number; words: number; lines: number };
  warnings?: string[];
}

/** What is kept about an attached document; the bytes themselves are not part of the evidence. */
export interface DocumentMeta {
  mimeType: "application/pdf";
  bytes: number;
  pages?: number;
}

/** What a judge is told about an attached image; the bytes themselves are not part of the evidence. */
export interface ImageMeta {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: number;
  width?: number;
  height?: number;
}
