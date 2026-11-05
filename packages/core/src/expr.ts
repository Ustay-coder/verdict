/**
 * Tiny, safe expression evaluator for custom aggregation formulas and benchmark rules.
 * No `eval`. Supports: numbers, identifiers, + - * / % ^, unary -, comparisons,
 * `and` / `or` / `not` (also && || !), ternary `a ? b : c`, parentheses, function calls.
 */

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

const OPS = ["<=", ">=", "==", "!=", "&&", "||", "+", "-", "*", "/", "%", "^", "<", ">", "!"];

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]*\.?[0-9]+(e[+-]?[0-9]+)?|^[0-9]+\.?/i.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[a-zA-Z_]/.test(ch)) {
      const m = /^[a-zA-Z_][a-zA-Z0-9_.]*/.exec(src.slice(i))!;
      const w = m[0];
      if (w === "and") out.push({ t: "op", v: "&&" });
      else if (w === "or") out.push({ t: "op", v: "||" });
      else if (w === "not") out.push({ t: "op", v: "!" });
      else out.push({ t: "id", v: w });
      i += w.length; continue;
    }
    if (ch === "(") { out.push({ t: "lp" }); i++; continue; }
    if (ch === ")") { out.push({ t: "rp" }); i++; continue; }
    if (ch === ",") { out.push({ t: "comma" }); i++; continue; }
    if (ch === "?") { out.push({ t: "q" }); i++; continue; }
    if (ch === ":") { out.push({ t: "colon" }); i++; continue; }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (op) { out.push({ t: "op", v: op }); i += op.length; continue; }
    throw new Error(`unexpected character '${ch}' at ${i}`);
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
  constructor(private toks: Tok[], private scope: ExprScope, private fns: Record<string, ExprFn>) {}
  private peek() { return this.toks[this.pos]!; }
  private next() { return this.toks[this.pos++]!; }
  private expectOp(v: string) { const t = this.next(); if (t.t !== "op" || t.v !== v) throw new Error(`expected ${v}`); }

  parse(): number {
    const v = this.ternary();
    if (this.peek().t !== "end") throw new Error("unexpected trailing tokens");
    return v;
  }
  private ternary(): number {
    const c = this.or();
    if (this.peek().t === "q") { this.next(); const a = this.ternary(); if (this.next().t !== "colon") throw new Error("expected ':'"); const b = this.ternary(); return c ? a : b; }
    return c;
  }
  private or(): number { let l = this.and(); while (this.isOp("||")) { this.next(); const r = this.and(); l = l || r ? 1 : 0; } return l; }
  private and(): number { let l = this.cmp(); while (this.isOp("&&")) { this.next(); const r = this.cmp(); l = l && r ? 1 : 0; } return l; }
  private cmp(): number {
    let l = this.add();
    for (;;) {
      const t = this.peek();
      if (t.t !== "op" || !["<", ">", "<=", ">=", "==", "!="].includes(t.v)) return l;
      this.next(); const r = this.add();
      l = ({ "<": l < r, ">": l > r, "<=": l <= r, ">=": l >= r, "==": l === r, "!=": l !== r } as Record<string, boolean>)[t.v]! ? 1 : 0;
    }
  }
  private add(): number { let l = this.mul(); for (;;) { if (this.isOp("+")) { this.next(); l += this.mul(); } else if (this.isOp("-")) { this.next(); l -= this.mul(); } else return l; } }
  private mul(): number {
    let l = this.pow();
    for (;;) {
      if (this.isOp("*")) { this.next(); l *= this.pow(); }
      else if (this.isOp("/")) { this.next(); const r = this.pow(); l = r === 0 ? 0 : l / r; }
      else if (this.isOp("%")) { this.next(); const r = this.pow(); l = r === 0 ? 0 : l % r; }
      else return l;
    }
  }
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
    if (t.t === "lp") { const v = this.ternary(); if (this.next().t !== "rp") throw new Error("expected ')'"); return v; }
    if (t.t === "id") {
      if (this.peek().t === "lp") {
        this.next();
        const args: number[] = [];
        if (this.peek().t !== "rp") { for (;;) { args.push(this.ternary()); if (this.peek().t === "comma") { this.next(); continue; } break; } }
        if (this.next().t !== "rp") throw new Error("expected ')'");
        const fn = this.fns[t.v];
        if (!fn) throw new Error(`unknown function: ${t.v}`);
        return Number(fn(...args));
      }
      if (t.v === "true") return 1;
      if (t.v === "false") return 0;
      const v = this.scope[t.v];
      if (v === undefined) throw new Error(`unknown variable: ${t.v}`);
      return Number(v);
    }
    throw new Error("unexpected token");
  }
  private isOp(v: string) { const t = this.peek(); return t.t === "op" && t.v === v; }
}

export function evaluateExpression(src: string, scope: ExprScope = {}, fns: Record<string, ExprFn> = DEFAULT_FUNCTIONS): number {
  const v = new Parser(tokenize(src), scope, fns).parse();
  if (!Number.isFinite(v)) throw new Error(`expression did not produce a finite number: ${src}`);
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
