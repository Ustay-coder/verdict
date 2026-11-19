/**
 * 개발용 예시 데이터(UI 시안 전용). 운영 화면은 이 파일을 import하지 않는다.
 * 판정·인용·쪽수는 화면 확인을 위해 미리 정해 둔 가짜 값이며 실제 검토 결과가 아니다.
 */
import type { Outcome } from "@/lib/types";

export const SAMPLE_REQUIREMENT = "2025년 12월 31일 기준 창업 3년 이상\n울산 소재 기업\n2025년 매출 1억 원 이상";
export const SAMPLE_REQUIREMENTS = [
  { id: "r1", text: "2025년 12월 31일 기준 창업 3년 이상" },
  { id: "r2", text: "울산 소재 기업" },
  { id: "r3", text: "2025년 매출 1억 원 이상" },
];

const COMPANIES = ["가온테크", "바다물산", "누리솔루션", "한빛기계", "다솜", "서울상사", "이음바이오", "새봄푸드", "온누리에너지", "하늘정밀", "미래로", "푸른나래", "별빛소재", "단비로보틱스", "초록공방", "든든물류"];
export function sampleFileNames(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `${COMPANIES[i % COMPANIES.length]}${i >= COMPANIES.length ? `_${Math.floor(i / COMPANIES.length) + 1}` : ""}_신청서류.pdf`);
}

/** 예시 판정 패턴: 파일 순서로 정해진다(가짜). */
export function sampleOutcomes(i: number): Record<string, Outcome> {
  const patterns: Array<Record<string, Outcome>> = [
    { r1: "met", r2: "met", r3: "met" },
    { r1: "not_met", r2: "not_met", r3: "not_met" },
    { r1: "met", r2: "met", r3: "needs_review" },
    { r1: "met", r2: "met", r3: "met" },
    { r1: "needs_review", r2: "met", r3: "met" },
    { r1: "met", r2: "not_met", r3: "met" },
  ];
  return patterns[i % patterns.length]!;
}

export const SAMPLE_FACT: Record<string, { label: string; value: string; quote: string; page: number }> = {
  r1: { label: "개업연월일", value: "2019-03-02", quote: "개업연월일 2019 년 03 월 02 일", page: 1 },
  r2: { label: "사업장 소재지", value: "울산광역시 남구 삼산로 100", quote: "사업장 소재지 울산광역시 남구 삼산로 100, 5층", page: 1 },
  r3: { label: "2025년 매출액", value: "1250000000", quote: "Ⅰ. 매출액 1,250,000,000원", page: 2 },
};
