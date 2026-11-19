import { describe, expect, it } from "vitest";
import { CompileError, logicFormula, validateCompiled } from "../src/compile.js";
import { comparatorFromText, findQuotePage, parseAmounts, parseDates, subtractPeriod, unitMultiplier } from "../src/text.js";
import { rawReq } from "./helpers.js";

describe("text parsing", () => {
  it("reads Korean amounts and compounds", () => {
    expect(parseAmounts("2025년 매출 1억 원 이상")).toContain(100_000_000);
    expect(parseAmounts("매출액 1억 2,000만원")).toContain(120_000_000);
    expect(parseAmounts("5천만원")).toContain(50_000_000);
    expect(parseAmounts("120백만원")).toContain(120_000_000);
    expect(parseAmounts("1.5억")).toContain(150_000_000);
    expect(parseAmounts("매출액 120,000,000원")).toContain(120_000_000);
    expect(unitMultiplier("(단위: 천원)")).toBe(1000);
  });
  it("reads dates in common Korean formats and rejects impossible ones", () => {
    expect(parseDates("개업연월일 : 2019 년 03 월 02 일")).toEqual([20190302]);
    expect(parseDates("2019.3.2. 설립")).toEqual([20190302]);
    expect(parseDates("2019-02-30")).toEqual([]);
  });
  it("subtracts calendar periods with month-end clamping", () => {
    expect(subtractPeriod("2025-12-31", { years: 3, months: 0, days: 0 })).toBe("2022-12-31");
    expect(subtractPeriod("2024-02-29", { years: 1, months: 0, days: 0 })).toBe("2023-02-28");
    expect(subtractPeriod("2025-03-31", { years: 0, months: 1, days: 0 })).toBe("2025-02-28");
  });
  it("takes the comparison direction from the wording", () => {
    expect(comparatorFromText("매출 1억 원 이상")).toBe(">=");
    expect(comparatorFromText("상시근로자 10명 미만")).toBe("<");
    expect(comparatorFromText("자본금 5억 초과")).toBe(">");
  });
  it("finds quotes despite whitespace differences and corrects the page", () => {
    const pages = [{ page: 1, text: "상호 : 주식회사 가나" }, { page: 2, text: "본점 소재지\n울산광역시  남구" }];
    expect(findQuotePage("본점 소재지 울산광역시 남구", pages, 1)).toBe(2);
    expect(findQuotePage("부산광역시", pages)).toBeUndefined();
  });
});

const SRC = "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";

describe("requirement compiler validation", () => {
  it("keeps a stated reference date and computes the cutoff in code", () => {
    const c = validateCompiled(SRC, {
      requirements: [
        rawReq({ id: "a", text: "창업 3년 이상", kind: "elapsed", subject: "창업일", comparator: ">=", years: 3, referenceDate: "2025-12-31" }),
        rawReq({ id: "b", text: "울산 소재 기업", kind: "text", subject: "본점 소재지" }),
        rawReq({ id: "c", text: "2025년 매출 1억 원 이상", kind: "number", subject: "2025년 매출액", comparator: ">=", threshold: 100_000_000, unit: "원" }),
      ],
      logic: "a AND b AND c",
    }, "m");
    const [a, b, c2] = c.requirements;
    expect(a).toMatchObject({ id: "r1", referenceDate: "2025-12-31", cutoff: 20221231, valueComparator: "<=", unresolved: [] });
    expect(b!.kind).toBe("text");
    expect(c2).toMatchObject({ threshold: 100_000_000, valueComparator: ">=", unresolved: [] });
    expect(logicFormula(c.logic)).toBe("min(r1, r2, r3)");
  });

  it("never fills in a reference date the requirement does not state", () => {
    const c = validateCompiled("창업 3년 이상", { requirements: [rawReq({ id: "a", text: "창업 3년 이상", kind: "elapsed", comparator: ">=", years: 3, referenceDate: "2026-11-18" })], logic: "a" }, "m");
    expect(c.requirements[0]!.referenceDate).toBeNull();
    expect(c.requirements[0]!.cutoff).toBeUndefined();
    expect(c.requirements[0]!.unresolved.join()).toMatch(/기준일/);
  });

  it("overrides the model's comparator with the wording and flags thresholds not in the text", () => {
    const c = validateCompiled("매출 1억 원 초과", { requirements: [rawReq({ id: "a", text: "매출 1억 원 초과", kind: "number", comparator: ">=", threshold: 200_000_000 })], logic: "a" }, "m");
    expect(c.requirements[0]!.comparator).toBe(">");
    expect(c.requirements[0]!.unresolved.join()).toMatch(/기준 값/);
  });

  it("derives year-only date boundaries from the direction", () => {
    const c = validateCompiled("2020년 이후 설립", { requirements: [rawReq({ id: "a", text: "2020년 이후 설립", kind: "date", comparator: ">=", thresholdDate: "2020-06-01" })], logic: "a" }, "m");
    expect(c.requirements[0]).toMatchObject({ cutoff: 20200101, valueComparator: ">=" });
  });

  it("preserves OR and exclusion logic as Kleene formulas", () => {
    const src = "울산 소재 또는 부산 소재\n휴업 중인 기업 제외";
    const c = validateCompiled(src, {
      requirements: [rawReq({ id: "x", text: "울산 소재" }), rawReq({ id: "y", text: "부산 소재" }), rawReq({ id: "z", text: "휴업 중인 기업" })],
      logic: "(x OR y) AND NOT z",
    }, "m");
    expect(logicFormula(c.logic)).toBe("min(max(r1, r2), (2 - r3))");
  });

  it("rejects spans that are not in the input and unknown logic ids", () => {
    expect(() => validateCompiled("울산 소재", { requirements: [rawReq({ id: "a", text: "부산 소재" })], logic: "a" }, "m")).toThrow(CompileError);
    expect(() => validateCompiled("울산 소재", { requirements: [rawReq({ id: "a", text: "울산 소재" })], logic: "a OR b" }, "m")).toThrow(CompileError);
  });
});
