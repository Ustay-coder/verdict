/**
 * Describes judge diagnostics stored alongside ratings without changing their JSON shape.
 * judgeType on the owning rating identifies the payload; provider envelopes stay untrusted until validated.
 */
import type { Rating } from "./evaluation.js";
import type { Level, SystemOneAnswer, SystemOneQuestion } from "../judges/decision.js";

export interface DecisionRaw {
  provider?: string;
  /** Best-known model: the resolved id when the provider named one, else the requested name. */
  model?: string;
  /** What the request asked for (may be an alias such as `jev-latest`). */
  requestedModel?: string;
  /** Model id the provider's response named; absent when it did not say. */
  resolvedModel?: string;
  /** True only when `resolvedModel` came from the provider response. */
  modelVerified?: boolean;
  /** P(true) cut used to map a noul answer onto the two labels, and whether the rubric set it or the default applied. */
  threshold?: number; thresholdSource?: "rubric" | "default";
  question?: SystemOneQuestion; answer?: SystemOneAnswer;
  levels?: Level[]; latencyMs?: number; lowConfidence?: boolean; stateChars?: number; stateTruncated?: boolean;
  /** Images in the evidence vs. images the provider received. */
  images?: { attached: number; sent: number };
  /** Documents (PDFs) in the evidence vs. documents the provider received as files. */
  documents?: { attached: number; sent: number };
  /** Pages of the evidence's PDFs vs. pages the provider received as pictures. */
  pages?: { attached: number; sent: number };
}
export interface LlmRaw {
  provider: string; model?: string; samples?: number[]; agreement?: number; latencyMs: number;
}
export interface HumanRaw { instructions?: string; allowedRaters?: string[]; escalatedFrom?: Rating }
/** One regex match located in the evidence; text fields are truncated so ratings stay small. */
export interface RegexMatch {
  /** The matched text (at most 80 characters). */
  match: string;
  /** The match with up to 40 characters either side, whitespace collapsed. */
  snippet: string;
  /** Label of the input it came from, its tags, and its index among the subject's inputs. */
  input: string; tags: string[]; inputIndex: number;
  /** 1-based line within that input. */
  line: number;
}
export interface BenchmarkRaw {
  /** regex: the first 5 matches (present only when something matched). */
  matches?: RegexMatch[];
  count?: number; hits?: string[]; total?: number; value?: unknown; scope?: Record<string, number>;
  similarity?: number; score?: number; normalized?: number; rationale?: string;
}
export interface PanelRaw { members: Rating[]; combine?: string }
export interface RatingRawByJudge {
  decision: DecisionRaw; llm: LlmRaw; human: HumanRaw; benchmark: BenchmarkRaw; panel: PanelRaw;
}
