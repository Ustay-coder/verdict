/**
 * Defines the structured judgement contract shared by generative providers.
 * The zod shape and provider JSON schema describe the same score, confidence and evidence fields.
 */
import { z } from "zod";
import type { LlmJudgeSpec as LlmSpec } from "../../schema/rubric.js";
import { type JudgeContext } from "../types.js";

export type Spec = z.infer<typeof LlmSpec>;

/** What every LLM judge must return. Shared across providers as a JSON schema. */
export const JudgementSchema = z.object({
  choice: z.string().optional(),
  score: z.number().default(0).describe("The score on the criterion's scale, exactly as instructed"),
  confidence: z.number().min(0).max(1).describe("How confident you are in this score, 0..1"),
  rationale: z.string().describe("2-5 sentences explaining the score against the anchors"),
  quotes: z.array(z.string()).describe("Short verbatim quotes from the inputs that support the score (max 5)"),
});
export type Judgement = z.infer<typeof JudgementSchema>;

export const JUDGEMENT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["score", "confidence", "rationale", "quotes"],
  properties: {
    score: { type: "number" },
    choice: { type: "string" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    rationale: { type: "string" },
    quotes: { type: "array", items: { type: "string" } },
  },
} as const;

export interface LlmRequest {
  system: string;
  user: string;
  model?: string;
  effort?: Spec["effort"];
  maxTokens: number;
  options?: Record<string, unknown>;
  baseUrl?: string;
  apiKey?: string;
}
export interface LlmResponse {
  judgement: Judgement;
  usage?: { inputTokens: number; outputTokens: number };
  raw?: unknown;
  model?: string;
}

/** Generative providers share the same structured judgement contract. */
export interface LlmProviderAdapter {
  name: string;
  complete(req: LlmRequest, ctx: JudgeContext): Promise<LlmResponse>;
}

