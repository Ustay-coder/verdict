# Verdict Hub — 판단 기준 공유·복제·검증 설계 (초안 v0.2)

- 상태: **논의용 초안**. 구현 전. 실제 Jev 호출 실험 없음. Q1–Q8 모두 2026-11-08 결정(§3.1, §15).
- 입력: 「Jev 판단 기준 공유·복제 플랫폼 설계안 v1.0」(2026-11-08, 이하 *원 설계안*)과 현재 Verdict 코드베이스(`6e63fdd`).
- 작업명: **Verdict Hub**. 브랜드 확정 아님.
- 표기: **[결정]** 이 문서가 채택한 설계 기준 · **[제안]** 바꿀 수 있는 구현 방식 · **[논의]** 사용자와 합의가 필요한 항목(§15) · **[후속]** MVP 밖.
- 원 설계안의 요구사항 ID(D·F·V·A)를 그대로 쓰고, Verdict 고유 차별화는 `X1`–`X6`로 붙인다.

---

## 0. 한 문단 요약

원 설계안의 제품 흐름(찾기 → 내 사례로 시험 → 복제·수정 → 원본과 비교 → 고정 버전으로 적용 → 파생·반례 공개)을 그대로 따르되, 중심을 **"공유하는 기준 = Verdict 엔진이 그대로 실행하는 rubric 문서"** 에 둔다. 공유되는 것이 프롬프트 텍스트가 아니라 실행 가능한 문서이므로, 시험한 것과 배포하는 것이 같다(X1). Verdict가 이미 가진 *판단·정책·채점의 분리*(ratings ↔ aggregation ↔ agreement), *재판정 없는 재집계*(`reaggregate`), *사람 판정과 escalation*, *여러 decision model 어댑터*, *CLI·CI·MCP·Workers 동일 엔진*을 비교·검증 흐름의 기반으로 쓴다. 새로 만들 것은 불변 버전·fork 관계·데이터셋 버전·실행 기록·비교 엔진·공개 스냅샷이다. 사례와 API 키는 기본적으로 **사용자 쪽(로컬·사용자 CI)에 머물고**, 허브에는 사용자가 고른 공개 스냅샷만 올라간다(X2).

---

## 1. 원 설계안과 현재 Verdict 대조

| 원 설계안 요구 | 현재 Verdict | 판정 |
| --- | --- | --- |
| Choice / Score / Noul 판단 | criterion → `choice` / `score` / `noul` 질문 변환(`judges/decision/questions.ts`) | **있음** |
| 원시 출력 보존, 확률·confidence 보존 | rating에 `probabilities`, `confidence`, `raw.answer`, `raw.question` 저장 | **있음** |
| 판단 ↔ 사용 정책 분리 (§4.1) | criteria(판단) ↔ `aggregation`·`gates`·`grades`·`minConfidence`(정책). `reaggregate`는 judge를 부르지 않음 | **있음** — 구조적으로 이미 분리 |
| 원시 / 정책 / 평가 3층 (§11.1) | rating(원시) → aggregate(정책) → `agreementReport`(기대 판정과 비교, 순수 함수) | **있음** — 이름만 다름 |
| 실행 오류를 0점으로 바꾸지 않음 (A11) | judge는 throw하지 않고 `status: "error"`; agreement는 failed·escalated를 분모에서 분리 | **있음** |
| 실행 시 스냅샷 고정 (V02, A05) | evaluation이 rubric 사본을 고정 | **부분** — 고정은 되지만 버전 ID·해시가 없음 |
| 자기 사례로 시험 (F03) | `verdict check -r … -g gold.jsonl`, MCP `check_against_humans` | **부분** — gold set이 파일일 뿐, 버전·레이블 출처·분할 없음 |
| confidence와 정확도 구분 (A12) | `calibrate`가 confidence 구간별 사람 일치율·ECE·추천 `minConfidence` 산출 | **있음** (Noul 표기는 §12.2 참조) |
| 불변 버전·내용 해시 (V02) | `PUT /v1/rubrics/:id`가 제자리 덮어쓰기, `version`은 자유 문자열 | **없음** |
| Fork 관계 (F04, V01) | 없음 | **없음** |
| 원본·복제본 비교 (F05, D1) | `watch`가 같은 rubric의 *텍스트* 변화와 순위 변화를 보여줄 뿐, 판정 비교 없음 | **없음** |
| 구체 모델 ID 기록 (A10) | `raw.model = res.model ?? spec.model` — 응답에 모델이 없으면 **요청한 별칭을 실제 모델처럼 기록** | **결함** (§12.1) |
| Noul 임계값을 0.5로 자동 채우지 않음 (§13.1) | binary 척도의 `snapToScale`이 `>= 0.5`로 고정 | **충돌** (§12.2) |
| Choice 기대 판정 비교 (§11.4) | `agreement.ts`·`calibration.ts`가 choice 기준을 다루지 않음 | **결함** (§12.3) |
| 공개 탐색·발행 (F01, F06) | 모든 store 읽기가 tenant 범위. 공개 개념 없음 | **없음** |
| 버전 고정 내보내기 (F07) | rubric YAML 자체가 실행 형식. `export`는 evaluation 덤프 | **부분** |
| 비공개 ID 직접 요청 차단 (A15) | 모든 읽기 tenant-scoped, API 키 sha256 | **있음** |

정리: **비교·검증의 "의미론"은 이미 엔진에 있고, 없는 것은 "버전·관계·공개"라는 자산 관리 층이다.** 이것이 Verdict로 이 제품을 만드는 가장 큰 이유다.

---

## 2. 포지셔닝과 차별화

### 2.1 한 문장

> **다른 사람의 판단 기준을 찾아, 내 사례로 시험하고, 시험한 그 버전 그대로 배포하세요.**

원 설계안 문장에 "시험한 그 버전 그대로"를 더했다. Verdict에서는 이것이 마케팅 문구가 아니라 구조적 사실이어야 한다(X1).

### 2.2 원 설계안의 차별화 유지

D1(내 사례에서 원본·복제본 비교), D2(검증 기록을 정확한 조건에 귀속), D3(반례·파생 축적)은 그대로 채택한다. 경쟁 제품에 대해 "하지 않을 주장"(원 설계안 §2.3)도 그대로 지킨다.

### 2.3 Verdict 고유 차별화

| ID | 차별화 | 근거가 되는 Verdict 자산 | 사용자에게 보이는 것 |
| --- | --- | --- | --- |
| **X1** | **실행 = 내보내기.** 공유 자산이 엔진이 직접 실행하는 rubric 문서이고, 플랫폼 실행·CLI·CI·Workers·MCP가 같은 엔진·같은 질문 변환을 쓴다. | 단일 `core` 엔진, `buildQuestion`, rating에 저장되는 `raw.question` | 버전 페이지의 `questionsHash`와 내 실행 기록의 해시가 일치함을 표시. `verdict pull hub:owner/name@rv_…` 한 줄로 가져옴 |
| **X2** | **사례는 내 쪽에 머문다.** 로컬 워크벤치와 사용자 CI에서 실행하고, 허브에는 명시적으로 고른 공개 스냅샷만 올린다. API 키도 사용자 환경 변수(`apiKeyEnv`)에 남는다. | local engine + FileStore/SQLite, `apiKeyEnv` 불변조건 | "이 실행의 사례는 허브에 전송되지 않았습니다" 표시. BYOK가 기본 |
| **X3** | **질문 변경 효과 vs 정책 변경 효과를 모델 호출 없이 분리.** 임계값·레이블을 바꾼 효과는 저장된 원시 결과로 재계산(비용 0), 질문을 바꾼 효과만 재실행. | `reaggregate`, 순수 함수 `agreementReport`, 별도 해시(§5) | 비교 화면이 "재실행 필요 / 재채점만으로 충분"을 자동 판정 |
| **X4** | **판정 확률을 쓰는 비교.** 판정이 같아도 확률이 경계 쪽으로 이동한 사례를 "경계 근접"으로 드러낸다. | rating `probabilities` | 회귀 *예비군* 목록. 레이블만 보는 비교보다 먼저 위험을 보여줌 |
| **X5** | **기준 변경을 코드 리뷰처럼.** `verdict diff`가 CI에서 회귀 시 실패하고 PR 코멘트로 비교 요약을 남긴다. | 기존 CI 품질 게이트·harness 문화, CLI | 기준 PR마다 "수정 3 · 회귀 0 · 경계 근접 2 · 조건 동일" |
| **X6** | **사람 루프가 반례를 만든다.** 운영 중 low-confidence escalation으로 사람에게 넘어간 사례가 레이블과 함께 데이터셋 후보로 쌓이고, 원하면 공개 반례가 된다. | `onLowConfidence: human`, human task inbox, `calibrate` | "지난 30일 사람이 판정한 경계 사례 14건 → 새 데이터셋 버전으로 추가" |

보조 차별화(후속 범위에서 강화):
- **에이전트 네이티브**: MCP 도구로 에이전트가 검색 → fork → 내 사례 실행 → 비교까지 수행.
- **모델 이식성 기록**: 같은 rubric 버전을 Jev·Clef-flash·OpenAI Decisions 등 여러 decision model로 실행한 기록을 "조건이 다른 실행"으로 정확히 구분해 나란히 보여줌. MVP는 Jev 중심 **[결정 Q3]**.
- **조합**: 공개 기준을 다기준 rubric에 참조로 넣고 aggregation으로 묶음(원 설계안이 후속으로 둔 "패키지"를 Verdict rubric이 이미 표현함).

---

## 3. 핵심 설계 결정

| # | 결정 | 상태 |
| --- | --- | --- |
| K1 | 공개·버전·fork의 단위는 **rubric 버전**. 허브 MVP 목록에는 **criterion이 1개인 rubric**("판단 카드")만 노출 | **[결정]** Q1 |
| K2 | 판단 정의·사용 정책·메타데이터는 **한 문서에 두되 해시를 분리**(`judgmentHash`, `policyHash`, `metaHash`) | **[결정]** Q5 |
| K3 | 공개는 **복사된 스냅샷**(`publications`)으로만 한다. 공개 조회는 이 테이블만 읽는다. tenant 데이터 읽기 경로는 그대로 tenant 범위 | [결정] |
| K4 | 실행 = Verdict batch + 실행 기록(`runs`). 사례 하나 = evaluation 하나 | [결정] |
| K5 | 비교·재채점은 core의 **순수 함수**. judge를 부르지 않는다 | [결정] |
| K6 | 사례·키는 기본적으로 사용자 쪽. 제품 형태는 로컬 워크벤치 + 공개 읽기 전용 허브 | **[결정]** Q2 |
| K7 | 기존 rubric·gold 파일 형식과 하위 호환. 새 필드는 모두 optional | [결정] |

### 3.1 결정 기록 (2026-11-08)

**Q2 → K6. 제품 형태: 로컬 워크벤치 + 공개 읽기 전용 허브.**
- 사용자의 작업(사례 입력·실행·복제·비교·내보내기)은 `verdict studio`에서 한다. 사례·결과는 사용자의 `.verdict/`(또는 사용자가 띄운 Verdict 서버)에 저장되고, Jev 호출은 사용자 환경의 키(`apiKeyEnv`)로 사용자 쪽에서 나간다.
- 허브는 공개 스냅샷(`publications`)을 탐색·열람하고 발행·fork를 받는 곳이다. 허브 서버는 사용자 사례로 모델을 실행하지 않는다.
- 이유: 원 설계안 §16·§22의 출시 전 결정 항목(키 보관, 사례 보관·삭제, 실행 한도, 비용 부담)을 MVP에서 대부분 피하고, 실제 고객 문장이 플랫폼에 오지 않는 작업 방식을 기본으로 제공한다(X2). 기존 CLI·FileStore·`verdict watch`를 그대로 확장한다.
- 감수하는 것: 허브 상세 페이지의 "내 사례로 시험하기"는 바로 실행이 아니라 워크벤치로 넘기는 동작이다(명령 복사, 또는 실행 중인 `localhost` 워크벤치로 여는 링크 `verdict studio --open hub:owner/name@rv_…`). 비개발자 업무 전문가의 참여는 후속 범위.
- 확장 경로: studio 화면은 처음부터 로컬 엔진과 원격 API(`VERDICT_API_URL`) 둘 다에 붙도록 만든다. 호스팅 워크벤치는 같은 화면을 호스팅 Verdict API에 연결해 연다 **[후속]** — 수요(비개발자·팀)가 확인될 때. 그때 키 보관·보관 정책을 결정한다. 수익 모델과 유료 클라우드의 범위는 이 저장소 밖의 문서에서 다룬다.

**Q1 → K1. 재사용 단위: 저장은 rubric 버전, 허브 MVP는 단일 질문 카드.**
- 버전·fork·발행·내보내기의 단위는 rubric 버전이다. criterion이 1개인 rubric도 정상적인 Verdict rubric이므로 카드 전용 형식을 따로 만들지 않는다. 엔진·CLI·lock 파일이 그대로 동작한다.
- 허브 MVP 발행 검사: criterion이 정확히 1개여야 한다. 단, 사전 검사(`checks`)와 정책 필드(aggregation·gates·threshold)는 허용한다. 비교 화면·지표는 criterion 1개를 전제로 단순하게 만든다.
- 다기준 rubric은 워크벤치에서 지금처럼 쓰고 비교할 수 있다. 발행만 막는다. 비교 엔진(`compareRuns`)은 내부적으로 criterion별로 계산하므로, 다기준 비교 화면은 화면 작업만 남는다.
- 확장 경로 **[후속, P4]**: rubric이 공개 카드를 참조로 조합한다.
  ```yaml
  criteria:
    - ref: hub:support/urgency@rv_3
    - ref: hub:support/wants-agent@rv_5
  aggregation: { method: formula, formula: "max(urgency_n, wants_agent_n)" }
  ```
  카드별 출처·파생 관계가 유지되고, 같은 judge·같은 입력을 쓰는 카드들은 기존 batching으로 **한 번의 Jev 요청**으로 나가므로 조합해도 호출 수는 늘지 않는다. 참조는 `verdict.lock`에 카드별 버전으로 고정한다.

---

## 4. 개념 모델 — 원 설계안 엔터티를 Verdict에 매핑

| 원 설계안 | Verdict 구현 | 저장 (Drizzle, SQLite·PG 동일 계획) |
| --- | --- | --- |
| OwnerSpace | 기존 tenant | 기존 |
| Rubric | 기존 `StoredRubric` = **편집 중인 head** | `rubrics` (기존) + `visibility`, `parentVersionId` 컬럼 |
| RubricDraft | head 자체(자동 저장 대상) | — |
| RubricVersion | **신규** `rv_…`: 불변 문서 + 해시(내용·판단·정책·바인딩·메타). id는 내용 해시에서 만든다(P1-1 결정) | `rubric_versions(id, tenant_id, rubric_id, seq, judgment_hash, policy_hash, meta_hash, parent_version_id, doc, created_at)` |
| ForkRelation | `rubric_versions.parent_version_id` + fork 노트 | 위 컬럼 + `doc.fork = { note, changeKinds }` |
| DatasetVersion | **신규** `dsv_…`: 사례 목록 + `casesHash` + `labelsHash` | `datasets`, `dataset_versions(doc)` |
| UsagePolicyVersion | rubric 문서의 정책 필드 + `policyHash` (K2) | rubric_versions에 포함 |
| EvaluationRun | **신규** `run_…`: batch ID + 실행 조건 지문(§6) | `runs(id, tenant_id, rubric_version_id, dataset_version_id, status, fingerprint, doc)` |
| EvaluationResult | 기존 evaluation (subject.metadata에 `caseId`) | 기존 `evaluations`, `ratings` |
| Comparison | 요청 시 계산하는 순수 함수 결과. 공개 시에만 스냅샷 | `publications.doc` 안에 포함 |
| Publication | **신규** `pub_…`: 공개용으로 **복사한** 버전 문서·사례·요약 | `publications(id, owner, rubric_version_id, slug, domain, locale, judgment_type, license, doc, created_at, withdrawn_at)` |

모든 신규 문서는 JSON `doc` 컬럼에 두고, 조회 조건이 되는 필드만 컬럼으로 뺀다(AGENTS.md 불변조건).

### 4.1 사례(case) 형식 — gold set 확장

기존 `GoldItem { name, inputs, human: { passed?, criteria? } }`를 그대로 받고, 다음 optional 필드를 더한다.

```jsonc
{
  "id": "case-002",                         // 없으면 name에서 생성. 비교의 정렬 키
  "name": "과거 상담 언급",
  "inputs": [{ "type": "json", "data": { "utterance": "어제 상담원과 통화했어요." } }],
  "expected": { "wants_agent": false },     // human.criteria의 새 이름. human도 계속 허용
  "labelSource": "ai_unreviewed",           // human | ai_unreviewed | ai_reviewed | external | unknown
  "split": "development",                   // development | evaluation
  "visibility": "private",                  // private | public — 기본 private
  "kind": "boundary",                       // normal | boundary | counterexample (탐색·표시용)
  "note": "과거 경험 서술은 제외"
}
```

- `labelsHash`는 `(caseId, expected, labelSource)`만, `casesHash`는 `(caseId, inputs)`만 해시한다. 레이블만 바뀌면 `casesHash`는 같고 `labelsHash`만 달라진다 → 재실행 없이 재채점 가능 판정(X3)의 근거.
- 원 설계안 §11.7: 기준을 고치며 본 사례는 `development`. 비교 화면은 분할별 결과를 따로 보여준다.

### 4.2 입력 명세

원 설계안의 `input_schema`는 rubric에 **optional `inputSchema`(JSON Schema 부분집합)** 로 추가한다 **[결정, P0 PR 2에서 구현]**. 실행 전에 `json` 입력을 검사해 필수 필드가 없으면 judge를 호출하지 않고 case 단위 입력 오류로 기록한다(A03).

- 구현: `schema/input-schema.ts`의 작은 검증기(zod 변환 대신 직접 작성 — 경로별 메시지를 그대로 내기 위해서). `eval`·외부 라이브러리 없음, Workers에서 동작.
- 지원 키워드 밖(`format`, `oneOf`, `$ref` 등)은 rubric 파싱 시 거절한다. 검사하지 않는 조건을 검사하는 것처럼 보이지 않게 하기 위해서다.
- 결과: evaluation `status: failed` + `inputErrors: [{ input, path, message }]`. 새 상태값을 만들지 않았다(DB·SDK·webhook 변경 없음). 입력 오류는 재시도 대상이 아니다. gold 검사는 `invalidInput`으로 따로 센다 — 비교 엔진(P1)의 `error` 분류와 분모(`invalidInput`)가 이 필드를 쓴다.
- 대상: 모든 `json` 입력. `json` 입력이 하나도 없으면 실패. 특정 입력만 검사하는 지정(`input: <tag>`)은 수요 확인 후.

---

## 5. 해시와 변경 분류 (V05, X1, X3)

rubric 문서를 정규화(키 정렬, 기본값 채움 후)해 세 부분으로 나눈다.

| 해시 | 포함 필드 | 의미 |
| --- | --- | --- |
| `judgmentHash` | criteria의 `id`·`name`·`description`·scale·`levels`/`anchors`/`choices`, judge `instructions`·요청 옵션(공급자·모델·`baseUrl`은 제외 — 아래 *모델 바인딩*), `checks`, `inputs` 필터, `inputSchema`, rubric `context` — 그리고 rubric에 `llm` judge가 있으면 그 프롬프트에 들어가는 rubric `name`·`version`·`description`·`language`까지 | 모델에게 가는 내용. 바뀌면 **재실행 필요** |
| `policyHash` | `aggregation` 전체, `minConfidence`·`onLowConfidence`·`escalateTo`, criterion `threshold`(§12.2), `values`, `weight` | 출력 해석. 바뀌면 **재채점만** |
| `metaHash` | `metadata`(domain, locale, tags), license·출처, 그리고 decision-only rubric의 rubric `name`·`version`·`description` | 탐색·설명용. 실행에 무관 |

**모델 바인딩**(judge의 `provider`·`model`·`baseUrl`)은 어느 해시에도 넣지 않고 run 지문의 `model`로만 비교한다(원 설계안 `model_binding`). 그래야 fork에서 모델만 바꾼 경우가 "기준 변경"이 아니라 "조건이 다른 비교(모델 다름)"로 분류된다.

필드 분류의 기준은 이름이 아니라 **실제로 judge 요청에 들어가는지**다. 현재 코드 기준으로 decision 질문(`judges/decision/questions.ts`)은 rubric `context`, criterion `name`·`description`, 단계·선택지 설명을 쓰고 rubric `name`·`description`은 쓰지 않는다. LLM 프롬프트(`judges/llm/prompt.ts`)는 rubric `name`·`version`·`description`·`language`도 쓴다. 분류 표는 이 두 파일과 같은 커밋에서 테스트로 묶어, 프롬프트에 필드를 추가하면 분류 테스트가 실패하게 한다.

판단 정의를 실제 공급자 요청으로 바꾼 결과는 별도로 `questionsHash = sha256(canonical(buildRequest(...)))`로 남긴다. `judgmentHash`가 같아도 **어댑터(질문 변환 규칙)가 바뀌면** `questionsHash`가 달라질 수 있으므로, 둘을 함께 기록하고 `adapterVersion`(core 패키지 버전 + 변환 규칙 버전 상수)도 남긴다(원 설계안 §13.2).

**판단 필드의 메타데이터 오해 방지(원 설계안 §13.2).** `name`(criterion)과 `description`은 Verdict에서 실제로 질문에 들어가므로 판단 필드다. 반대로 `metadata.locale` 같은 필드는 모델에 가지 않는다. 편집기와 버전 diff는 이 구분을 색으로 표시한다.

**변경 종류 자동 분류.** 두 버전의 구조적 diff에서 `changeKinds`를 계산한다. 구현(P1-1)에서 확정한 이름: `criteria_added`, `criteria_removed`, `question_text`(judge가 읽는 문구), `output_contract`(질문 유형·단계·선택지 — 단계 순서·추가·삭제, 유형 변경을 모두 포함, §7.3), `checks`, `input_schema`, `policy`, `binding`, `metadata`. 초안의 `levels_reordered`·`levels_changed`·`choices_changed`·`judgment_type_changed`는 `output_contract` 하나로 합쳤다 — 비교 엔진에는 "원시 값을 비교할 수 있는가" 하나만 의미가 있어서다. fork 노트는 사람이 쓰고, `changeKinds`는 기계가 채운다 — 사람이 "문구만 고쳤다"고 써도 기계는 "단계 순서 변경"을 드러낸다.

---

**구현 결정(P1-1).**
- 버전 id는 `rv_` + 내용 해시 앞 20자. 같은 rubric은 어느 컴퓨터에서 고정해도 같은 id가 나오므로, lock 파일·허브·CI가 같은 이름으로 같은 내용을 가리킨다(X1). `seq` 번호는 두지 않았다. 사람이 보는 순서는 `createdAt`과 부모 관계로 보인다.
- 해시는 셋이 아니라 넷(+ 내용 전체): 모델 바인딩(provider·model·baseUrl·options)을 `bindingHash`로 분리해, 모델만 바꾼 fork가 "기준 변경"으로 분류되지 않게 했다.
- 저장은 `Store`와 별도인 `VersionStore` 인터페이스로 두고 Memory·File store만 구현했다. DB store(D1·Postgres)는 허브(P3)와 함께 — 로컬 워크벤치(K6)에는 필요 없고, 스키마·마이그레이션을 미리 고정하지 않기 위해서다.

## 6. 실행 기록 (EvaluationRun, 원 설계안 §9.1)

`POST /v1/runs { rubricVersion, datasetVersion, judge?: <override>, idempotencyKey }` 는 기존 `evaluateBatch`로 사례마다 evaluation을 만들고, 다음 **조건 지문(fingerprint)** 을 저장한다.

```jsonc
{
  "rubricVersionId": "rv_…", "judgmentHash": "…", "policyHash": "…",
  "questionsHash": "…", "adapterVersion": "core@0.3.0+q1",
  "datasetVersionId": "dsv_…", "casesHash": "…", "labelsHash": "…",
  "inputMapping": null,                         // 후속: 열 매핑
  "model": { "provider": "typesafe", "requested": "jev-latest", "resolved": "jev-1.13-2026-10-01", "verified": true },
  "options": { "request": {}, "stateCharLimit": 120000 },   // 공급자에 영향 주는 옵션만
  "scoring": "agreement@1",                     // 채점 함수 버전
  "origin": "platform | author_reported | independent_rerun",
  "counts": { "cases": 40, "succeeded": 38, "errored": 1, "invalidInput": 1, "escalated": 3, "labelled": 36 },
  "usage": { "decisionCalls": 40, "inputTokens": 51234 },
  "startedAt": "…", "finishedAt": "…", "status": "completed | partial | failed | cancelled"
}
```

- `model.resolved`는 **응답에서 확인한 값만** 쓴다. 확인하지 못하면 `resolved: null, verified: false`이고 화면은 "모델 버전 미확인"(A10).
- 재실행은 항상 새 `run`이다. 과거 run을 덮어쓰지 않는다.
- `idempotencyKey`는 기존 batch 멱등성 경로를 재사용한다. 과금의 정확히-한-번은 보증하지 않는다(원 설계안 §14).

---

## 7. 비교 엔진 (`core/src/compare.ts`, F05 · D1)

### 7.1 입력과 출력

```ts
compareRuns(base: RunWithResults, head: RunWithResults, opts?: { labels?: DatasetVersion; criterion?: string }): Comparison
```

`labels`를 주면 두 run을 **같은 레이블 버전으로 재채점한 뒤** 비교한다(§8). 주지 않으면 두 run의 `labelsHash`가 같을 때만 정량 비교한다.

### 7.2 조건 검사

다음 항목을 base·head 지문에서 비교해 `conditions.diffs[]`로 낸다: `casesHash`, `labelsHash`, `model.resolved`(둘 중 하나라도 미확인이면 `unverified`), `options`, `policyHash`, `scoring`, `inputMapping`, `adapterVersion`.

- 차이가 `judgmentHash`뿐이면 → **"기준 변경 비교"**. 개선·회귀를 기준 변경의 효과로 표시할 수 있다.
- 다른 항목도 다르면 → **"조건이 다른 비교"**. 사례별 결과는 보여주되 요약 문구는 "기준 변경 효과"로 쓰지 않는다(A07).
- `policyHash`만 다르면 → 재실행 없이 재채점으로 만든 비교를 권한다(X3).

### 7.3 출력 계약 검사 (A13)

criterion마다 `outputContract = { type, levels: [{value,label}] | choices: [ids] }`를 비교한다. 다르면 원시 값 차이·개선률을 계산하지 않고 사례별 결과를 나란히만 보여준다. 명시적 매핑(`contractMap`, 버전 고정)이 있을 때만 정량 비교 **[후속]**.

### 7.4 사례 분류

공통 `caseId`마다 다음 중 하나로 분류한다.

| 분류 | 조건 |
| --- | --- |
| `kept_match` | 양쪽 모두 기대와 일치 |
| `kept_miss` | 양쪽 모두 불일치 |
| `fixed` | base 불일치 → head 일치 |
| `regressed` | base 일치 → head 불일치 |
| `changed_unlabelled` | 레이블 없음, 판정이 바뀜 |
| `same_unlabelled` | 레이블 없음, 판정 같음 |
| `escalated` | 어느 한쪽이 사람에게 넘어감 (일치·불일치 어디에도 세지 않음 — 기존 agreement 규칙) |
| `error` | 어느 한쪽이 오류·입력 오류·취소 |
| `missing` | 한쪽 run에만 있음 |

**X4 — 경계 근접.** 판정은 같지만 결정에 쓰인 확률이 임계값 쪽으로 `nearMargin`(기본 0.1, 정책 필드) 이상 이동해 임계값까지 거리가 `nearMargin` 안에 들어온 사례를 `near_boundary` 플래그로 표시한다. score 질문은 기대 단계 확률, choice는 1·2위 확률 차, noul은 `|p − threshold|`를 쓴다. 이 값은 모델이 준 확률에서 계산한 것임을 화면에 밝힌다.

### 7.5 분모 (A11, 원 설계안 §11.5)

요약은 항상 `cases / commonSucceeded / labelled / escalated / errored / missing`을 함께 낸다. `commonSucceeded = 0`이면 개선률은 `null`. 일치율은 `labelled ∩ commonSucceeded`에서만 계산한다.

### 7.6 유형별 지표 (원 설계안 §11.4)

- **Choice**: 사례별 선택, 일치·불일치, 혼동 행렬.
- **Noul**: 원시 `p`와 TP/FP/FN/TN·보류. 워크벤치에서 `threshold`가 없으면 이진 지표마다 "기본 임계값 0.5(미설정)"을 붙인다. 공개 발행은 `threshold`를 요구하므로(§12.2) 공개 페이지에는 기본값으로 계산한 이진 지표가 나오지 않는다.
- **Score**: 원시 기대값, 단계 분포, 기대 단계와의 차. 일치 판정 함수는 `scoring` 버전으로 고정(기본 `snap_equal`: 척도에 snap한 값이 같으면 일치 — 현재 `agreement.ts`와 같은 규칙).

---

## 8. 재채점 (원 설계안 §11.3, A08)

`POST /v1/runs/:id/rescore { datasetVersion }` → 저장된 rating으로 **judge 호출 없이** 새 채점 기록(`score_…`)을 만든다. 조건: 새 데이터셋 버전의 `casesHash`가 run의 것과 같을 것(입력이 같을 것). 다르면 409와 "재실행 필요".

- 원래 run의 채점 결과는 바뀌지 않는다. 재채점 기록은 `{ runId, labelsHash, scoring }`에 귀속된다.
- 비교 화면은 "레이블을 바꿔 오른 점수"와 "같은 레이블에서 기준이 더 잘 맞게 된 점수"를 서로 다른 줄로 보여준다. 개선율은 base·head를 **같은 새 레이블로** 재채점한 뒤에만 표시한다.
- 정책만 바뀐 경우(§5 `policyHash`)도 같은 경로: `reaggregate` + 재채점으로 처리.

---

## 9. 공개·허브·권한 (F01 · F06 · D2 · D3, V06–V09, A14–A16)

### 9.1 공개 스냅샷 (K3)

`POST /v1/publications { rubricVersion, cases: [caseId…], runs: [runId…], license, sources, note }`

1. 서버는 선택한 버전 문서, 선택한 사례(`visibility`를 이 시점에 public으로 지정한 것만), 선택한 run의 **요약**(지문 + 분모 + 지표, 비공개 사례의 입력·결과 제외)을 **복사**해 `publications.doc`에 저장한다.
2. 공개 미리보기 = 저장 직전의 같은 payload. 미리보기와 실제 공개가 다른 코드 경로를 타지 않는다.
3. 공개 조회 API(`/v1/public/*`)는 `publications` 테이블만 읽는다. 기존 tenant 경로에는 공개 예외를 두지 않는다 — "모든 store 읽기는 tenant 범위" 불변조건이 그대로 유지된다.
4. 라이선스 없는 발행은 거절(원 설계안 §13.1). 사례별 라이선스·출처를 보존.
5. 공개 run 요약에는 `origin`과 레이블 출처 분포(사람 / AI 미검토 / …)를 항상 함께 싣는다(A19). "검증됨" 배지는 만들지 않는다.

### 9.2 Fork와 부모 정보 (V01, V04, V07)

- 공개 버전에서 fork: `POST /v1/public/rubric-versions/:id/forks` → 내 tenant에 새 rubric head(비공개) + `parentVersionId`. 원본은 바뀌지 않고, 원본의 새 버전도 자동 반영되지 않는다.
- 부모의 run 요약은 "원본 버전의 참고 결과"로 링크만 하고 fork의 실적으로 복사하지 않는다(A09).
- 비공개 부모에서 파생된 버전을 공개할 때, 공개 페이지의 부모 표시는 "비공개 원본"으로만 한다(V07).

### 9.3 공개 중단·삭제 (V09)

`withdrawn_at` 설정 → 검색·조회에서 제외, 이미 fork된 사본은 유지된다는 사실을 화면에 그대로 표시. 개인 사례 삭제 시 evaluation의 evidence·inputs를 지우고 run 요약에 `evidence_deleted` 표시. 보관 기간은 출시 전 결정.

### 9.4 계정과 신원 **[결정 Q6]**

현재 Verdict는 API 키 → tenant뿐이다. 공개 작성자 신원이 필요하다. 결정: 허브 발행 시에만 GitHub OAuth로 작성자 핸들을 확인하고 tenant에 연결. 로컬 워크벤치 사용에는 계정이 필요 없다.

---

## 10. 표면별 계약 (REST · SDK · CLI · MCP)

README REST 표, `packages/sdk`, OpenAPI를 함께 바꾼다(AGENTS.md 불변조건).

### 10.1 REST (신규)

| Method | Path | 목적 |
| --- | --- | --- |
| `POST` | `/v1/rubrics/:id/versions` | head를 불변 버전으로 고정 → `rv_…` + 해시 3종. 내용이 직전 버전과 같으면 같은 버전 반환 |
| `GET` | `/v1/rubrics/:id/versions` | 버전 목록 (seq, 해시, changeKinds) |
| `GET` | `/v1/rubric-versions/:id` | 버전 조회 (tenant 범위) |
| `POST` | `/v1/rubric-versions/:id/forks` | 내 버전에서 fork |
| `GET` | `/v1/rubric-versions/:a/diff/:b` | 구조적 diff + changeKinds |
| `POST` | `/v1/datasets` · `POST /v1/datasets/:id/versions` | 사례 집합·버전 생성 (JSON / JSONL, 기존 gold 형식 허용) |
| `POST` | `/v1/runs` · `GET /v1/runs/:id` | 실행 생성·조회 (`async` 지원, 부분 실패·취소 상태) |
| `POST` | `/v1/runs/:id/rescore` | 재채점 (judge 호출 없음) |
| `POST` | `/v1/comparisons` | `{ base, head, labels? }` → 비교 결과 (저장하지 않음) |
| `POST` | `/v1/publications` · `DELETE /v1/publications/:id` | 공개 발행·중단 |
| `GET` | `/v1/public/rubrics?q=&domain=&locale=&type=&owner=` | 공개 검색 (인증 없음) — P3-3 구현 |
| `GET` | `/v1/public/rubrics/:owner/:slug?version=` | 공개 상세 + 버전 이력 (P3-3에서 버전 id 대신 `owner/slug` 기준으로 바꿈: 같은 버전이 여러 카드에 실릴 수 있다) |
| ~~`POST`~~ | ~~`/v1/public/rubric-versions/:id/forks`~~ | H5로 제외 — fork는 로컬 `verdict fork hub:…`가 한다 |
| `GET` | `/v1/rubric-versions/:id/export?format=yaml\|lock` | 버전 고정 내보내기 (비밀·비공개 사례 제외) |

### 10.2 CLI

```bash
verdict version freeze rubric.yaml              # 로컬 rubric을 rv로 고정 (.verdict/versions)
verdict fork hub:support/agent-intent-ko@rv_3 --to my-intent.yaml
verdict run -r my-intent.yaml -d cases.jsonl     # run 기록 + 사례별 결과
verdict diff --base hub:support/agent-intent-ko@rv_3 --head my-intent.yaml -d cases.jsonl
verdict diff … --fail-on regressed,error         # X5: CI 게이트
verdict rescore run_… -d cases@v2.jsonl
verdict publish my-intent.yaml --cases case-001,case-007 --run run_… --license CC-BY-4.0
verdict pull hub:support/agent-intent-ko@rv_3   # rubric + verdict.lock
```

**구현(P1-2).** 허브가 없는 지금은 참조로 rubric 파일, `rv_…`, `run_…`를 받는다(`hub:` 참조와 `publish`·`pull`은 P3). 실제 명령: `version freeze|show|list|export|verify`, `fork <ref> --to <file> [--note]`, `run -r <ref> -d <cases>`, `diff --base <ref> --head <ref> -d <cases> [--labels <file>] [--rerun] [--fail-on <classes>]`, `rescore <run_…> -d <cases>`. `diff`는 같은 버전·같은 입력의 저장된 실행을 재사용하고(`--rerun`으로 무시), 재사용·게이트 메시지는 stderr로 보내 `--json` 출력을 깨지 않는다.

`verdict.lock` **[결정, P1-2 구현]**: 저장소에 커밋하는 고정 파일. 키는 lock 파일 기준 상대 경로. 아래는 초안 형식이고, 구현된 형식은 그 다음 블록이다.

```yaml
rubrics:
  agent-intent:
    source: hub:support/agent-intent-ko
    version: rv_01J…            # 정확한 버전
    judgmentHash: 3f1c…
    questionsHash: 9a0e…        # 마지막으로 확인한 변환 결과
    model: { provider: typesafe, requested: jev-1.13, resolved: jev-1.13-2026-10-01 }
```

구현된 형식:

```yaml
lockVersion: 1
rubrics:
  rubrics/intent.yaml:
    parent: rv_…            # fork로 만든 파일일 때
    note: refunds are billing
    version: rv_…           # 마지막 freeze
    contentHash: …
    judgmentHash: …
    verified:               # 이 version을 마지막으로 실행한 결과 (version이 바뀌면 지워짐)
      runId: run_…
      questionsHash: …
      models: [{ provider: typesafe, requested: jev-latest, resolved: jev-1.13.0, verified: true }]
```

`verdict version verify`는 lock의 모든 파일을 다시 고정해 id가 다르면 실패한다(CI용).

**구현(P2).** 실행 시점 검사는 질문을 미리 계산하지 않고 **실행 후 실제로 보낸 질문을 되읽어** lock의 `verified.questionsHash`와 비교한다(`sentFingerprint`). 미리 계산하면 판단 유형별 질문 생성 경로를 CLI가 다시 구현해야 하고, 실제로 보낸 것과 어긋날 수 있어서다. `eval`·`check`·`compare`는 lock에 있는 rubric 파일에 대해 (1) 실행 전: 파일이 lock 버전으로 고정되는지 — 다르면 경고, `--strict`면 judge 호출 전에 실패, (2) 실행 후: 보낸 질문과, 공급자가 밝힌 응답 모델이 lock의 실행과 같은지 — 다르면 경고, `--strict`면 결과를 출력한 뒤 실패. 별칭(`jev-latest`)만 알려진 모델은 비교하지 않는다. `--mock` 실행과 저장된 rubric id는 검사하지 않는다.

### 10.3 MCP

`hub_search`, `hub_get`, `fork_rubric`, `run_cases`, `compare_runs`, `rescore_run`, `publish_rubric`(발행은 에이전트가 단독으로 하지 않도록 미리보기 payload를 먼저 돌려주고, 확정은 별도 호출).

### 10.4 GitHub Action **[결정, P2 구현: `actions/diff`]**

`verdict-ai/diff-action`: PR에서 바뀐 rubric을 base 브랜치 버전과 같은 데이터셋·모델로 비교 → PR 코멘트(분류 요약 + 회귀 사례 목록) → `--fail-on`에 따라 실패. 실행 비용은 사용자 저장소 secret의 키(BYOK).

구현: 별도 저장소 대신 이 저장소의 `actions/diff`(composite action, 로직은 `run.sh`)로 두었다 — `uses: Ustay-coder/verdict/actions/diff@<ref>`. base 커밋의 rubric을 `git show`로 꺼내 `verdict diff --markdown`으로 비교하고, rubric마다 숨은 표식(`<!-- verdict-diff:<path> -->`)이 붙은 코멘트 하나를 매 push마다 갱신한다. 잡 요약(`GITHUB_STEP_SUMMARY`)과 출력(`kind`, `regressed`)도 남긴다. base에 없는 새 rubric은 "비교 대상 없음"으로 통과, CLI가 비교하지 못하면 코멘트에 그 오류를 보여주고 실패한다. 스크립트는 GitHub 밖에서도 돌도록 만들어 로컬 git 저장소로 테스트한다(`packages/cli/test/action.test.ts`). 실제 GitHub 러너·PR 코멘트 경로는 아직 실행해 보지 않았다. npm의 `@verdict-ai/cli` 0.1.0에는 `diff`가 없으므로 다음 릴리스 전까지는 `cli` 입력으로 이 저장소의 빌드를 지정해야 한다.

---

## 11. 화면 (원 설계안 §7)

| 화면 | 위치 | Verdict 자산 재사용 |
| --- | --- | --- |
| 공개 탐색·기준 상세 | **허브**(Workers 렌더링, 읽기 전용) | `publications` |
| 기준 편집 | 워크벤치 | `parseRubric` 검증 오류를 필드 단위로 표시(A02) |
| 사례·실행 | 워크벤치 | `check` / batch, 진행 상태 |
| **비교 (대표 화면)** | 워크벤치 | `verdict watch`의 diff·라운드 UI를 확장 |
| 내 작업 | 워크벤치 | FileStore / SQLite |

**워크벤치 = `verdict studio`** **[결정, §3.1]**: 현재 `verdict watch`(로컬 페이지, `127.0.0.1:4600`)를 편집·실행·비교까지 하는 로컬 앱으로 확장한다. 같은 페이지가 원격 API(`VERDICT_API_URL`)에도 붙는다 — 팀은 자기 Verdict 서버에서 같은 화면을 쓴다.

**구현(P1-3).** 별도 `verdict studio` 명령을 새로 만들지 않고 `verdict watch`에 비교 화면(`/compare`, 데이터는 `/api/compare`)을 붙였다. 화면은 **읽기 전용**이다. 편집·실행·복제·재채점은 CLI(`fork`·`run`·`diff`·`rescore`)가 맡고, `verdict diff`가 이 화면의 링크를 출력한다. 브라우저에서 모델을 호출하는 버튼을 두지 않은 이유: 로컬 서버가 키를 쥐고 쓰기 동작을 받으면 인증·CSRF를 따로 설계해야 하는데, 지금 필요한 것(무엇이 왜 바뀌었는지 읽기)은 읽기만으로 된다. 편집·실행 동작과 `studio` 이름은 수요를 본 뒤(호스팅 워크벤치와 함께) 정한다. 원격 API 연결도 그때 — 버전·실행 기록의 REST 경로가 P3이기 때문이다.

구현된 화면 구성: (1) 실행 두 개와 레이블 세트 선택 — 기본은 가장 최근 실행과, 같은 입력의 직전 실행. (2) 비교 종류 배너 — 숫자보다 먼저, 다른 조건이면 다른 필드 이름까지. (3) 왼쪽: 두 버전의 rubric 줄 단위 diff(변경 주변 3줄만 남기고 접음)와 head의 복제 계보(부모가 base인지, 변경 종류, 노트). (4) 오른쪽: 기준별 일치율 변화와 n, 분류별 개수, 분모, 사례 목록(나빠짐 → 고쳐짐 → 경계 근접 → … 순). 사례를 펼치면 입력 미리보기, 분할·레이블 출처, base·head의 확률 분포 막대.

**비교 화면 구성**
1. 머리: base·head 버전, 조건 배지(`기준 변경 비교` / `조건이 다른 비교: 모델 버전 다름`), 출력 계약 동일 여부.
2. 왼쪽: 판단 필드 diff(질문·단계·선택지, changeKinds 태그). 메타데이터 변경은 접힘.
3. 오른쪽: 분류별 사례 목록 `fixed · regressed · near_boundary · changed_unlabelled · escalated · error`. 사례를 펼치면 입력, 기대 판정(+출처), 양쪽 원시 확률 막대, 정책 적용 결과.
4. 하단: 분모 줄, 분할(development / evaluation)별 결과, "아직 사례가 없는 범위"(사용자가 적는 메모).
5. 행동: 수정 · 재실행 · 레이블 변경 후 재채점 · 버전 고정 · 내보내기 · 공개.

Decision model이 주지 않은 판단 이유를 지어내지 않는다. 설명이 필요하면 사용자가 `llm` judge를 별도로 붙이고, 화면에 "생성 모델의 추론"으로 표시한다.

---

## 12. 먼저 고칠 기존 엔진 동작 (P0)

허브와 무관하게 지금의 Verdict에서도 정확성 문제이므로 먼저 처리한다. §12.1–12.3과 사례 형식 확장(§4.1)은 P0 PR 1에서 구현했다(구현 메모는 각 절 끝). §12.4는 P1.

### 12.1 모델 ID를 별칭으로 대체 기록 (A10)
`packages/core/src/judges/decision.ts`의 `raw.model = res.model ?? this.spec.model`은 응답에 모델이 없을 때 요청 별칭(`jev-latest`)을 실제 모델처럼 남긴다. → `raw.requestedModel`, `raw.resolvedModel`(응답 값만), 하위 호환을 위해 `raw.model`은 유지하되 `resolvedModel ?? requestedModel`로 의미를 문서화. `ratings.model` 컬럼은 resolved 우선, 미확인 표시 필드 추가.
- 구현(PR 1): `DecisionResponse.requestedModel`·`resolvedModel` 추가, rating `raw.requestedModel`·`raw.resolvedModel`·`raw.modelVerified`. `raw.model`과 DB `ratings.model`은 기존 의미(응답 모델, 없으면 요청 모델) 그대로라 스키마 변경 없음. 미확인 여부는 `raw.modelVerified`로 판단한다.

### 12.2 Noul 임계값과 confidence (§13.1, A12)
- `snapToScale`이 binary를 `>= 0.5`로 고정한다. → criterion에 optional `threshold`(0..1)를 추가하고, 없으면 지금처럼 0.5를 쓰되 rating·run에 `thresholdSource: "default" | "rubric"`을 기록한다. **허브 발행 검사는 binary criterion에 `threshold`를 필수로 요구한다**(Q4 결정 — 경고만 하면 기본값으로 계산한 일치율이 공개되어 원 설계안 §11.4에 어긋난다). 워크벤치 비교 화면은 미설정 시 이진 지표 옆에 "기본 임계값 0.5(미설정)"을 표시한다.
- Verdict는 noul에도 `confidence = |2p − 1|`을 계산하고 `minConfidence` 게이트에 쓴다. 이는 모델이 준 값이 아니라 **확률에서 계산한 여유값(margin)** 이다. 엔진 동작은 유지하고(하위 호환), 허브·비교 화면에서는 noul에 대해 "confidence" 대신 "margin |2p−1| (계산값)"으로 표기한다 **[결정 Q4]**.
- 구현(PR 1): criterion `threshold`(0과 1 사이, 양끝 제외, binary 척도 전용). 엔진의 noul 여유값을 임계값 기준으로 일반화했다: 임계값 이상이면 `(p − t)/(1 − t)`, 미만이면 `(t − p)/t`. 0.5에서는 기존 `|2p − 1|`과 같다. 임계값과 다른 기준으로 여유를 재면 `minConfidence` 사람 넘김이 실제 판정 경계와 어긋나기 때문이다. rating에 `raw.threshold`·`raw.thresholdSource` 기록. 허브 발행 시 필수 검사는 P3.

### 12.3 Choice 기준의 기대 판정 비교
`agreement.ts`의 `compareCriterion`은 `coerceScore`로 숫자 척도 비교만 한다. choice 기준은 `values`가 없으면 척도가 무시되므로 옵션 ID 비교가 필요하다. → choice는 `result.choice === expected`로 비교하고 혼동 행렬을 낸다. `calibration.ts`도 같은 처리.
- 구현(PR 1): gold 비교는 옵션 ID로 비교하고, 읽을 수 없는 레이블은 judge 호출 전에 거절한다. calibration은 사람 다수 선택과 비교한다(동률은 선언 순서). `values`가 있으면 오차도 계산한다. 혼동 행렬은 비교 엔진(P1)에서 낸다.

### 12.4 Rubric 제자리 덮어쓰기
`updateRubric`은 head를 덮어쓴다. 이는 head 의미로는 맞다. 버전 고정(§10.1)을 추가하고, evaluation에 `rubricVersionId`(있을 때)를 함께 저장해 "어느 버전의 결과인지"(V03)를 보인다. 고정 없이 실행한 evaluation은 지금처럼 사본만 가지며 화면에 "미고정 초안으로 실행"을 표시.

---

## 13. 단계별 계획

| 단계 | 범위 | 끝났다고 볼 기준 |
| --- | --- | --- |
| **P0 정확성** | PR 1: §12.1–12.3, criterion `threshold`, 사례 형식 확장(§4.1, 하위 호환). PR 2: `inputSchema` 검사(A03) | 기존 goldens 불변(`pnpm smoke`), 신규 테스트 offline(mock provider) |
| **P1 로컬 비교 루프 (D1)** | P1-1: rubric 버전·해시·changeKinds, fork, dataset 버전, `runs`, `compareRuns`, `rescore`, Memory·File 저장(core). P1-2: CLI `version freeze/fork/run/diff/rescore`, `verdict.lock`. P1-3: studio 비교 화면 | §17.1 시나리오 1–8을 mock으로 통과. 실제 Jev 1회 실행은 별도 보고 |
| **P2 CI·고정 내보내기 (X1, X5)** | `verdict.lock`, `pull`, `questionsHash` 런타임 검사, `--fail-on`, GitHub Action | 예제 저장소에서 PR 코멘트 생성 |
| **P3 공개 허브 (D2, D3)** | §16 결정에 따라 4개 PR. P3-1: publications 테이블(SQLite+PG 마이그레이션)·발행 검사·미리보기 = 실제 공개 내용·발행/철회 REST·SDK. P3-2: GitHub 기기 인증, `verdict publish`/`withdraw`. P3-3: 공개 검색·상세 API와 페이지, `verdict pull`/`fork hub:`. P3-4: 관리자 내림, 크기·횟수 제한, MCP 도구 (§16.1–16.4에 구현 기록) | A01, A14–A16, A18, A20 자동 테스트 (다른 tenant의 비공개 ID 요청 거절 포함) |
| **P4 축적 (X6 등)** | escalation → 데이터셋 후보, 다중 모델 실행 기록, 공개 반례 제안, 원본 업데이트 알림, 카드 조합(`ref: hub:…`), 수요 확인 시 호스팅 워크벤치 | 파일럿 사용자 관찰 |

초기 콘텐츠 후보(원 설계안 §3.3): 기존 `examples/rubrics/decision-triage.yaml`(고객 문의)과 `docs-quality.yaml`(문서 검토)을 단일 질문 카드 10–20개로 쪼개고, 한국어 사례를 붙인다. 사례 레이블은 처음엔 `ai_unreviewed`로 정직하게 표시한다.

---

## 14. 완료 기준 추적 (원 설계안 §17)

| ID | 구현 수단 | 단계 |
| --- | --- | --- |
| A01 | `/v1/public/*` + 허브 페이지 (publications만 읽음) | P3 |
| A02 | `parseRubric` zod 오류 → 필드 경로별 메시지 (이미 대부분 있음) + `inputSchema` 검증 | P0 |
| A03 | `inputSchema` 사전 검사 → `failed` + `inputErrors`, judge 미호출 | P0 (PR 2) |
| A04 | fork → 새 비공개 head + `parentVersionId` | P1 / P3 |
| A05 | `rv_…` 불변 + evaluation의 rubric 사본(기존) | P1 |
| A06 | `compareRuns` 조건 검사 통과 시 정량 비교 | P1 |
| A07 | `conditions.diffs` → "조건이 다른 비교" | P1 |
| A08 | `labelsHash` 분리 + `rescore` 후에만 개선율 | P1 |
| A09 | 부모 run은 링크만, fork 실적에 복사 안 함 | P1 / P3 |
| A10 | `requestedModel` / `resolvedModel` / `verified` | P0 |
| A11 | 기존 error rating + 비교 분모 | P0 / P1 |
| A12 | calibration은 기존, noul은 margin 표기 | P0 |
| A13 | `outputContract` 검사 | P1 |
| A14 | 사례 기본 private, 공개는 사례별 선택 | P1 / P3 |
| A15 | 기존 tenant 범위 읽기 + 신규 경로 테스트 | P3 |
| A16 | 공개 payload = 미리보기 payload, 키는 `apiKeyEnv`만 | P3 |
| A17 | X1: 같은 엔진 + `questionsHash` + lock 런타임 검사 | P2 |
| A18 | publications·fork·export에 license·sources·parent 보존 | P3 |
| A19 | `labelSource` 필드 + 공개 요약에 분포 | P0 / P3 |
| A20 | 공개 파생본 페이지: 부모 버전·changeKinds·fork 노트·공개 사례 | P3 |

---

## 15. 논의 사항

2026-11-08 모든 항목을 아래 "결정" 열대로 확정했다. Q1·Q2의 자세한 근거는 §3.1.

| # | 질문 | 결정 | 고려한 다른 선택지와 비용 |
| --- | --- | --- | --- |
| **Q1** ✅ 결정(§3.1) | 재사용 단위: 단일 질문 vs 다기준 rubric | 데이터 모델은 rubric 버전 단위. 허브 MVP 목록은 criterion 1개짜리만 노출(원 설계안 §3.4와 일치) | 다기준 rubric 공개를 허용하면 Verdict의 aggregation 강점이 바로 보이지만, 비교·지표 화면이 criterion별 탭을 가져야 해서 P1 범위가 커진다 |
| **Q2** ✅ 결정(§3.1) | 제품 형태 | 로컬 워크벤치(`verdict studio`) + 공개 읽기 전용 허브. 실행은 사용자 쪽 | 호스팅 SaaS 워크벤치는 첫 경험이 쉬우나 키 보관·사례 보관·삭제 정책을 출시 전에 정해야 한다(원 설계안 §16 미결정 항목이 모두 MVP로 들어옴) |
| **Q3** ✅ 결정 | 모델 범위 | 실행은 모든 decision provider 허용(이미 있음), 허브 공개 기록·마케팅은 Jev 중심. 다른 모델 실행은 "조건이 다른 실행"으로만 표시 | Jev만 허용하면 원 설계안과 완전히 같지만 Verdict의 다중 공급자 장점(Clef-flash on Workers 등)을 숨긴다 |
| **Q4** ✅ 결정 | Noul의 `|2p−1|` confidence와 0.5 기본 임계값 | 엔진은 하위 호환 유지, 허브·비교에서는 "margin(계산값)"·"기본 임계값" 명시, **발행 시 binary `threshold` 필수**(초안의 "경고"에서 변경) | 엔진에서 noul confidence를 없애면 기존 `minConfidence` 게이트·calibration이 깨진다 |
| **Q5** ✅ 결정 | 사용 정책을 별도 엔터티로 둘지 | 같은 문서, 해시 분리(`policyHash`) — 한 파일로 실행되는 Verdict 장점 유지. 허브는 `judgmentHash`가 같은 버전들을 "같은 판단, 다른 처리 규칙"으로 묶어 보여준다 | 별도 `UsagePolicyVersion`은 원 설계안 문구에 더 가깝지만, 사용자가 두 파일·두 버전을 관리해야 한다 |
| **Q6** ✅ 결정 | 공개 작성자 신원 | 발행 시에만 GitHub OAuth | API 키 tenant 이름만 쓰면 빠르지만 공개 출처의 신뢰도가 낮다 |
| **Q7** ✅ 결정 | 첫 분야 | 고객 문의(상담원 연결·긴급도·담당팀·필수 정보) + 문서 검토, 한국어 우선. 파일럿 사용자 분야는 모집 시 재확인 | 채용·심사(기존 ko-startup-incubator 예제)는 Verdict의 다기준 강점이 크지만 단일 질문 MVP와 거리가 있다 |
| **Q8** ✅ 결정 | P0를 허브와 분리해 먼저 머지할지 | 예. §12.1–12.3 + `threshold` + 사례 형식 확장(§4.1)을 첫 PR로. `inputSchema`(§4.2)는 P0의 두 번째 PR | 허브와 묶으면 리뷰 단위가 커진다 |

---

## 16. P3(공개 허브) 결정 (2026-11-08)

모두 기본 제안대로 확정했다.

| # | 결정 | 이유 |
| --- | --- | --- |
| H1 | 허브는 기존 API(Hono, Cloudflare Workers + D1)에 공개 경로와 공개 페이지를 붙인다 | 배포·DB·인증을 다시 만들지 않는다. Node 서버(`verdict serve`)에서도 같은 앱이 돈다 |
| H2 | 발행은 CLI `verdict publish`, 작성자 로그인은 GitHub 기기 인증(device flow). 웹 로그인·웹 발행은 후속 | 사례·실행이 로컬에 있으므로(K6) 발행도 로컬에서. 터미널에서 끝나는 흐름 |
| H3 | 공개 = rubric 버전 + 사례별로 고른 공개 사례 + 고른 실행의 요약 숫자. 발행 검사: criterion 1개, 라이선스 필수, binary는 `threshold` 필수. 미리보기 응답 = 저장될 문서 그대로 | A14·A16. 미리보기와 실제 발행이 다른 코드 경로를 타지 않게 |
| H4 | 공개 기준 가져오기는 공개 페이지의 복사용 명령(`verdict pull hub:…`, `verdict fork hub:…`). localhost 딥링크 없음 | 웹페이지가 로컬 서버를 여는 경로는 보안 부담에 비해 이득이 작다 |
| H5 | 팀 서버용 버전·실행 REST·SDK·MCP(테넌트 저장)는 P3에서 제외 — 호스팅 워크벤치와 함께 | 허브 발행에 필요 없고 범위를 두 배로 만든다. P3의 DB 작업은 `publications`만 |
| H6 | 운영 최소선: 작성자 철회, 관리자 내림, 크기·횟수 제한, 발행 전 개인정보 경고, 출처(레이블·실행 주체) 표시. 이용약관·개인정보처리방침은 공개 출시 전 운영자(사용자)가 정한다 | 공개 UGC 서비스의 최소 안전장치. 법적 문서는 코드 범위 밖 |
| H7 | 첫 콘텐츠: 고객 문의·문서 검토 단일 질문 카드 10~20개 초안을 만들고 레이블은 `ai_unreviewed`로 표시, 사람 검토 후 발행 | 파일럿의 첫 단계를 겸한다 |

사용자 준비물(코드 작업은 이것 없이 진행하고, 실제 로그인·배포 검증만 기다린다): GitHub OAuth App(client ID·secret → Worker secret), 배포 대상 Cloudflare 계정·도메인, 약관·개인정보처리방침.

### 16.1 공개 문서(publication)의 규칙 — P3-1 구현

- **발행자·이름**: `owner/slug`. owner는 발행한 테넌트의 공개 핸들(P3-2에서 GitHub 로그인으로 바뀐다). 같은 `owner/slug`에 새 버전을 계속 발행하면 버전 이력이 된다. 같은 버전을 다시 발행하면 기존 문서를 돌려준다.
- **무결성**: 서버가 받은 rubric을 다시 고정해 버전 id가 요청과 같은지 확인한다(내용과 이름이 어긋난 발행 거절).
- **사례**: 요청에 담긴 사례는 모두 `visibility: public`이어야 한다(실수로 비공개 사례를 싣는 것을 막는 두 번째 확인). 입력은 `text`·`json`·`url`만 — `file`은 로컬 경로가 새고 내용도 없으며, `image`는 MVP 밖.
- **실행 요약**: 실행은 서버가 다시 돌릴 수 없으므로 출처는 `author_reported`. 요청의 실행 기록과 agreement 보고서에서 **숫자만** 골라 담는다 — 지문, 분모, 기준별 일치, 레이블 출처 분포, 분할별 일치. 사례 id·평가 id·미리보기 문장은 버린다. 그 실행의 사례가 모두 공개 사례인지(`casesPublic`)를 함께 표시한다. 실행의 버전은 발행 버전과 같아야 한다 — 부모의 실적은 복사하지 않는다(V04).
- **CLI가 보내는 것(2026-11-10 수정)**: 서버가 버리는 것과 별개로, CLI는 처음부터 숫자만 보낸다. 이전 CLI는 실행 기록과 agreement 보고서를 통째로 보내서, 발행하지 않는 사례의 이름·레이블·평가 id가 요청에 실려 나갔다(저장되지는 않았다). 지금은 요청을 만드는 함수(`publicationRun`)가 조건과 건수를 필드 하나씩 옮긴다. `casesPublic` 판정에는 실행의 사례가 사례마다 한 항목씩 필요하므로, 함께 발행하는 사례는 id를 그대로 보내고 나머지는 무작위 값으로 바꿔 보낸다. 서버 코드는 바뀌지 않았고, 예전 CLI와 예전 서버 모두 그대로 동작한다.
- **부모**: 부모 버전이 공개돼 있으면 그 공개 문서를 가리키고, 아니면 "비공개 원본"으로만 표시한다(id도 싣지 않는다, V07).
- **막는 것**: judge의 `baseUrl`(내부 호스트명이 공개된다). 경고만 하는 것: 공개 사례 속 이메일·전화번호·주민등록번호 형태의 문자열, 사람이 검토하지 않은 레이블.
- **크기**: 사례 500건, 사례 입력 문자 20,000자, 요청 1 MB 이하.
- **읽기**: 공개 조회는 `publications`만 읽는다. 다른 테넌트 경로에는 손대지 않는다(K3). 철회는 `withdrawn_at`을 남기고 검색에서 빠진다.

### 16.2 GitHub 로그인과 발행 CLI — P3-2 구현

- **흐름**: CLI가 GitHub 기기 인증을 직접 수행한다(`GET /v1/hub/config`로 client id를 받음, scope 없음 — 공개 프로필만 읽는 토큰). 받은 토큰을 `POST /v1/hub/login`에 넘기면 허브가 GitHub에 주인을 묻고, `publishers`에 GitHub 숫자 id·로그인을 기록한 뒤 허브 API 키를 발급한다. **GitHub 토큰은 저장하지 않는다.**
- **client secret은 선택**: 기기 인증 자체에는 client id만 필요하다. `GITHUB_CLIENT_SECRET`을 두면 허브가 `POST /applications/{client_id}/token`으로 "이 앱이 발급한 토큰인지"까지 확인한다 — 다른 앱이 가진 사용자 토큰으로 대신 로그인하는 것을 막는다. 운영에서는 설정을 권장. 없으면 `GET /user`로 계정만 확인한다.
- **신원**: 테넌트는 `gh:<GitHub 숫자 id>`(아이디를 바꿔도 같은 사람), 공개 이름(owner)은 로그인할 때마다 갱신되는 GitHub 로그인. GitHub 로그인이 설정된 서버에서는 GitHub로 로그인한 계정만 발행할 수 있다(관리자가 만든 팀 키는 403). 설정이 없는 자체 서버는 기존처럼 테넌트 id로 발행.
- **ref 소유**: GitHub 로그인은 바뀔 수 있고 남이 이어받을 수 있다. `owner/slug`에 처음 발행한 계정이 아닌 다른 계정의 발행은 409 — 옛 이력에 끼어드는 것을 막는다.
- **로그아웃**: 로컬 자격 증명(`~/.config/verdict/hub.json`, 0600)을 지우고 허브의 키를 폐기한다(`DELETE /v1/hub/keys/:id`). CI는 `VERDICT_HUB_URL`·`VERDICT_HUB_KEY`.
- **`verdict publish`**: `--case`로 이름 붙인 사례만 보내고 그 사례만 public으로 표시(`--all-cases`로 전부). 실행은 `--run`으로 고른 것의 숫자만. 허브의 미리보기를 먼저 보여주고 확인을 묻는다(터미널이 없으면 `--yes` 필요, `--dry-run`은 미리보기에서 멈춤).
- **아직 확인 못 한 것**: 실제 GitHub OAuth App과 실제 GitHub 응답으로의 로그인. 테스트는 GitHub 응답을 흉내 낸 가짜로 했다.

### 16.3 공개 조회·페이지와 `pull`/`fork hub:` — P3-3 구현

- **공개 조회**(키 없음): `GET /v1/public/rubrics`(검색, 카드 `owner/slug`마다 살아 있는 최신 버전 하나), `GET /v1/public/rubrics/:owner/:slug?version=`(카드 + 버전 이력), `GET /v1/public/publications/:id`. 모두 `publications`만 읽고 `publicView`로 발행 테넌트를 뺀다(K3). 다른 경로의 인증은 그대로 — 테스트가 `/v1/publications`·`/v1/rubrics`·`/v1/evaluations`·`/v1/hub/me`가 키 없이 401인지 확인한다.
- **철회된 버전**: 검색에서 빠지고, 그 버전을 직접 요청하면 410 + "이미 pull·fork한 사본은 그 사람의 것으로 남는다"(V09). 버전 이력에는 철회 날짜와 함께 남는다. 최신 버전을 철회하면 카드는 그 전 살아 있는 버전으로 보인다.
- **페이지**: `/hub`(검색), `/hub/:owner/:slug`(상세). 서버가 그리는 HTML, 스크립트 없음, 엄격한 CSP(`default-src 'none'`), 작성자가 쓴 글은 전부 이스케이프. 상세 페이지: 질문·답·임계값, 계보(공개 부모는 링크, 비공개 부모는 "비공개 원본"), 실행 요약(작성자 보고, 누구나 재현 가능한지), 공개 사례, 버전 이력, rubric YAML, 복사용 명령 두 줄(H4).
- **`verdict pull hub:owner/slug[@rv_…]`**: rubric 파일(`<slug>.yaml`)과 공개 사례(`<slug>.cases.jsonl`, `visibility: public`)를 쓴다. **허브를 믿지 않는다**: 받은 rubric을 로컬에서 고정해 허브가 말한 버전 id와 같아야 하고, 쓴 파일을 다시 읽어도 같은 id여야 한다. 다르면 아무것도 쓰지 않는다. 키 없이 요청한다(`VERDICT_API_KEY`도 보내지 않음 — 이번에 허브 명령 전체에서 고침).
- **`verdict fork hub:…`**: 같은 검사 후 허브 버전을 로컬 저장소에 넣고 부모로 기록 — `version freeze`가 바뀐 점을, `verdict diff`가 부모와의 차이를 계산할 수 있다. 나중에 이 fork를 발행하면 부모의 공개 페이지에 링크된다.
- **출처·라이선스 보존(A18)**: 파일 첫 줄 주석과 `verdict.lock`의 `origin: { hub, ref, license }`.
- **아직 확인 못 한 것**: 실제 D1/Workers 배포에서의 페이지와 검색(테스트는 메모리 저장소). 검색은 제목·작성자·slug·분야의 부분 일치뿐 — 설명·질문 본문 검색은 사용량을 보고 정한다.

### 16.4 운영 최소선과 MCP 도구 — P3-4 구현

- **관리자 내림**(H6): `VERDICT_ADMIN_KEY`로 `GET /v1/admin/publications`(모든 발행, 철회 포함, 테넌트 표시), `POST …/:id/takedown { reason }`, `POST …/:id/restore`. 내림은 철회와 같은 `withdrawn_at`에 `takedown { reason, at }`을 더한다 — 검색에서 빠지고, 공개 조회는 410 `taken_down`과 **사유를 공개로** 보여준다(왜 사라졌는지 사용자가 알 수 있게). 작성자는 자기 목록에서 내림을 본다. 복구는 운영자가 내린 것만 — 작성자가 스스로 철회한 것은 되살리지 않는다(409). 관리자 경로는 이제 키 저장소 없이도 켜진다(키 관리 경로만 DB 필요).
- **횟수 제한**: 로그인은 클라이언트 주소당, 발행(미리보기 포함 — 같은 일을 한다)은 계정당, 공개 조회·페이지는 클라이언트 주소당. 기본 10 / 30 / 300회/분, 넘으면 429 + `Retry-After: 60`. 로그인 제한은 GitHub에 묻기 전에 건다. Workers에서는 Cloudflare Rate Limiting 바인딩(`HUB_LOGIN_LIMITER` 등)을 쓰면 isolate 사이에서 공유되고, 없으면 isolate별 메모리 카운터(하한일 뿐 보장 아님). 클라이언트 주소는 Workers의 `cf-connecting-ip`, Node 서버는 소켓 주소 — 누구나 쓸 수 있는 `X-Forwarded-For`는 믿지 않는다.
- **크기 제한**: P3-1의 사례 500건, 사례당 20,000자, 요청 1 MB가 그대로 적용된다(새 제한 없음).
- **MCP 도구**: `hub_search`, `hub_get`, `fork_rubric`(`VERDICT_HUB_URL` 또는 호출마다 `hub`). 키를 보내지 않는다. CLI와 같은 `verifyPublishedVersion`으로 받은 rubric이 허브가 말한 버전 id로 고정되는지 확인한 뒤에만 쓴다. `fork_rubric`은 카드를 이 서버의 rubric으로 저장하고(`metadata.forkedFrom`에 허브·ref·라이선스) 그 id로 바로 `evaluate`할 수 있다. 원격 모드에서는 연결된 팀 서버에 저장된다.
- **아직 확인 못 한 것**: Cloudflare Rate Limiting 바인딩의 실제 동작(테스트는 바인딩 모양을 흉내 낸 가짜). 이용약관·개인정보처리방침은 여전히 운영자 몫.

### 16.5 로컬 배포 리허설 (2026-11-08)

`wrangler dev --local`(wrangler 4.158) + 로컬 D1 + 횟수 제한 바인딩 시뮬레이션에서, 빌드된 CLI·MCP로 처음부터 끝까지 돌렸다: D1 마이그레이션 4개 적용 → 관리자 키로 테넌트 키 발급 → `verdict run` → `publish --dry-run`/발행(비공개 사례 문자열이 D1 문서에 없음을 SQL로 확인) → 키 없는 검색·상세·페이지(CSP), 테넌트 경로 401 → 다른 계정의 `pull`(같은 버전 id, `version verify` 통과)·`fork`·`freeze`·`diff`·fork 발행(부모 링크·changeKinds·fork 노트 표시) → 철회 410, 남의 것 철회 거부 → 관리자 내림(사유 공개, 작성자 목록 표시)·복구, 작성자 철회는 복구 거부 → 횟수 제한(조회 60/분, 미리보기 30/분/계정 → 429 + `Retry-After`) → MCP `hub_search`→`hub_get`→`fork_rubric`→`evaluate`.

- **찾아서 고친 것 1 (배포 차단)**: Workers 번들에 판단 모델 공급자가 하나도 등록되지 않았다. 패키지의 `"sideEffects": false` 때문에 esbuild가 공급자 등록용 부수 효과 import를 버렸다 — Jev 기본 judge가 전부 실패. 등록을 명시적 호출로 바꾸고, 부수 효과 import를 막는 테스트를 추가했다. Node 테스트는 번들을 거치지 않아 잡지 못했다.
- **찾아서 고친 것 2**: 실행 요약의 첫 숫자가 사례 전체 통과 일치(단일 질문 카드에서는 늘 0/0)였다 → 카드 질문의 일치(예: 3/4)로.
- **후속 과제**: ~~`policyHash`만 다른 비교에서 재채점을 권한다는 §X3 안내가 CLI에 없다~~ → §16.6에서 안내 대신 자동 재채점으로 구현. 실제 GitHub OAuth 로그인과 원격 D1·바인딩은 실제 계정이 있어야 확인 가능.

### 16.6 정책만 바뀐 비교의 자동 재채점 (X3 구현)

- **왜 안내가 아니라 자동인가**: 기존 `verdict rescore`는 *레이블*만 바꿔 재채점한다. 임계값 같은 *정책*을 바꾼 버전을 기존 답으로 다시 읽는 명령은 없었으므로 "rescore를 쓰라"는 안내는 틀린 안내가 된다. 그래서 `diff`가 판단 자체를 대신한다.
- **방법**: head가 base와 `judgmentHash`·`bindingHash`가 같고 `policyHash`만 다르며 사례 입력이 같으면, base run의 판단 모델 답(`raw.answer`)을 엔진에 재생해 head의 규칙(임계값, choice 값, 가중치, 집계, 낮은 확신도 처리 — 에스컬레이션 포함)으로 다시 계산한다. 같은 엔진 코드를 그대로 지나가므로 실제 실행과 어긋날 여지가 없다. 재생은 오프라인 `mock` 공급자의 내부 재생 모드로 하고, 저장할 때는 head rubric·원래 공급자·모델·rater를 복원하며 판단 호출은 0으로 기록한다. run에는 `rescoredFrom`.
- **거부(실제 실행으로 대체, 이유 표시)**: 질문·모델이 다름, 패널·사람·LLM·벤치마크 judge, checks, 답이 없는 사례(오류), 재생 중 질문이 녹화된 것과 다름. 모든 사례의 답을 먼저 확인하므로 거부 시 반쯤 저장된 평가가 남지 않는다. `--rerun`이면 항상 실제로 묻는다.
- **비교 종류**: `policy_change`(차이가 `policyHash`뿐) 추가 — "같은 답을 다른 규칙으로 읽은 결과". CLI·Markdown·`verdict watch` 비교 화면·Action 출력에 반영.

## 부록 A. 원 설계안 예시(상담원 연결)를 Verdict rubric으로

```yaml
name: 한국어 상담원 연결 요청 판별
language: ko
metadata: { domain: customer_support, locale: ko-KR, hub: { license: null, origin: original } }   # metaHash
inputSchema:                                   # judgmentHash (P0 신규)
  type: object
  required: [utterance]
  properties: { utterance: { type: string, minLength: 1 }, recent_context: { type: string } }
defaultJudge: { type: decision, provider: typesafe, model: jev-1.13 }   # 별칭 대신 구체 버전 권장
criteria:
  - id: wants_agent
    name: 고객이 현재 상담원과 직접 대화하려고 하는가
    description: |
      포함: 명시적인 연결 요청, 현재의 연결 의사를 나타내는 완곡한 표현.
      제외: 과거 상담 경험만 설명한 경우, 연결 의사 없는 막연한 불만, '상담원'이라는 단어만 등장.
    scale: { type: binary, labels: [no, yes] }
    anchors:
      yes: 명시적이거나 완곡한 현재의 상담원 연결 요청이다.
      no: 현재의 연결 요청이 없거나 과거 경험만 설명한다.
    threshold: 0.6                             # policyHash (P0 신규). 없으면 "기본 0.5"로 표시
aggregation: { method: mean, normalize: [0, 1] }
```

포함·제외 조건은 `description`에 들어가므로 질문으로 실제 전달된다(원 설계안 §13.2의 "조용히 누락 금지"를 구조로 보장). 메타데이터에만 적은 조건은 모델에 가지 않는다는 것을 편집기에서 구분해 보여준다.
