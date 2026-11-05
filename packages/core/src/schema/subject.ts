import { z } from "zod";

/** Something to evaluate. Each input is ingested into one or more Evidence blocks. */
export const Input = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text"), text: z.string(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({ type: z.literal("json"), data: z.unknown(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
  z.object({
    type: z.literal("file"),
    /** Local path (CLI / server-side) ... */
    path: z.string().optional(),
    /** ... or inline base64 content. */
    base64: z.string().optional(),
    filename: z.string().optional(),
    mimeType: z.string().optional(),
    label: z.string().optional(),
    tags: z.array(z.string()).optional(),
  }),
  z.object({ type: z.literal("url"), url: z.string().url(), label: z.string().optional(), tags: z.array(z.string()).optional() }),
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
  stats: { chars: number; words: number; lines: number };
  warnings?: string[];
}
