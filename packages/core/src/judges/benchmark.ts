/**
 * Scores deterministic evidence features with optional injected HTTP scoring.
 * Scores are clamped to normalized units; invalid methods or inputs become error ratings.
 */
import { z } from "zod";
import { parseProvider, readProviderJson } from "../provider-error.js";
import type { BenchmarkRaw, RegexMatch } from "../schema/rating-raw.js";
import { clamp, denormalizeScore } from "../aggregate/index.js";
import { evaluateExpression } from "../expr.js";
import type { Rating } from "../schema/evaluation.js";
import type { BenchmarkMethod } from "../schema/rubric.js";
import { type Judge, type JudgeContext, ratingBase, renderEvidence } from "./types.js";

/** Deterministic, reproducible scoring: regex / keywords / length / JSON fields / formulas / similarity / external HTTP scorer. */
export class BenchmarkJudge implements Judge {
  readonly type = "benchmark" as const;
  readonly id: string;
  constructor(private spec: BenchmarkMethod & { id?: string }) {
    this.id = spec.id ?? `benchmark:${spec.method}`;
  }
  expectedRatings() { return 1; }

  async rate(ctx: JudgeContext): Promise<Rating[]> {
    const base = ratingBase(ctx, this);
    try {
      if (ctx.criterion.choices) throw new Error("benchmark judges cannot answer choice criteria");
      const { normalized, rationale, raw } = await this.compute(ctx);
      const n = clamp(normalized, 0, 1);
      return [{ ...base, status: "scored", normalized: n, score: denormalizeScore(n, ctx.scale), confidence: 1, rationale, raw }];
    } catch (e) {
      return [{ ...base, status: "error", error: (e as Error).message }];
    }
  }

  private async compute(ctx: JudgeContext): Promise<{ normalized: number; rationale: string; raw?: BenchmarkRaw }> {
    return computeMethod(this.spec, ctx);
  }
}

type Result = { normalized: number; rationale: string; raw?: BenchmarkRaw };
const methods = { regex, keywords, length, jsonpath, formula, similarity, http };

async function regex(s: Extract<BenchmarkMethod, { method: "regex" }>, ctx: JudgeContext): Promise<Result> {
  const text = ctx.evidence.map(e => e.text).join("\n\n");
  const re = new RegExp(s.pattern, (s.flags ?? "") + (s.perMatch ? "g" : ""));
  const count = s.perMatch ? (text.match(re) ?? []).length : re.test(text) ? 1 : 0;
  let n = s.perMatch ? Math.min(1, count * s.perMatch) : count;
  if (s.negate) n = 1 - n;
  // why: a bare count tells the reader nothing to fix; the first few matches say what matched and in which input.
  const matches = count ? findRegexMatches(ctx.evidence, s.pattern, s.flags ?? "") : [];
  const first = matches[0];
  const where = first ? `; first: ${JSON.stringify(first.match)} in ${first.input} line ${first.line}` : "";
  return { normalized: n, rationale: `regex /${s.pattern}/ matched ${count} time(s)${s.negate ? " (negated)" : ""}${where}`, raw: matches.length ? { count, matches } : { count } };

}

const MAX_REGEX_MATCHES = 5, MAX_MATCH_CHARS = 80, SNIPPET_CONTEXT = 40;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First matches of `pattern` over the same joined text the score uses, each located back to its evidence item. */
function findRegexMatches(evidence: JudgeContext["evidence"], pattern: string, flags: string): RegexMatch[] {
  const sep = "\n\n";
  const starts: number[] = [];
  let offset = 0;
  for (const e of evidence) { starts.push(offset); offset += e.text.length + sep.length; }
  const text = evidence.map(e => e.text).join(sep);
  const re = new RegExp(pattern, flags.includes("g") ? flags : flags + "g");
  const out: RegexMatch[] = [];
  for (const m of text.matchAll(re)) {
    if (out.length >= MAX_REGEX_MATCHES) break;
    const at = m.index ?? 0;
    let i = starts.length - 1;
    while (i > 0 && starts[i]! > at) i--;
    const ev = evidence[i];
    if (!ev) break;
    const local = at - starts[i]!;
    const end = local + m[0].length;
    const from = Math.max(0, local - SNIPPET_CONTEXT), to = Math.min(ev.text.length, end + SNIPPET_CONTEXT);
    const match = cut(m[0], MAX_MATCH_CHARS);
    // why: the snippet is built around the truncated match, so it stays under ~162 characters however long the match is.
    const snippet = ((from > 0 ? "…" : "") + ev.text.slice(from, local) + match + ev.text.slice(end, to) + (to < ev.text.length ? "…" : "")).replace(/\s+/g, " ");
    out.push({
      match, snippet,
      input: ev.label, tags: ev.tags, inputIndex: ev.inputIndex,
      line: ev.text.slice(0, local).split("\n").length,
    });
  }
  return out;
}

async function keywords(s: Extract<BenchmarkMethod, { method: "keywords" }>, ctx: JudgeContext): Promise<Result> {
  const text = ctx.evidence.map(e => e.text).join("\n\n");
  const hay = s.caseSensitive ? text : text.toLowerCase();
  const hits = s.keywords.filter((k) => hay.includes(s.caseSensitive ? k : k.toLowerCase()));
  const ratio = hits.length / s.keywords.length;
  const n = s.mode === "all" ? (hits.length === s.keywords.length ? 1 : 0) : s.mode === "any" ? (hits.length ? 1 : 0) : ratio;
  return { normalized: n, rationale: `${hits.length}/${s.keywords.length} keywords present: ${hits.join(", ") || "none"}`, raw: { hits } };

}

async function length(s: Extract<BenchmarkMethod, { method: "length" }>, ctx: JudgeContext): Promise<Result> {
  const total = ctx.evidence.reduce((acc, e) => acc + e.stats[s.unit], 0);
  const lo = s.min ?? -Infinity, hi = s.max ?? Infinity;
  if (total >= lo && total <= hi) return { normalized: 1, rationale: `${total} ${s.unit} within [${s.min ?? "-"}, ${s.max ?? "-"}]`, raw: { total } };
  // why: tolerance decays outside the accepted range; a single bound supplies the span when the other is unbounded.
  const span = Number.isFinite(lo) && Number.isFinite(hi) ? hi - lo : Number.isFinite(lo) ? lo : hi;
  const dist = total < lo ? lo - total : total - hi;
  const n = span > 0 && s.tolerance > 0 ? Math.max(0, 1 - dist / (span * s.tolerance)) : 0;
  return { normalized: n, rationale: `${total} ${s.unit} is ${dist} outside [${s.min ?? "-"}, ${s.max ?? "-"}]`, raw: { total } };

}

async function jsonpath(s: Extract<BenchmarkMethod, { method: "jsonpath" }>, ctx: JudgeContext): Promise<Result> {
  const ev = s.input ? ctx.evidence.find((e) => e.label === s.input || e.tags.includes(s.input!)) : ctx.evidence.find((e) => e.json !== undefined);
  if (!ev || ev.json === undefined) throw new Error("no JSON input available for jsonpath");
  const v = getPath(ev.json, s.path);
  if (v === undefined) throw new Error(`path ${s.path} not found`);
  let n: number;
  if (s.map && String(v) in s.map) n = s.map[String(v)]!;
  else if (typeof v === "boolean") n = v ? 1 : 0;
  else if (typeof v === "number") n = s.range ? (v - s.range[0]) / (s.range[1] - s.range[0] || 1) : v;
  else throw new Error(`cannot score value ${JSON.stringify(v)} at ${s.path}`);
  return { normalized: n, rationale: `${s.path} = ${JSON.stringify(v)}`, raw: { value: v } };

}

async function formula(s: Extract<BenchmarkMethod, { method: "formula" }>, ctx: JudgeContext): Promise<Result> {
  const scope: Record<string, number> = { inputs: ctx.evidence.length, words: 0, chars: 0, lines: 0 };
  for (const e of ctx.evidence) { scope.words! += e.stats.words; scope.chars! += e.stats.chars; scope.lines! += e.stats.lines; }
  for (const e of ctx.evidence) if (e.json && typeof e.json === "object") flattenNumbers(e.json as Record<string, unknown>, "", scope);
  const n = evaluateExpression(s.expression, scope);
  return { normalized: n, rationale: `formula "${s.expression}" = ${n}`, raw: { scope } };

}

async function similarity(s: Extract<BenchmarkMethod, { method: "similarity" }>, ctx: JudgeContext): Promise<Result> {
  const text = ctx.evidence.map(e => e.text).join("\n\n");
  const sim = cosineSimilarity(tokens(text), tokens(s.reference));
  const n = s.threshold !== undefined ? (sim >= s.threshold ? 1 : 0) : sim;
  return { normalized: n, rationale: `cosine similarity to reference = ${sim.toFixed(3)}`, raw: { similarity: sim } };

}

async function http(s: Extract<BenchmarkMethod, { method: "http" }>, ctx: JudgeContext): Promise<Result> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(s.headers ?? {}) };
  const key = s.apiKeyEnv ? ctx.env(s.apiKeyEnv) : undefined;
  // why: credentials come only from the named environment variable, never from rubric literals.
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await ctx.fetch(s.url, {
    method: "POST", headers, signal: ctx.signal,
    body: JSON.stringify({ criterion: ctx.criterion, scale: ctx.scale, evidence: ctx.evidence, text: renderEvidence(ctx.evidence) }),
  });
  if (!res.ok) throw new Error(`scorer ${s.url} -> HTTP ${res.status}`);
  const body = parseProvider("benchmark", z.object({ score: z.number().optional(), normalized: z.number().optional(), rationale: z.string().optional() }), await readProviderJson("benchmark", res));
  const n = typeof body.normalized === "number" ? body.normalized : typeof body.score === "number" ? body.score : NaN;
  if (!Number.isFinite(n)) throw new Error("scorer response must include numeric `normalized` (0..1) or `score`");
  return { normalized: n, rationale: body.rationale ?? `external scorer ${s.url}`, raw: body };

}

/** Traverses a dotted object path; returns undefined when a segment is absent or not an object. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").filter(Boolean).reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function flattenNumbers(obj: Record<string, unknown>, prefix: string, out: Record<string, number>) {
  for (const [k, v] of Object.entries(obj)) {
    const key = (prefix ? `${prefix}.${k}` : k).replace(/[^a-zA-Z0-9_.]/g, "_");
    if (typeof v === "number") out[key] = v;
    else if (typeof v === "boolean") out[key] = v ? 1 : 0;
    else if (v && typeof v === "object" && !Array.isArray(v)) flattenNumbers(v as Record<string, unknown>, key, out);
    // why: arrays expose length rather than unbounded index variables in the formula scope.
    else if (Array.isArray(v)) out[`${key}.length`] = v.length;
  }
}

/** Returns case-folded Unicode token counts; text without tokens yields an empty map. */
export function tokens(s: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}
/** Returns token-vector cosine similarity; either empty vector produces zero. */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>) {
  let dot = 0, na = 0, nb = 0;
  for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) dot += v * w; }
  for (const v of b.values()) nb += v * v;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function computeMethod<M extends BenchmarkMethod["method"]>(spec: Extract<BenchmarkMethod, { method: M }>, ctx: JudgeContext): Promise<Result> {
  const method = methods[spec.method] as (s: typeof spec, c: JudgeContext) => Promise<Result>;
  return method(spec, ctx);
}
