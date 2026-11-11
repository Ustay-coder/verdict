import { describe, expect, it } from "vitest";
import { ValidationError } from "../src/engine/errors.js";
import { evaluateExpression, expressionVariables } from "../src/expr.js";

describe("expression evaluator", () => {
  it("does arithmetic with precedence", () => {
    expect(evaluateExpression("1 + 2 * 3")).toBe(7);
    expect(evaluateExpression("(1 + 2) * 3")).toBe(9);
    expect(evaluateExpression("2 ^ 3 ^ 2")).toBe(512);
    expect(evaluateExpression("-4 + 10 % 3")).toBe(-3);
  });
  it("resolves variables and functions", () => {
    expect(evaluateExpression("0.6 * a_n + 0.4 * b_n", { a_n: 1, b_n: 0.5 })).toBeCloseTo(0.8);
    expect(evaluateExpression("min(a, b, 3)", { a: 5, b: 4 })).toBe(3);
    expect(evaluateExpression("clamp(x, 0, 1)", { x: 7 })).toBe(1);
    expect(evaluateExpression("scale(5, 0, 10, 0, 100)")).toBe(50);
  });
  it("supports comparisons, logic and ternaries", () => {
    expect(evaluateExpression("a > 3 and b < 2 ? 1 : 0", { a: 4, b: 1 })).toBe(1);
    expect(evaluateExpression("not (a == 4) || b >= 2", { a: 4, b: 1 })).toBe(0);
    expect(evaluateExpression("if(a >= 0.5, a, 0)", { a: 0.7 })).toBe(0.7);
  });
  it("rejects unknown identifiers and bad syntax", () => {
    expect(() => evaluateExpression("foo + 1")).toThrow(/unknown variable/);
    expect(() => evaluateExpression("1 +")).toThrow(ValidationError);
    expect(() => evaluateExpression("process.exit(1)")).toThrow();
  });
  it("lists variables", () => {
    expect(expressionVariables("min(a_n, b_n) * 0.5 + c").sort()).toEqual(["a_n", "b_n", "c"]);
  });
});
