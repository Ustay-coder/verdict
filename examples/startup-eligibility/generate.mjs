#!/usr/bin/env node
// 가상 신청기업 120곳을 만든다. 2026년 초기창업패키지(일반형) 공고의 요건을 기준으로 한다.
//
//   node generate.mjs base    # 모델에게 요건을 모두 지킨 사업계획서 120개를 받아 base/에 저장 (OPENAI_API_KEY 필요, 이미 있으면 건너뜀)
//   node generate.mjs build   # base/에서 신청서·사업계획서를 만들고, 정해진 기업에 위반을 하나씩 심어 cases.jsonl을 쓴다 (네트워크 없음)
//
// 위반은 모델이 아니라 이 스크립트가 정확한 편집으로 심는다. 그래서 정답(expected)은 만들 때부터 정해져 있다.
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const N = 120;
const pad = (i) => String(i).padStart(3, "0");

// ── 1. 깨끗한 사업계획서 ──────────────────────────────────────────────────────────────────────
const SECTORS = [
  "농업·스마트팜", "식품 가공", "반려동물", "헬스케어 기기", "디지털 헬스", "에듀테크", "물류", "제조 SaaS", "건설 안전",
  "에너지 효율", "폐자원 재활용", "패션", "뷰티", "여행", "부동산 관리", "핀테크(결제 보조)", "HR·채용", "법률 문서",
  "농촌 관광", "로보틱스", "드론", "소부장(소재)", "콘텐츠 제작 도구", "게임 개발 도구", "공공 데이터", "시니어 케어",
  "육아", "로컬 커머스", "B2B 마케팅", "보안",
];
const SECTIONS = ["1. 문제 인식 (Problem)", "2. 실현 가능성 (Solution)", "3. 성장전략 (Scale-up)", "4. 팀 구성 (Team)"];

async function base() {
  mkdirSync(join(here, "base"), { recursive: true });
  const todo = Array.from({ length: N }, (_, i) => i).filter((i) => !existsSync(join(here, "base", `${pad(i)}.json`)));
  const one = async (i) => {
    const sector = SECTORS[i % SECTORS.length];
    const prompt = [
      `초기창업패키지 사업계획서의 본문을 한국어로 작성하라. 분야: ${sector}. 이 분야에서 서로 겹치지 않는 아이템을 고르기 위한 번호: ${i}.`,
      `가상의 창업기업이다. 실존하는 기업·인물·학교·기관 이름을 쓰지 않는다.`,
      `다음 네 제목을 정확히 이 문자열 그대로, 이 순서로 쓴다: ${SECTIONS.join(" / ")}. 제목마다 본문 3~5문단, 전체 1,800~2,500자.`,
      `대표자·직원의 성명, 성별, 생년월일, 출신 학교, 직장명은 쓰지 않는다. 사람은 '대표자', '팀원 A' 처럼만 쓴다.`,
      `과거나 현재의 정부·공공기관 창업지원사업 선정·수혜 이력은 언급하지 않는다. "※"로 시작하는 안내 문구를 쓰지 않는다.`,
      `아이템은 합법적이고 평범한 사업이다(유흥주점, 사행성, 가상자산 거래와 무관).`,
    ].join("\n");
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.OPENAI_API_KEY ?? "dummy"}` },
      body: JSON.stringify({
        model: "gpt-5.4-mini",
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_schema", json_schema: { name: "plan", strict: true, schema: {
          type: "object", additionalProperties: false, required: ["itemName", "summary", "body"],
          properties: { itemName: { type: "string" }, summary: { type: "string" }, body: { type: "string" } } } } },
      }),
    });
    if (!r.ok) throw new Error(`${i}: ${r.status} ${await r.text()}`);
    const plan = JSON.parse((await r.json()).choices[0].message.content);
    writeFileSync(join(here, "base", `${pad(i)}.json`), JSON.stringify({ sector, ...plan }, null, 1) + "\n");
  };
  for (let k = 0; k < todo.length; k += 8) await Promise.all(todo.slice(k, k + 8).map(one));
  console.log(`${todo.length} written, ${N - todo.length} already there`);
}

// A clean base plan must already pass every check, or a planted violation would not be the only one.
function cleanProblems(text) {
  const p = [];
  for (const s of SECTIONS) if (!text.includes(s)) p.push(`missing heading ${s}`);
  if (/※/.test(text)) p.push("guide mark");
  if (/[가-힣]{1,4}(대학교|대학원)(?![가-힣]*○)/.test(text.replace(/○+대학교/g, ""))) p.push("university");
  if (/(예비창업패키지|초기창업패키지|창업도약패키지|선정되어|협약을 체결|수혜)/.test(text)) p.push("support history");
  if (/(카지노|유흥|도박|가상자산|암호화폐|코인 거래)/.test(text)) p.push("excluded business");
  return p;
}

// ── 2. 신청서와 위반 심기 ─────────────────────────────────────────────────────────────────────
// Deterministic PRNG so `build` always writes the same 120 companies.
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
const ymd = (d) => Number(d.toISOString().slice(0, 10).replaceAll("-", ""));
const CLEAN_CODES = ["62010", "63112", "58222", "47912", "72129", "26429", "10799", "28909", "38220", "73903"];
const GUIDE = "※ 개발하고자 하는 창업 아이템의 국내·외 시장 현황 및 문제점 등의 제시 문제 해결을 위한 창업 아이템의 개발 필요성 등 기재";

// Each kind: which check it breaks, and how it is planted. `near` kinds break nothing: they look like a violation.
const KINDS = {
  age_old:      { breaks: "age_ok", app: (a) => { a.startDate = 20220915; } },
  age_after:    { breaks: "age_ok", app: (a) => { a.startDate = 20260210; } },
  doc_missing:  { breaks: "docs_ok", app: (a) => { a.documents.bizRegistration = false; } },
  bad_code:     { breaks: "industry_code_ok", app: (a) => { a.industryCode = "91249"; a.industryName = "기타 사행시설 관리 및 운영업"; } },
  closed:       { breaks: "status_ok", app: (a) => { a.businessStatus = "휴업"; } },
  over_budget:  { breaks: "budget_ok", app: (a) => { a.govFundRequested = 12000; } },
  no_team:      { breaks: "form_ok", plan: (t) => t.replace(SECTIONS[3], "4. 기타 사항") },
  guide_left:   { breaks: "guide_removed", plan: (t) => t.replace(SECTIONS[0], `${SECTIONS[0]}\n${GUIDE}`) },
  unmasked:     { breaks: "blind_ok", plan: (t) => t.replace(SECTIONS[3], `${SECTIONS[3]}\n대표자 김도윤(남, 1991년생)은 한빛대학교 산업공학과를 졸업하고 세진물산에서 7년간 근무했다.`) },
  casino_item:  { breaks: "business_ok", plan: (t) => t.replace(SECTIONS[2], `${SECTIONS[2]}\n수익 다각화를 위해 회원 간 실시간 현금 배팅이 가능한 온라인 홀덤 게임장을 함께 운영할 계획이다.`) },
  crypto_item:  { breaks: "business_ok", plan: (t) => t.replace(SECTIONS[2], `${SECTIONS[2]}\n2단계로 이용자 간 가상자산을 사고팔 수 있는 자체 거래소를 열어 중개 수수료 수익을 얻는다.`) },
  prior_ckp:    { breaks: "history_ok", plan: (t) => t.replace(SECTIONS[3], `${SECTIONS[3]}\n당사는 2024년 초기창업패키지에 선정되어 협약을 체결하고 시제품 개발을 수행한 바 있다.`) },
  running_2026: { breaks: "history_ok", plan: (t) => t.replace(SECTIONS[3], `${SECTIONS[3]}\n현재 2026년 중소벤처기업부 창업성장기술개발사업 외에 중앙부처 창업사업화 지원사업(생애최초 청년창업)에 선정되어 사업을 수행 중이다.`) },
  // Near misses: a person checking the rules would let these through.
  near_masked:  { breaks: null, plan: (t) => t.replace(SECTIONS[3], `${SECTIONS[3]}\n대표자 김○○은 ○○대학교 산업공학과를 졸업하고 제조 대기업에서 7년간 생산관리 업무를 수행했다.`) },
  near_yechang: { breaks: null, plan: (t) => t.replace(SECTIONS[3], `${SECTIONS[3]}\n대표자는 창업 전 예비창업패키지에 1회 선정되어 시제품을 만든 경험이 있다.`) },
  near_local:   { breaks: null, plan: (t) => t.replace(SECTIONS[3], `${SECTIONS[3]}\n현재 시·도 지자체의 소규모 창업 지원사업을 수행 중이며, 이는 국비 창업사업화 사업이 아니다.`) },
  near_game:    { breaks: null, plan: (t) => t.replace(SECTIONS[2], `${SECTIONS[2]}\n후속으로 현금 거래가 없는 무료 캐주얼 퍼즐 게임을 함께 출시해 이용자 유입을 늘린다.`) },
  near_edge:    { breaks: null, app: (a) => { a.startDate = 20230123; } }, // 신청가능 업력의 첫날
};
// 120 companies: 13 violation kinds × 4, 5 near-miss kinds × 4, the rest clean.
const PLAN = Object.keys(KINDS).flatMap((k) => Array(4).fill(k));

function build() {
  const rand = rng(20260123);
  const order = Array.from({ length: N }, (_, i) => i).sort(() => rand() - 0.5);
  const kindOf = new Map(order.slice(0, PLAN.length).map((i, k) => [i, PLAN[k]]));
  const CHECKS = ["age_ok", "docs_ok", "industry_code_ok", "status_ok", "budget_ok", "form_ok", "guide_removed", "blind_ok", "business_ok", "history_ok"];
  const cases = [];
  for (let i = 0; i < N; i++) {
    const b = JSON.parse(readFileSync(join(here, "base", `${pad(i)}.json`), "utf8"));
    const problems = cleanProblems(b.body);
    if (problems.length) throw new Error(`base/${pad(i)}.json is not clean: ${problems.join(", ")} — regenerate it`);
    const start = new Date(Date.UTC(2023, 1, 1) + Math.floor(rand() * 1000) * 86400000); // 2023-02-01 .. 2025-10
    const app = {
      applicationNo: `CKP-2026-${pad(i + 1)}`, companyName: `가상기업 ${pad(i + 1)}`, itemName: b.itemName, sector: b.sector,
      businessType: rand() < 0.5 ? "개인" : "법인", startDate: ymd(start), representatives: rand() < 0.85 ? 1 : 2,
      industryCode: CLEAN_CODES[Math.floor(rand() * CLEAN_CODES.length)], businessStatus: "계속사업자",
      govFundRequested: 5000 + Math.floor(rand() * 10) * 500, // 만원
      documents: { idCopy: true, bizRegistration: true },
    };
    let plan = `□ 창업 아이템 개요(요약)\n아이템명: ${b.itemName}\n${b.summary}\n\n${b.body}\n`;
    const kind = kindOf.get(i) ?? "clean";
    if (kind !== "clean") { KINDS[kind].app?.(app); if (KINDS[kind].plan) { const before = plan; plan = KINDS[kind].plan(plan); if (plan === before) throw new Error(`${kind} did not apply to ${i}`); } }
    const dir = join(here, "applications", pad(i + 1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "application.json"), JSON.stringify(app, null, 1) + "\n");
    writeFileSync(join(dir, "plan.txt"), plan);
    const expected = Object.fromEntries(CHECKS.map((c) => [c, KINDS[kind]?.breaks === c ? "fail" : "pass"]));
    const at = (f) => `applications/${pad(i + 1)}/${f}`;
    cases.push({ id: pad(i + 1), name: kind, expected, inputs: [
      { type: "file", path: at("application.json"), tags: ["application"] },
      { type: "file", path: at("plan.txt"), tags: ["plan"] },
    ] });
  }
  writeFileSync(join(here, "cases.jsonl"), cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
  const n = (k) => cases.filter((c) => c.name === k).length;
  console.log(`${cases.length} cases: ${cases.filter((c) => Object.values(c.expected).includes("fail")).length} with a violation, ${Object.keys(KINDS).filter((k) => KINDS[k].breaks === null).reduce((s, k) => s + n(k), 0)} near misses, ${n("clean")} clean`);
}

const cmd = process.argv[2];
if (cmd === "base") await base();
else if (cmd === "build") build();
else console.error("usage: node generate.mjs base|build");
