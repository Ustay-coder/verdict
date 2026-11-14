#!/usr/bin/env node
// 글 속 숫자가 data/*.json에 있는지 대조한다. 사용: node check-facts.mjs <draft.md> <facts.json> [facts2.json ...]
// 종료 코드 1이면 근거 없는 숫자가 있다는 뜻이다. 계산 결과(차이 등)는 json에 delta로 미리 넣어 두어야 통과한다.
import { readFileSync } from "node:fs";

const [draftPath, ...factPaths] = process.argv.slice(2);
if (!draftPath || factPaths.length === 0) {
  console.error("usage: check-facts.mjs <draft.md> <facts.json> [...]");
  process.exit(2);
}

const known = new Set();
const norm = (s) => String(s).replace(/,/g, "").replace(/^\+/, "").replace(/^[−-](?=\d)/, "");
const walk = (v) => {
  if (typeof v === "number") known.add(norm(v)), known.add(norm(Math.abs(v)));
  else if (typeof v === "string") for (const m of v.matchAll(/\d[\d,]*\.?\d*/g)) known.add(norm(m[0]));
  else if (Array.isArray(v)) v.forEach(walk);
  else if (v && typeof v === "object") Object.values(v).forEach(walk);
};
for (const p of factPaths) walk(JSON.parse(readFileSync(p, "utf8")));

let text = readFileSync(draftPath, "utf8");
text = text.replace(/^---[\s\S]*?---\n/, ""); // front matter
text = text.replace(/```[\s\S]*?```/g, " "); // 코드 블록
text = text.replace(/\d{4}-\d{2}-\d{2}/g, " "); // 날짜
text = text.replace(/\[[^\]]*\]\([^)]*\)/g, (m) => m.replace(/\([^)]*\)/, "")); // 링크 URL
text = text.replace(/^#{1,6}\s*\d+[.)]?\s/gm, "# "); // 번호 붙은 제목
text = text.replace(/\b(\d{1,2})편\b|\b(\d{1,2})개월\b|\b(\d)\s*번/g, " "); // 편 번호 등 서수

const unknown = [];
for (const m of text.matchAll(/[+−-]?\d[\d,]*\.?\d*/g)) {
  const raw = m[0];
  const n = norm(raw.replace(/[.,]$/, ""));
  if (n === "" || known.has(n)) continue;
  if (/^\d$/.test(n)) continue; // 한 자리 정수는 서술용(1개, 2번 등)으로 허용
  const line = text.slice(0, m.index).split("\n").length;
  unknown.push({ raw, line, ctx: text.slice(Math.max(0, m.index - 15), m.index + 20).replace(/\n/g, " ") });
}

if (unknown.length === 0) {
  console.log(`OK: 모든 숫자가 근거를 가짐 (known=${known.size})`);
} else {
  console.log(`FAIL: 근거 없는 숫자 ${unknown.length}개`);
  for (const u of unknown) console.log(`  ${u.raw}\t(본문 ${u.line}행) …${u.ctx}…`);
  process.exit(1);
}
