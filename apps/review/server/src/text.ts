/**
 * 원문 대조와 값 파싱. 판정에 쓰이는 숫자·날짜는 여기서 원문으로부터 다시 읽어 검증한다.
 * LLM이 제시한 값은 이 함수들이 원문에서 같은 값을 찾았을 때만 채택된다.
 */

/** 비교용 정규화: 유니코드 호환 문자 통일, 모든 공백 제거(PDF 추출이 넣는 줄바꿈·공백 차이를 무시). */
export function squash(s: string): string {
  return s.normalize("NFKC").replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐-―]/g, "-").replace(/\s+/g, "");
}

/** 인용문이 실제로 나타나는 페이지 번호(1부터). 없으면 undefined. 제시된 페이지를 먼저 확인한다. */
export function findQuotePage(quote: string, pages: Array<{ page: number; text: string }>, hint?: number): number | undefined {
  const q = squash(quote);
  if (q.length < 2) return undefined;
  const ordered = hint === undefined ? pages : [...pages.filter((p) => p.page === hint), ...pages.filter((p) => p.page !== hint)];
  return ordered.find((p) => squash(p.text).includes(q))?.page;
}

const BIG_UNITS: Record<string, number> = { 조: 1e12, 억: 1e8, 만: 1e4 };
const SMALL_UNITS: Record<string, number> = { 천: 1e3, 백: 1e2, 십: 10 };

interface Section { start: number; end: number; value: number; big?: number }

/** 정확한 정수 연산을 위해 소수 곱셈을 반올림한다(1.5억 → 150000000). */
function mul(a: number, b: number) { return Math.round(a * b * 1e6) / 1e6; }

/**
 * 문장 안의 금액·수량 후보. "1억 2,000만원"처럼 이어진 단위는 합친 값과 각 부분 값을 모두 돌려준다.
 * 예: "5천만원" → 50000000, "120백만원" → 120000000, "1.5억" → 150000000, "120,000,000원" → 120000000.
 */
export function parseAmounts(text: string): number[] {
  const src = text.normalize("NFKC");
  const re = /(\d[\d,]*(?:\.\d+)?)\s*(천|백|십)?\s*(조|억|만)?/g;
  const sections: Section[] = [];
  for (const m of src.matchAll(re)) {
    const digits = m[1]!.replace(/,/g, "");
    if (!/^\d+(\.\d+)?$/.test(digits)) continue;
    let v = Number(digits);
    if (m[2]) v = mul(v, SMALL_UNITS[m[2]]!);
    const big = m[3] ? BIG_UNITS[m[3]] : undefined;
    if (big) v = mul(v, big);
    sections.push({ start: m.index!, end: m.index! + m[0].length, value: v, big });
  }
  const out = new Set<number>(sections.map((s) => s.value));
  // 이어진 구간 합치기: 앞 구간에 큰 단위가 있고, 사이가 공백뿐이며, 뒤 구간 단위가 더 작을 때.
  for (let i = 0; i < sections.length; i++) {
    let sum = sections[i]!.value;
    let lastBig = sections[i]!.big;
    for (let j = i + 1; j < sections.length && lastBig; j++) {
      const gap = src.slice(sections[j - 1]!.end, sections[j]!.start);
      const next = sections[j]!;
      if (gap.trim() !== "" || (next.big ?? 1) >= lastBig) break;
      sum += next.value;
      out.add(sum);
      lastBig = next.big;
    }
  }
  return [...out];
}

/** "단위: 천원" 같은 표기에서 배수. 알 수 없으면 undefined. */
export function unitMultiplier(text: string): number | undefined {
  const s = squash(text);
  if (/백만원/.test(s)) return 1e6;
  if (/천만원/.test(s)) return 1e7;
  if (/억원/.test(s)) return 1e8;
  if (/천원/.test(s)) return 1e3;
  if (/만원/.test(s)) return 1e4;
  if (/원/.test(s)) return 1;
  return undefined;
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** 날짜를 YYYYMMDD 정수로. 형식: 2019-03-02, 2019.03.02, 2019. 3. 2., 2019/3/2, 2019년 3월 2일. */
export function parseDates(text: string): number[] {
  const src = text.normalize("NFKC");
  const out = new Set<number>();
  const patterns = [/(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/g, /(\d{4})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/g];
  for (const re of patterns) {
    for (const m of src.matchAll(re)) {
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      if (validDate(y, mo, d)) out.add(y * 10000 + mo * 100 + d);
    }
  }
  return [...out];
}

/** "2019-03-02" → 20190302. 형식이 다르거나 없는 날짜면 undefined. */
export function isoToOrdinal(iso: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
  if (!m) return undefined;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return validDate(y, mo, d) ? y * 10000 + mo * 100 + d : undefined;
}

export function ordinalToIso(n: number): string {
  const s = String(n);
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** 달력 기준으로 기간을 뺀 날짜. 말일 보정: 2024-02-29 − 1년 → 2023-02-28. */
export function subtractPeriod(iso: string, p: { years: number; months: number; days: number }): string {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  const totalMonths = y * 12 + (m - 1) - p.years * 12 - p.months;
  const ny = Math.floor(totalMonths / 12);
  const nm = totalMonths - ny * 12 + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  const date = new Date(Date.UTC(ny, nm - 1, Math.min(d, last)));
  date.setUTCDate(date.getUTCDate() - p.days);
  return date.toISOString().slice(0, 10);
}

export type Comparator = ">=" | ">" | "<=" | "<" | "=";

/** 원문 표현이 정한 비교 방향. 표현이 없으면 undefined(모델 해석을 쓴다). */
export function comparatorFromText(text: string): Comparator | undefined {
  const s = squash(text);
  if (/초과/.test(s)) return ">";
  if (/미만/.test(s)) return "<";
  if (/이상|이후|부터/.test(s)) return ">=";
  if (/이하|이전|까지/.test(s)) return "<=";
  return undefined;
}

export function formatAmount(n: number): string {
  return n.toLocaleString("ko-KR");
}
