/**
 * Defines System One adapter contracts; adapters are registered and looked up by name in `registry.ts`.
 * Provider names are replaceable extension points; malformed responses are rejected at the judge boundary.
 */
import { z } from "zod";
import { SystemOneAnswerSchema } from "../../provider-error.js";
import type { JudgeContext } from "../types.js";

export type SystemOneQuestion =
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
  | { type: "choice"; instructions: string; criteria: Record<string, string | null> };

export type SystemOneAnswer = z.infer<typeof SystemOneAnswerSchema>;

export interface DecisionRequest {
  model?: string;
  state: string;
  questions: Record<string, SystemOneQuestion>;
  baseUrl?: string;
  apiKey?: string;
  options?: Record<string, unknown>;
  /** Embedded images (data URIs) from the evidence; only adapters with `acceptsImages` receive them. */
  images?: string[];
  /** Whole documents (PDF data URIs) from the evidence; only adapters with `acceptsDocuments` receive them. */
  documents?: string[];
}
export interface DecisionResponse {
  answers: Record<string, SystemOneAnswer>;
  /** Best-known model: the response's model id, else the model the request asked for. Kept for compatibility. */
  model?: string;
  /** Model id the request asked for after provider defaults (an alias such as `jev-latest` stays an alias). */
  requestedModel?: string;
  /** Model id named by the provider's response body. Absent when the provider did not say which model answered. */
  resolvedModel?: string;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
  /** Images in the evidence vs. images actually sent (text-only providers drop them; Clef takes at most 4). */
  images?: { attached: number; sent: number };
  /** Documents in the evidence vs. documents sent as files (other providers are given the text layer instead). */
  documents?: { attached: number; sent: number };
  /**
   * Pages of the evidence's PDFs vs. pages sent as pictures, for a provider that takes pictures and does not read
   * PDFs. Fewer sent than there are means the document was cut at what the provider takes, or that nothing here can
   * draw a page.
   */
  pages?: { attached: number; sent: number };
}

export interface DecisionProviderAdapter {
  name: string;
  /** Vision-capable: requests may carry `images`. Text-only adapters never receive them. */
  acceptsImages?: boolean;
  /** Most images one request may carry; extra images are dropped and the drop is recorded on the rating. */
  maxImages?: number;
  /** Reads PDFs itself: requests may carry `documents`, and the state names each file instead of repeating its text. */
  acceptsDocuments?: boolean;
  decide(req: DecisionRequest, ctx: JudgeContext): Promise<DecisionResponse>;
}
