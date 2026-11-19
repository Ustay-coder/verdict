# 서류 검토 서비스 — 기획안

> 산출물 A. 화면 구성은 사용자와 합의된 요구사항을 그대로 따른다. 이 문서는 그 요구사항을 다시 기획하지 않고, 실제 저장소 조사 결과에 맞춰 범위·구현 순서·재사용 범위를 정한다.
> 함께 보는 문서: [ui-design.md](ui-design.md)(UI 시안), [spec.md](spec.md)(구현 명세).

## 1. 목적과 사용 상황

여러 건의 신청 서류(사업자등록증, 재무제표, 사업계획서 등 PDF)를 **자연어로 적은 요건**에 비추어 한 건씩 검토하고,
각 서류를 `충족` / `미충족` / `확인 필요` 중 하나로 분류한다. 지원사업·입주심사 담당자가 수십~수백 건의 서류를 1차로 거르는 상황을 상정한다.

핵심 경험은 **문서의 위치가 처리 상태를 설명하는 것**이다. 대기 더미 → 중앙(검토 중) → 세 결과 영역으로 문서가 이동하며, 결과 영역에는 저장된 결과만 쌓인다.

## 2. 확정된 사용자 흐름 (변경 없음)

`요건 → 서류 → 검토`

1. **요건 입력** — 제목 `요건 입력`, 큰 입력창 하나, `다음`. 공백뿐이면 `다음` 비활성.
2. **서류 업로드** — 끌어놓기 영역(클릭·키보드로 파일 선택), 업로드된 서류 목록(파일명 + 작은 삭제), `이전` / `검토 시작`.
3. **검토** — 왼쪽 대기 더미, 가운데 현재 문서 한 장, 오른쪽 세 결과 영역. 일시정지·재개, 결과 상세(필요할 때 열림).

## 3. 첫 버전 범위

| 포함 | 비고 |
| --- | --- |
| 자연어 요건 → 내부 조건(요건 목록 + 논리식) 자동 구성, 실행 시작 시 고정 | LLM 해석 + 코드 검증. UI에 노출하지 않음 |
| PDF(텍스트), 스캔 PDF(OCR), PNG/JPEG(OCR), TXT 업로드 | 파일 1개 = 검토 대상 1건 |
| 페이지 단위 원문 보존, 근거 인용의 원문 대조 | 원문에 없는 인용은 버림 |
| 날짜·숫자 요건은 값 추출 후 코드 계산 | Verdict `benchmark` formula |
| 서술형 요건은 Verdict decision 모델(Jev) 판정 | 검증된 사실만 근거로 제공 |
| 종합 판정: 미충족 > 확인 필요 > 충족 (3치 논리), `또는`·`제외` 보존 | Verdict `formula` 집계 |
| 서버 백그라운드 순차 실행, 일시정지·재개·재시도, 새로고침 복구 | 탭을 닫아도 계속 |
| 저장된 이벤트 로그 + SSE, 중복 집계 방지 | seq 기반 |
| 기존 API 키 → tenant 권한 체계로 파일·결과 범위 제한 | `envAuth` 재사용 |

### 이번 범위에 포함하지 않는 것
- 기준일·창업일 정의·증빙 종류 등 **설정 입력 UI**(사용자가 명시적으로 삭제) — 정보가 없으면 `확인 필요`로 남긴다.
- 해석된 조건 미리보기, 확인 팝업, 예시 입력/예시 서류 버튼, 통계 카드, 대시보드, 사이드바, 채팅, 모델 선택.
- 여러 파일을 한 대상으로 묶기(파일명 추정 결합 금지), HWP/DOCX 변환, 사람 검토자 배정, 결과 내보내기.
- 로그인 화면(기존 API 키 체계를 쿠키/헤더로 사용; 별도 UI 없음).

## 4. 화면별 주요 동작

| 화면 | 동작 |
| --- | --- |
| 요건 | 입력은 이전 단계 이동·새로고침에도 유지(브라우저 초안 저장). 요건을 고쳐도 업로드한 파일 유지. 다음 실행부터 수정 내용 반영 |
| 서류 | 파일마다 즉시 서버 전송 → 저장 → 형식 검증·텍스트/OCR 추출(준비). 진행·오류는 해당 행 안에서만 표시, 오류 행에 재시도. 전송·준비가 모두 끝나야 `검토 시작` 활성. 오류 파일이 있으면 시작 불가(몰래 제외하지 않음) |
| 검토 | `검토 시작` = 서버에 실행 생성(요건 원문·내부 조건·파일·추출본 고정). 서버가 한 건씩 처리하며 이벤트를 남김. 화면은 이벤트를 따라 문서를 이동. 상세는 Sheet로 열림, 선택·포커스는 강제로 바뀌지 않음 |

## 5. 파일과 검토 대상의 단위
- 파일 1개 = 검토 대상 1건 = Verdict 평가(Evaluation) 1건(시도마다 1건).
- 한 실행(run)은 `검토 시작` 시점의 파일 목록을 같은 순서로 고정한다.

## 6. 판정·오류 처리 원칙
- 개별 요건: 근거가 만족 → `충족`, 근거가 어긋남 → `미충족`, 판단 불가 → `확인 필요`. **찾지 못함 ≠ 미충족**.
  예외: 요건이 특정 자료의 제출 자체를 요구하고 제출 목록(그 파일)이 확정된 경우에만, 자료가 없음을 `미충족`으로 처리.
- 기준일·정의·값이 확정되지 않으면 임의로 채우지 않고 `확인 필요` + "필요한 정보"를 상세에 남긴다.
- 종합: 미충족이 하나라도 → 미충족, 없고 확인 필요가 있으면 → 확인 필요, 모두 충족 → 충족. `또는`(max), `제외`(not)를 보존(3치 Kleene 논리).
- 처리 오류(파일 손상, 추출·OCR 실패, 모델 호출 실패, 저장 실패)는 판정이 아니다. 문서 상태 `오류`로 보존, 재시도 가능, 다른 문서 진행을 막지 않는다.
- 문서 안의 지시문은 자료로만 취급한다(프롬프트에서 데이터로 구획, 판정은 코드·Verdict가 수행).

## 7. 저장소 조사 결과 (2026-11-18 확인)

| 항목 | 확인한 사실 | 근거 |
| --- | --- | --- |
| 작업 지침 | `AGENTS.md`: pnpm workspace, Node 22, ESM/NodeNext(`.js` 확장자), vitest 오프라인 테스트(fetch 주입, mock provider), 판정 불변식(judge는 throw 금지, 평가는 rubric 고정, 공식은 `expr.ts`), 비밀값은 env 참조 | `AGENTS.md` |
| 프레임워크·구조 | 모노레포 `packages/{core,db,api,cli,mcp,sdk}`, API는 Hono(Node·Workers 공용), 문서 사이트는 VitePress. **웹 프론트엔드 앱은 없음** | `pnpm-workspace.yaml`, `packages/*` |
| shadcn/ui·디자인 토큰 | **기존 구성 없음**(Tailwind·Radix·components.json 없음). 새 앱에 shadcn/ui(new-york, neutral)를 CLI로 생성 | `grep` 결과 0건 |
| Verdict 실행 경로 | `Engine.evaluate({ rubric, subject })` → ingest → judges → 집계 → Store 저장. `onEvent`로 `criterion.scored`(요건별 실제 결과) 이벤트 제공 | `packages/core/src/engine/*` |
| 요건(Rubric) 입력 형식 | zod `Rubric`: criteria(scale/choices/values/judge/inputs 태그), judges(decision/llm/human/benchmark/panel), aggregation(`formula`, grades) | `packages/core/src/schema/rubric.ts` |
| 판정 출력 형식 | `Evaluation{ status, criteria[{status, score, choice, ratings[{status, confidence, probabilities, rationale, quotes, error}]}], aggregate{score, grade}, usage }` | `schema/evaluation.ts` |
| 파일 검토·문서 추출 | `file` ingest(PDF→`unpdf` 텍스트, 페이지 병합), 스캔 PDF는 경고만, PDF 페이지를 그림으로 렌더(`canvasPdfPages`, `@napi-rs/canvas`). **OCR 기능은 없음**, 페이지 위치 보존 없음 | `ingest/extract.ts`, `ingest/pdf-pages.ts` |
| 파일 저장소·큐·DB·실시간 | Store(Memory/File/Drizzle SQLite·D1·Postgres), `MemoryQueue`(재시도), 웹훅. **파일 업로드 저장소·SSE·배치 순차 실행·일시정지는 없음** | `store/`, `queue.ts`, `packages/db` |
| 인증·권한 | API 키 → tenant(`envAuth`: `VERDICT_API_KEYS`, `DrizzleAuth`: sha256 해시 키). 모든 Store 읽기는 tenant 범위 | `packages/api/src/app.ts`, `packages/db/src/auth.ts` |
| 실제 판정 모델 | `TYPESAFE_API_KEY`로 Jev `choice` 질문 실호출 성공(2026-11-18, `jev-1.14.0`). OpenAI(프록시)로 구조화 출력·비전 호출 가능 | 조사 스크립트 실행 |

### 재사용 / 새로 만든 것

| 재사용 | 새로 작성 |
| --- | --- |
| `@verdict-ai/core` `Engine`(평가·저장·`criterion.scored` 이벤트), `benchmark` formula judge, `decision` judge(Jev), `formula` 집계·grades, `expr.ts`, `canvasPdfPages` | 앱 `apps/review`: 업로드·파일 저장, 페이지 단위 추출 + OCR 어댑터, 요건 컴파일러(LLM + 코드 검증), 사실 추출·원문 대조, rubric 생성기, 순차 실행기, 이벤트 로그·SSE, 웹 UI |
| `@verdict-ai/db` `fromSqliteFile`(Verdict 평가 저장, tenant 범위) | 앱 상태 테이블(파일·실행·문서·이벤트) — better-sqlite3(이미 `packages/db`가 쓰는 드라이버) |
| `@verdict-ai/api` `envAuth`(키→tenant) | 브라우저용 httpOnly 쿠키 세션(`POST /api/session`) |
| Hono(`@hono/node-server`) | shadcn/ui 컴포넌트, 문서 이동 모션 |

엔진 코어(`packages/*`)는 수정하지 않는다. 새 기능은 Verdict의 공개 확장 지점(rubric·judge spec·`onEvent`·Store)만 사용한다.

## 8. 구현 순서와 의존성
1. 문서(본 기획안, UI 시안 문서, 명세서) — 완료 후 구현.
2. 서버 기반: 상태 DB·파일 저장·인증 → 추출(텍스트/OCR) → 요건 컴파일러 → 사실 추출·검증 → rubric 생성·Verdict 실행 → 실행기(순차·일시정지·재시도·복구) → 이벤트·SSE → HTTP 라우트.
3. 웹: shadcn 기반 단계 화면 → 업로드 행 상태 → 검토 보드·모션 → 상세 Sheet → 시안 엔트리(`prototype.html`, 개발용 예시 데이터 분리).
4. 검증: 단위 테스트(오프라인, fetch 주입), 100건 모형 부하·복구 테스트, 실제 PDF로 실제 Verdict·LLM 연동, Playwright 데스크톱·모바일 스크린샷.

## 9. 확인된 사항과 미확인 사항
- 확인: Jev choice 판정, Verdict formula 집계(3치 논리), OpenAI 구조화 출력(`gpt-5.4-mini`), PDF 페이지 렌더(`@napi-rs/canvas`가 워크스페이스에 설치됨),
  스캔 PDF OCR → 값 대조 → 판정까지 실제 연동(검증 결과는 [spec.md §14](spec.md#14-검증-결과-2026-11-18-이-저장소에서-실행)).
- 미확인/제약:
  - Cloudflare Workers 배포는 이번 범위 밖(파일 시스템·장시간 백그라운드 실행 필요 → Node 서버). Workers용은 R2·Queues·Durable Objects 어댑터가 별도로 필요.
  - OCR 품질은 비전 모델 판독에 의존. 판독 텍스트는 "OCR"로 표시하고, 값은 판독문에서 다시 대조한다.
  - 대량(수천 건) 처리 시 비용·속도는 측정하지 않았다(100건은 모형으로 상태·부하만 검증).
