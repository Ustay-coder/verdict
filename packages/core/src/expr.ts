/**
 * Parses and evaluates a bounded arithmetic expression language.
 * Rubric formulas never execute JavaScript; only explicitly supplied variables and functions are callable.
 */
/**
 * Tiny, safe expression evaluator for custom aggregation formulas and benchmark rules.
 * No `eval`. Supports: numbers, identifiers, + - * / % ^, unary -, comparisons,
 * `and` / `or` / `not` (also && || !), ternary `a ? b : c`, parentheses, function calls.
 */

import { ValidationError } from "./engine/errors.js";

type Tok =
  | { t: "num"; v: number }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "comma" }
  | { t: "q" }
  | { t: "colon" }
  | { t: "end" };

const keywords: Record<string, string> = { and: "&&", or: "||", not: "!" };
const tokenRules: Array<{ pattern: RegExp; token: (value: string) => Tok | undefined }> = [
  { pattern: /^\s+/, token: () => undefined },
  { pattern: /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?|^[0-9]+\.?/i, token: v => ({ t: "num", v: Number(v) }) },
  { pattern: /^[a-zA-Z_][a-zA-Z0-9_.]*/, token: v => keywords[v] ? { t: "op", v: keywords[v]! } : { t: "id", v } },
  { pattern: /^\(/, token: () => ({ t: "lp" }) },
  { pattern: /^\)/, token: () => ({ t: "rp" }) },
  { pattern: /^,/, token: () => ({ t: "comma" }) },
  { pattern: /^\?/, token: () => ({ t: "q" }) },
  { pattern: /^:/, token: () => ({ t: "colon" }) },
  { pattern: /^(<=|>=|==|!=|&&|\|\||[+*/%\^<>!\-])/, token: v => ({ t: "op", v }) },
];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const rule = tokenRules.find(rule => rule.pattern.test(rest));
    if (!rule) throw new ValidationError(`unexpected character '${src[i]}' at ${i}`);
    const value = rule.pattern.exec(rest)![0];
    const token = rule.token(value);
    if (token) out.push(token);
    i += value.length;
  }
  out.push({ t: "end" });
  return out;
}

export type ExprValue = number | boolean;
export type ExprScope = Record<string, ExprValue | undefined>;
export type ExprFn = (...args: number[]) => number;

const avg = (...a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);
export const DEFAULT_FUNCTIONS: Record<string, ExprFn> = {
  min: (...a) => Math.min(...a),
  max: (...a) => Math.max(...a),
  sum: (...a) => a.reduce((s, x) => s + x, 0),
  avg,
  mean: avg,
  abs: (x) => Math.abs(x),
  round: (x, p = 0) => { const m = 10 ** p; return Math.round(x * m) / m; },
  floor: (x) => Math.floor(x),
  ceil: (x) => Math.ceil(x),
  sqrt: (x) => Math.sqrt(x),
  log: (x) => Math.log(x),
  exp: (x) => Math.exp(x),
  pow: (x, y) => x ** y,
  clamp: (x, lo, hi) => Math.min(hi, Math.max(lo, x)),
  /** Linear rescale of x from [a,b] to [c,d]. */
  scale: (x, a, b, c, d) => (b === a ? c : c + ((x - a) * (d - c)) / (b - a)),
  /** if(cond, a, b) */
  if: (c, a, b) => (c ? a : b),
};

class Parser {
  private pos = 0;
  constructor(private toks: Tok[], private scope: ExprScope, private fns: Record<string, ExprFn>) { }
  private peek() { return this.toks[this.pos]!; }
  private next() { return this.toks[this.pos++]!; }
  private expectOp(v: string) { const t = this.next(); if (t.t !== "op" || t.v !== v) throw new ValidationError(`expected ${v}`); }

  parse(): number {
    const v = this.ternary();
    if (this.peek().t !== "end") throw new ValidationError("unexpected trailing tokens");
    return v;
  }
  // why: both branches are parsed even when unselected so invalid syntax cannot hide behind a condition.
  private ternary(): number {
    const c = this.or();
    if (this.peek().t === "q") { this.next(); const a = this.ternary(); if (this.next().t !== "colon") throw new ValidationError("expected ':'"); const b = this.ternary(); return c ? a : b; }
    return c;
  }
  private or(): number { let l = this.and(); while (this.isOp("||")) { this.next(); const r = this.and(); l = l || r ? 1 : 0; } return l; }
  private and(): number { let l = this.cmp(); while (this.isOp("&&")) { this.next(); const r = this.cmp(); l = l && r ? 1 : 0; } return l; }
  private cmp(): number {
    let l = this.add();
    for (; ;) {
      const t = this.peek();
      if (t.t !== "op" || !["<", ">", "<=", ">=", "==", "!="].includes(t.v)) return l;
      this.next(); const r = this.add();
      l = ({ "<": l < r, ">": l > r, "<=": l <= r, ">=": l >= r, "==": l === r, "!=": l !== r } as Record<string, boolean>)[t.v]! ? 1 : 0;
    }
  }
  private add(): number { let l = this.mul(); for (; ;) { if (this.isOp("+")) { this.next(); l += this.mul(); } else if (this.isOp("-")) { this.next(); l -= this.mul(); } else return l; } }
  // why: division and remainder by zero yield zero by formula convention, keeping missing-input arithmetic finite.
  private mul(): number {
    let l = this.pow();
    for (; ;) {
      if (this.isOp("*")) { this.next(); l *= this.pow(); }
      else if (this.isOp("/")) { this.next(); const r = this.pow(); l = r === 0 ? 0 : l / r; }
      else if (this.isOp("%")) { this.next(); const r = this.pow(); l = r === 0 ? 0 : l % r; }
      else return l;
    }
  }
  // why: recursive parsing makes exponentiation right-associative (2^3^2 = 2^(3^2)).
  private pow(): number { const b = this.unary(); if (this.isOp("^")) { this.next(); return b ** this.pow(); } return b; }
  private unary(): number {
    if (this.isOp("-")) { this.next(); return -this.unary(); }
    if (this.isOp("!")) { this.next(); return this.unary() ? 0 : 1; }
    if (this.isOp("+")) { this.next(); return this.unary(); }
    return this.primary();
  }
  private primary(): number {
    const t = this.next();
    if (t.t === "num") return t.v;
    if (t.t === "lp") return this.parseGroup();
    if (t.t === "id") return this.parseIdentifier(t.v);
    throw new ValidationError("unexpected token");
  }
  private parseGroup(): number {
    const value = this.ternary();
    if (this.next().t !== "rp") throw new ValidationError("expected ')'");
    return value;
  }
  private parseIdentifier(name: string): number {
    if (this.peek().t === "lp") return this.parseCall(name);
    if (name === "true") return 1;
    if (name === "false") return 0;
    const value = this.scope[name];
    if (value === undefined) throw new ValidationError(`unknown variable: ${name}`);
    return Number(value);
  }
  private parseCall(name: string): number {
    this.next();
    const args: number[] = [];
    if (this.peek().t !== "rp") {
      args.push(this.ternary());
      while (this.peek().t === "comma") { this.next(); args.push(this.ternary()); }
    }
    if (this.next().t !== "rp") throw new ValidationError("expected ')'");
    const fn = this.fns[name];
    if (!fn) throw new ValidationError(`unknown function: ${name}`);
    return Number(fn(...args));
  }
  private isOp(v: string) { const t = this.peek(); return t.t === "op" && t.v === v; }
}

/** Evaluates the restricted formula language; throws on invalid syntax, functions or variables. */
export function evaluateExpression(src: string, scope: ExprScope = {}, fns: Record<string, ExprFn> = DEFAULT_FUNCTIONS): number {
  const v = new Parser(tokenize(src), scope, fns).parse();
  if (!Number.isFinite(v)) throw new ValidationError(`expression did not produce a finite number: ${src}`);
  return v;
}

/** Identifiers referenced by an expression (for validation / dependency checks). */
export function expressionVariables(src: string, fns: Record<string, ExprFn> = DEFAULT_FUNCTIONS): string[] {
  const toks = tokenize(src);
  const vars = new Set<string>();
  toks.forEach((t, i) => {
    if (t.t === "id" && toks[i + 1]?.t !== "lp" && !(t.v in fns) && t.v !== "true" && t.v !== "false") vars.add(t.v);
  });
  return [...vars];
}
