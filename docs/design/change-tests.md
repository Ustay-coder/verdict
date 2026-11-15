# 기준 변경 테스트(change tests) 설계 (v1.0)

- 상태: **1차 릴리스 범위(§3–§9)를 구현했다(2026-11-15).** §11은 설계만 했고 구현하지 않았다. 구현하며 확인한 것과 남은 제약은 §12에 적었다.
- 목표: 판단 기준(rubric)을 고쳤을 때 **같은 서류의 판단이 어떻게 달라졌는지**와 **그 변화가 미리 적어 둔 기대와 맞는지**를 근거와 함께 확인한다.
- 원칙: 점수가 변했다는 사실은 성공도 실패도 아니다. 의도한 하락은 정상이고, 유지되어야 할 점수의 상승은 문제일 수 있다. 화면의 "기대 일치(met)"는 **테스트에 적은 기대와 일치한다**는 뜻이지, 서류의 합격이나 기준의 정당성을 뜻하지 않는다.
- 표기: **[결정]** 채택한 기준. 이 문서의 결정은 `T1`부터 번호를 붙인다. **[확인]** 코드에서 확인한 현재 구조, **[신규]** 이 설계가 더하는 것, **[미확인]** 확인하지 못한 것.

---

## 1. 조사한 현재 구조

| 영역 | 현재 구조 [확인] | 이 기능에서 쓰는 방법 |
| --- | --- | --- |
| 판단 기준 | `Rubric`(`packages/core/src/schema/rubric.ts`): 항목(`criteria`, 안정적인 `id`), 척도(`scale` min/max), 선택지(`choices`)와 배점(`values`), 가중치, 집계(`aggregation`: 범위, `missing` 정책, 관문) | 그대로 쓴다. "점수를 정할 수 없음"을 표현하는 필드만 더한다(§4) |
| 기준 버전 | `freezeRubric` → 내용에서 계산한 `rv_…` id. `splitRubric`이 judgment(무엇을 묻는가)·policy(답을 어떻게 읽는가)·binding(어느 모델이 답하는가)·meta로 나누고 각각 해시를 둔다. 게시 상태는 관리 평면의 포인터(`control/`)이고 버전 자체는 불변이다 | 기준 스냅샷은 `RubricVersion` 그대로다. 실행 조건 비교에 세 해시를 쓴다 |
| 서류 | 서류 전용 저장소는 없다. 평가 입력(`Input`: text/json/file/url/image/youtube)이 곧 서류이고, 사례 묶음은 `DatasetVersion`(`dsv_…`, `casesHash`는 id와 입력으로 계산하며 파일은 내용 해시)이다. 추출본은 평가마다 `evaluation.evidence[].text`로 저장된다 | 서류 스냅샷은 `DatasetVersion`, 추출본은 각 평가의 `evidence`. 두 버전의 추출본이 다르면 화면에 표시한다 |
| 평가 호출 | `Engine.evaluate({ rubric, subject })` → `Evaluation`(항목별 `ratings`, `criteria`, `aggregate`). 판정자는 `decision`(확률 분포만 반환, 문장·인용 없음), `llm`(점수·선택, 사유, 인용 `quotes`), `human`, `benchmark`, `panel`. 판정자는 예외를 던지지 않고 `status: "error"` 평점을 남긴다 | 평가는 이 경로만 쓴다. 기대는 `evaluate`에 전달하지 않는다(§6) |
| 실행 기록 | `Run`(한 버전 × 한 데이터셋, 조건 지문 `RunFingerprint`), `compareRuns`(정답 레이블 일치 여부로 사례 분류) | `compareRuns`는 **레이블과의 일치**를 본다. 이 기능은 **기대와의 일치**를 보므로 별도 검증기를 둔다. 조건 지문은 `sentFingerprint`를 재사용한다 |
| 작업 상태 | 서버용 큐(`queue.ts`)는 평가 한 건의 재시도용이다. 로컬 작업대에는 작업 큐가 없다 | 비교 작업(trial)이 사례별 상태를 직접 기록한다(§7) |
| 저장소 | `Store`(평가), `VersionStore`(버전·데이터셋·실행)는 `MemoryStore`와 `FileStore`만 구현한다(`.verdict/` 아래 JSON 문서). DB 저장소(`packages/db`)는 `VersionStore`를 구현하지 않는다 | 같은 자리에 `ChangeStore`를 더한다. DB 스키마와 마이그레이션은 바꾸지 않는다 |
| 권한 | 모든 저장소 읽기는 테넌트 범위다(`scoped`). 로컬 작업대(`verdict watch`)는 인증이 없고 127.0.0.1에만 묶인다. 조직·역할은 이 저장소 밖(호스팅 빌드)이다 | 문서에 `tenantId`를 두고 읽기를 테넌트로 거른다. 화면의 쓰기 요청은 토큰과 Origin으로 막는다(§8) |
| 화면 | 이 저장소의 화면은 `verdict watch`(로컬 페이지: Evaluations, Compare runs) 하나다. 브라우저 코드는 타입 검사한 함수를 `toString()`으로 실어 보내며 번들러와 차트 도구가 없다. 화면 문구는 영어다 | 같은 방식으로 "Change tests" 화면을 더한다. 차트는 HTML/CSS로 그린다 |

[미확인] 호스팅 서비스의 웹 작업대와 조직 권한(저장소 밖)에 이 기능을 싣는 방법은 다루지 않았다. REST·SDK에는 버전·실행 API도 없으므로 이번에 더하지 않았다.

---

## 2. 범위

**구현한 흐름**: 기준 버전 선택 → 같은 서류 묶음 선택 → 변경 의도와 기대 정의 → 평가 실행 → 결과 비교 → 근거 확인 → 테스트 보관과 재검증.

세 질문 가운데 이번 구현이 답하는 부분은 다음과 같다. 화면의 안내 문구도 같은 구분을 쓴다.

| 질문 | 이번에 확인하는 것 | 별도 시험이 필요한 것(§11) |
| --- | --- | --- |
| 무엇이 바뀌어도 판단은 유지되어야 하는가 | 기준을 고쳐도 영향받지 않아야 할 사례가 유지되는지 | 표현·서식·순서를 바꾼 입력에서도 유지되는지 |
| 무엇이 바뀌면 판단도 달라져야 하는가 | 기준 개정으로 영향받아야 할 사례가 의도한 방향으로 변하는지 | 기준을 고정하고 사실을 바꿨을 때의 반응 |
| 무엇이 없으면 보류하거나 물어야 하는가 | 정보가 부족한 기존 서류에서 새 기준이 보류하거나 질문하는지 | 정보를 하나씩 제거했을 때 필요한 경우에만 보류하는지 |

---

## 3. 결정 기록

| # | 결정 | 고려한 다른 선택지와 비용 |
| --- | --- | --- |
| **T1** | 기능을 **로컬 작업대**(core + CLI + `verdict watch`)에 둔다 | REST에 두면 서버가 서류를 보관해야 한다. 지금 서버는 사례를 보지 않는 것이 원칙이고(control-plane.md) 버전·실행 저장도 로컬뿐이다 |
| **T2** | "점수를 정할 수 없음"은 **선택지 항목의 `unresolved` 표시**로 기준에 적는다. 그런 선택지는 배점(`values`)을 갖지 않고, 고르면 항목 점수가 없다 | 판정자가 자유 문장으로 "모르겠다"고 답하게 하면 decision 모델(확률만 반환)이 쓸 수 없고 검증도 문장 해석에 기대게 된다 |
| **T3** | 추가 질문은 기준에 적힌 **정보 필드 id + 질문 문장**(템플릿)이다. 검증은 필드 id로 한다 | 질문 문장을 완전 일치로 비교하면 표현만 달라도 실패한다. 판정자가 쓴 자유 질문은 지금 만드는 경로가 없다(§11.5) |
| **T4** | 상태는 세 층으로 나눠 따로 저장하고 따로 센다: 실행(execution), 판단(judgment), 검증(verification) | 한 상태값에 섞으면 "추가 정보 필요"가 실행 실패처럼, 실행 실패가 불일치처럼 보인다 |
| **T5** | 정할 수 없는 점수는 `null`이다. 0으로 바꾸지 않고 변화량도 계산하지 않는다. 총점은 필수 항목이 모두 채점된 경우에만 확정값으로 본다 | 집계의 `missing: exclude`(기본)는 나머지 항목만으로 총점을 내는데, 이것을 확정 총점으로 쓰면 질문이 필요한 서류가 점수를 가진 것처럼 보인다. 그 숫자는 "잠정"으로 따로 보여 주고 적용된 `missing` 정책을 표시한다 |
| **T6** | 기대는 사례마다 여러 개 둘 수 있고 **기대별로 판정**한다. 사례 판정은 불일치 > 확인 필요 > 비교 불가 > 일치 순으로 정한다. 일부만 일치하면 사례는 일치가 아니다 | 일치가 하나라도 있으면 통과로 하면 가려진다 |
| **T7** | 변화량 기대는 테스트의 **기준점 버전**에 묶인다. 후보 버전이 바뀌어도 기준점은 그대로다. 기준점을 바꾸려면 기대를 다시 확인해 **새 개정(revision)**으로 저장해야 한다 | 직전 버전 대비로 하면 "v1보다 4점 하락"이 v3에서 "v2보다 4점 더 하락"이 된다 |
| **T8** | 기대 개정과 검증 기록은 **추가만** 한다. 기대를 고치면 새 개정, 다시 검증하면 새 검증 기록이 생기고 이전 판정은 남는다. 기대만 바뀐 재검증은 판정자를 부르지 않고 `reverify`로 표시한다 | 덮어쓰면 "언제 무엇을 기대했는가"를 잃는다 |
| **T9** | 재실행·재시도는 **새 trial id**를 만든다. 재시도는 성공한 사례의 평가를 재사용하고 재사용했다고 적는다. 기준점 결과도 같은 방식으로 재사용할 수 있다(기본) | 실패한 사례만 같은 trial 안에서 덮어쓰면 원래 기록이 사라진다 |
| **T10** | 평가 엔진에는 기준과 서류만 넘긴다. 기대·다른 버전의 결과는 넘기지 않는다. 검증은 저장된 평가를 읽는 순수 함수다 | — |
| **T11** | 점수 비교는 저장된 값으로 한다(화면 반올림 전). 부동소수 오차는 `1e-9`만 허용한다. 기본값은 허용 오차 0, 최소 변화량 "0보다 큰 변화"이며 화면과 문서에 적는다 | — |
| **T12** | 항목 대응은 **id**로 한다. id가 바뀐 항목은 테스트의 `mapping`에 명시한다. 대응이 없는데 이름이 같은 항목이 있으면 "확인 필요", 없으면 "비교 불가"다 | 이름으로 자동 대응하면 뜻이 달라진 항목을 같은 것으로 본다 |
| **T13** | 척도(최소·최대)가 다른 항목, 출력 범위가 다른 총점은 변화량을 계산하지 않는다(비교 불가). 원점수와 만점을 양쪽 다 보여 주고, 정규화 값은 보조로만 표시한다 | 백분율로 환산해 빼면 뜻이 다른 점수를 비교하게 된다 |
| **T14** | 저장된 평가는 읽을 때 **출력 검증**을 거친다: 모르는 항목 id, 범위 밖 점수, 정할 수 없다면서 점수가 있는 항목, 질문이 필요한데 확정된 총점 등. 걸리면 그 사례는 `invalid_output`(실행층 오류)이고 점수로 쓰지 않는다 | 조용히 고치면 정상 완료처럼 보인다 |
| **T15** | 인용은 서류 추출본에서 **찾은 경우에만** 위치와 함께 근거로 연결한다. 못 찾은 인용은 "원문에서 찾지 못함"으로 표시하고 연결하지 않는다. 판정자가 인용을 주지 않으면(decision 모델) 그렇게 적는다 | — |
| **T16** | 데모는 **mock 제공자에 대본(`options.script`)**을 주어 만든다. 대본으로 답한 평가는 화면에서 "scripted mock"으로 표시한다 | 데모용 평가 경로를 따로 만들면 실제 경로를 시연하지 못한다 |
| **T17** | 화면의 쓰기 요청은 서버가 시작할 때 만든 토큰이 있어야 하고, 루프백이 아닌 주소에 묶이면 쓰기를 끈다 | 브라우저의 다른 페이지가 127.0.0.1로 요청을 보낼 수 있다 |

---

## 4. 기준 스키마 확장 [신규]

```yaml
criteria:
  - id: customer_validation
    name: 고객 검증
    scale: { type: numeric, min: 0, max: 10 }
    choices:
      paid_3_or_more: 유료 고객이 3곳 이상이다
      customers_3_paid_under_3: 전체 고객은 3곳 이상이고, 유료 고객이 3곳 미만임이 확인된다
      under_3: 전체 고객이 3곳 미만이다
      undetermined: 적힌 정보로는 위 중 어느 것인지 정할 수 없다
    values: { paid_3_or_more: 10, customers_3_paid_under_3: 6, under_3: 0 }
    unresolved:
      undetermined:
        state: needs_info            # 또는 abstain
        requests:
          - field: customer_payment_status
            question: 고객 3곳 중 유료 계약 고객은 몇 곳이며, 무료 실증 고객은 몇 곳인가요?
```

- `unresolved`의 키는 `choices`의 선택지여야 하고 `values`에 있으면 안 된다. `values`는 나머지 선택지를 모두 덮어야 한다. `needs_info`는 `requests`가 하나 이상 있어야 한다.
- 판정자가 그 선택지를 고르면: 평점은 `choice`만 있고 점수가 없다. 항목 결과에 `unresolved { state, option, requests, reason }`가 붙고 `score`·`normalized`는 없다. 집계 결과에 `unresolved: [항목 id]`가 붙고 `partial: true`(잠정)다. 나머지는 기존 `missing` 정책대로다.
- `unresolved`는 답을 **읽는 방법**이므로 policy 해시에 들어간다(선택지 설명은 judgment). 다만 **어느 선택지가 '정할 수 없음'인지**(키 목록)는 judgment에도 들어간다: `llm` 판정자의 지시문이 그 유무에 따라 달라지기 때문이다(`unresolved`가 있으면 "모르면 가장 낮은 점수" 대신 "그 선택지를 고르고 추측하지 말라"고 지시한다).
- 낮은 확신으로 사람에게 넘어간 항목(`onLowConfidence: human`, 기존 기능)은 판단층에서 "판단 보류(abstained)"로 읽는다.
- `unresolved`가 없는 기준의 동작은 바뀌지 않는다(`pnpm smoke` 골든 유지).

---

## 5. 데이터 구조 [신규]

`packages/core/src/change/`. 저장은 `ChangeStore`(`MemoryStore`, `FileStore`: `.verdict/change-tests/`, `.verdict/change-trials/`).

```
ChangeTest (ct_…)                       보관하는 테스트
  name, intent                          변경 의도(작성자가 쓴 문장)
  datasetVersionId, casesHash           서류 스냅샷
  mapping?                              후보 항목 id → 기준점 항목 id (null = 새 항목)
  revisions[]                           기대 개정, 추가만
    revision, baselineVersionId         이 개정의 기준점 버전
    cases: { caseId: Expectation[] }
    note?, createdAt, createdBy?
  followUps[]                           후속 확인으로 표시한 사례
  history[]                             만든 사람·시각·무엇을 했는지
  demo?                                 가상 데이터와 대본 판정자로 만든 테스트

Trial (trial_…)                         비교 작업 한 번
  testId, revision                      시작할 때의 기대 개정
  baseline, candidate: Side
    versionId
    cases[]: { caseId, status, evaluationId?, error?, reusedFrom?, startedAt?, finishedAt? }
  status                                queued | running | completed | partial | failed | cancelled
  origin                                new | retry(of) | rerun(of)
  runner?                               실행 중인 프로세스(pid). 죽은 프로세스가 남긴 trial을 가려내는 데 쓴다
  verifications[]                       검증 기록, 추가만
    id, revision, kind(after_run | reverify), createdAt
    cases: { caseId: { status, expectations[]: { expectationId, status, code, message, observed } } }
    summary
```

기준 스냅샷은 `RubricVersion`, 평가 결과는 `Evaluation`(자신의 기준 사본과 추출본을 가진다)을 그대로 쓴다. 완료된 평가와 버전은 덮어쓰지 않는다.

### 5.1 기대 유형

| 유형 | 설정 | 일치 조건 (Δ = 새 점수 − 기준점 점수) |
| --- | --- | --- |
| `hold` 점수 유지 | 대상, `tolerance`(기본 0) | \|Δ\| ≤ tolerance |
| `increase` 점수 상승 | 대상, `by`(기본: 0보다 큰 변화) | Δ > 0 이고 Δ ≥ by |
| `decrease` 점수 하락 | 대상, `by` | −Δ > 0 이고 −Δ ≥ by |
| `not_lower` 낮아지지 않음 | 대상, `tolerance` | Δ ≥ −tolerance |
| `not_higher` 높아지지 않음 | 대상, `tolerance` | Δ ≤ tolerance |
| `range` 점수 범위 | 대상, `min`, `max` | min ≤ 새 점수 ≤ max |
| `state` 판단 상태 | 대상, `scored` \| `needs_info` \| `abstained` | 새 판단 상태가 같다 |
| `asks_for` 추가 정보 요청 | 항목, `fields[]` | 새 판단이 `needs_info`이고 요청한 필드에 모두 들어 있으며 점수가 없다 |

대상은 총점(`criterion` 생략) 또는 항목(`criterion: id`)이다. `state`를 총점에 걸면 사례 전체의 판단 상태를 본다.

### 5.2 판정 규칙

1. 기대가 없는 사례는 `unverified`다.
2. 필요한 쪽의 평가가 실패·취소·출력 오류면 그 기대는 `incomparable`이다(사유 코드 포함).
3. 변화량 기대에서 어느 쪽 점수가 `null`이면 `incomparable`이다. 같은 사례의 `state`·`asks_for` 기대는 따로 판정한다.
4. 척도나 출력 범위가 다르면 변화량 기대는 `incomparable`이다. 총점의 항목 구성·가중치가 달라졌으면 판정은 하되 주의 문구를 붙인다.
5. 대상 항목이 후보에 없으면 `incomparable`, 기준점에 대응 항목이 없는데 이름이 같은 항목이 있으면 `needs_review`다.
6. `asks_for`에서 요청에 질문 문장이 없으면 `needs_review`다.
7. 사례 판정: `unmet` > `needs_review` > `incomparable` > `met`. 요약의 일치율 분모는 `met + unmet`(검증 가능한 사례)이고 전체 사례 수와 제외 사유를 함께 적는다.

---

## 6. 평가와 검증의 분리

```
서류 스냅샷 × 기준 스냅샷 × 실행 설정 ──(Engine.evaluate)──▶ Evaluation ──▶ observe ──▶ verify(기대) ──▶ Verification
                                                              (기대를 모른다)      (출력 검증)   (순수 함수)
```

- `observe`: 저장된 평가를 판단층 관측값으로 읽는다. 항목별 점수(원점수·범위·정규화), 판단 상태, 요청, 사유, 인용과 위치. 출력 검증(T14)을 여기서 한다.
- `verify`: 기대 × 기준점 관측 × 후보 관측 → 기대별 결과. 판정자도 저장소도 부르지 않는다.
- 실행 조건: 두 쪽의 binding 해시, 실제로 답한 모델, 질문 형식 버전, 사례별 추출본 해시를 비교한다. 다르면 "기준만 바뀐 결과"라고 표시하지 않고 다른 항목을 나열한다.
- 같은 설정으로 다시 실행해도 답이 같다는 보장은 없다. 재실행은 새 trial로 남기고, 한 번의 실행에서 변동 범위를 만들어 내지 않는다.

---

## 7. 실행

- `createTrial`: 사례 × 두 버전의 작업 목록을 `queued`로 저장한다. 같은 테스트·후보로 진행 중인 trial이 있으면 새로 만들지 않고 그것을 돌려준다(중복 클릭).
- `executeTrial`: 사례를 동시성 제한 안에서 평가하고 한 건이 끝날 때마다 trial을 저장한다(진행률, 부분 결과). 취소 신호가 오면 남은 작업을 `cancelled`로 둔다. 끝나면 검증 기록을 하나 더한다.
- trial 상태: 모두 완료 `completed`, 일부 실패 `partial`, 후보 쪽이 모두 실패 `failed`, 취소 `cancelled`.
- 예상 평가 건수 = 서류 수 × (후보 1 + 기준점 1 또는 재사용 시 0). 반복 실행은 이번 범위가 아니다. 비용은 믿을 만한 계산 근거가 없어 표시하지 않는다.

---

## 8. 화면 (`verdict watch` → Change tests)

| 화면 | 내용 |
| --- | --- |
| 목록 | 보관한 테스트, 최근 trial의 검증 집계, 새 테스트, 데모 만들기 |
| 설정 | 기준점·후보 버전 선택, 서류 묶음 선택, 변경 의도, 두 기준을 나란히 놓은 차이(구조 변경 목록 + 줄 단위), 사례별 기대 편집기, 판정자 연결 상태, 예상 평가 건수, 실행 |
| 결과 | 조건 배너(같은 조건인지, 무엇이 다른지), 세 층의 집계(분모 표시), 변화량 차트, 사례 비교표(정렬·필터), 사례 상세(기준 원문, 이전·새 점수와 상태, 사유, 인용과 원문 위치, 기대별 판정 이유, 추가 질문), 검증 기록 선택, 재검증·재시도·재실행·취소, 후속 확인 표시 |

- 차트는 0을 가운데 둔 막대다. 방향은 무늬와 부호로, 검증 결과는 아이콘과 글자로 표시한다(색만 쓰지 않는다). 변화량이 없는 사례는 0 위치에 두지 않고 차트 아래에 사유와 함께 따로 적는다.
- 차트와 표는 같은 선택 상태를 쓴다. 어느 쪽을 눌러도 같은 상세가 열린다.
- 넓은 화면은 표와 상세를 나란히, 좁은 화면은 상세를 표 아래에 이전 → 새 순서로 쌓는다.
- 항목이 둘 이상이면 사례 × 항목 변화 표를 더 보여 준다.

쓰기 요청은 `x-verdict-watch` 토큰이 맞아야 하고 Origin이 있으면 같은 출처여야 한다. `--host`가 루프백이 아니면 쓰기를 끈다.

---

## 9. 데모와 검증 사례

`verdict change-test demo`가 가상 데이터로 테스트 두 개를 만든다. 서류와 응답은 모두 지어낸 것이며 화면에 "demo"와 "scripted mock"으로 표시된다.

1. **의도대로 답하는 대본**: A 10→10(유지), B 10→6(4점 하락), C 10→추가 정보 필요(유료 여부 질문). 세 사례 모두 기대 일치.
2. **틀리게 답하는 대본**: B에 10점(하락 기대 불일치), C에 "채점 완료, 0점, 질문 없음"(질문 기대 불일치), D 기대 미설정(미검증), E 판정자 호출 실패(실행 실패), F 원문에 없는 인용(연결하지 않음), G 모순된 저장 결과("추가 정보 필요"인데 확정 점수 0 → 출력 검증 오류). G는 어떤 판정자도 이렇게 답하지 않으므로, 데모 전용 래퍼(`contradicting`)가 저장된 평가를 고쳐 쓴다. 고장 난 연동을 흉내 낸 것이며 화면에는 demo로 표시된다.

만점 변경, 항목 삭제·대응 불명, 부분 완료, 취소, 재시도, 테넌트 범위는 자동 테스트로 검증한다(`packages/core/test/change-*.test.ts`, `packages/cli/test/change.test.ts`).

---

## 10. 구현 위치

| 위치 | 내용 |
| --- | --- |
| `packages/core/src/schema/rubric.ts`, `schema/evaluation.ts`, `aggregate/index.ts`, `versions/split.ts` | `unresolved` 스키마와 집계 |
| `packages/core/src/judges/mock-script.ts`, `decision/providers.ts`, `llm/providers.ts` | mock 대본 |
| `packages/core/src/judges/llm/{prompt,judge}.ts` | `unresolved`가 있는 항목의 지시문, 선택형 평점에 제공자·모델 기록 |
| `packages/core/src/change/` | `types`(타입과 기대 스키마), `observe`(관측·출력 검증), `evidence`(인용 위치), `criteria`(항목 대응·구조 차이), `verify`(검증·집계·변화량), `tests`(테스트·개정·후속 확인), `trial`(실행·재검증·조건), `store`(저장 인터페이스), `requests`(쓰기 요청 스키마), `demo`(데모) |
| `packages/core/src/store/index.ts` | `ChangeStore` 구현(메모리, 파일) |
| `packages/cli/src/commands/change-test.ts` | `verdict change-test demo | create | run | expect | reverify | list` |
| `packages/cli/src/watch/change-{state,server,client,results,app}.ts`, `watch/page.ts`, `commands/watch.ts` | 화면 데이터, 쓰기 API, 브라우저 코드(설정·결과·제어), 스타일, 서버 연결 |
| `website/guide/change-tests.md`, `website/reference/{rubric,cli}.md` | 사용자 문서 |

---

## 11. 후속 확장 (설계만, 미구현)

네 시험 모두 **기준을 고정**하고 서류나 실행을 바꾼다. 지금 구조에서 trial의 두 쪽은 "버전이 다르고 서류가 같다". 확장은 한 쪽을 `(versionId, datasetVersionId, caseId)`로 일반화해 "버전이 같고 서류가 다르다"를 표현하고, 사례 쌍을 `variantOf`로 잇는다. 기대 유형과 검증기는 그대로 쓴다.

| 순서 | 시험 | 방법 | 필요한 추가 |
| --- | --- | --- | --- |
| 11.1 | 반복 실행 | 같은 서류·기준·설정으로 n번 실행해 관측한 결과를 나란히 보여 준다 | trial에 `repeat`, 사례별 평가 배열. 관측한 값만 표시(범위·확률 추정 없음) |
| 11.2 | 판단 유지 | 사실은 두고 표현·서식·순서만 바꾼 변형본에 `hold`를 건다 | 변형본 데이터셋, `variantOf`, 바꾼 조건·유지할 사실 기록 |
| 11.3 | 판단 변화 | 사실 하나를 바꾼 변형본에 `increase`/`decrease`/`range`를 건다 | 같음 |
| 11.4 | 정보 부족 | 정보 하나를 지운 변형본에 `asks_for`/`state`를 건다. 판단에 필요 없는 정보를 지웠을 때는 `hold`를 건다 | 같음 |
| 11.5 | 자유 질문 | `llm` 판정자가 쓴 질문을 받는다 | 요청에 `source: judge`, 검증은 `needs_review` |

변형본을 AI가 만들 수 있지만 "뜻이 같다"는 AI의 주장만으로 보존을 확정하지 않는다. 생성한 변형본과 기대는 사람이 확인한 뒤에야 검증의 기준으로 쓴다(`confirmedBy`가 없으면 `unverified`).

---

## 12. 구현하며 정한 가정과 남은 제약

**가정**
- 화면 문구는 저장소의 기존 화면에 맞춰 영어로 썼다. 상태 이름의 대응: met = 기대 일치, not met = 기대 불일치, not verified = 미검증, needs review = 확인 필요, not comparable = 비교 불가, needs information = 추가 정보 필요, abstained = 판단 보류.
- 실행 실패·취소·출력 오류로 판정할 수 없는 기대는 `incomparable`(비교 불가)로 두고 사유 코드로 구분한다(`candidate_failed`, `candidate_invalid_output` 등). 별도의 검증 상태를 더 만들지 않았다.
- 점수 기대(변화량·범위)의 대상 점수가 열려 있으면 불일치가 아니라 비교 불가다. "채점되어야 한다"를 확인하려면 `state: scored` 기대를 함께 건다.
- 실행 설정은 기준 버전의 binding(제공자·모델·옵션)이다. 두 버전의 binding이 다르면 조건 배너가 알린다. `llm` 판정자는 제공자가 응답 모델을 확인해 주지 않으므로 mock이 아니면 "같은 모델인지 확인할 수 없음"으로 표시한다.
- trial은 `Run` 기록(버전 × 데이터셋 전체)을 만들지 않는다. `Run`은 모든 사례의 평가가 있어야 하고 trial은 사례별 실패·재시도를 다루기 때문이다. 조건 비교에는 같은 `sentFingerprint`를 쓴다.

**구현하지 않은 것**
- §11의 네 시험과 자유 질문.
- AI가 변경 의도에서 기대를 제안하는 기능(선택 사항). 기대는 사람이 쓴 것만 있다.
- 비용 추정. 믿을 만한 가격 자료가 없어 평가 건수만 보여 준다.
- REST·SDK·MCP와 DB 저장소(`packages/db`). 버전·실행과 마찬가지로 로컬 작업대에만 있다. 조직·역할 권한은 호스팅 빌드의 일이다.
- 순위·선정 결과 비교. 변경 테스트에는 순위 개념이 없다(`verdict compare`의 리더보드와 연결하지 않았다).
- 화면에서 파일(PDF 등) 올리기. 파일 서류는 사례 파일과 `verdict change-test create`로 넣는다.

**외부 연결 상태**
- 실제 제공자 호출은 기존 판정자 경로 그대로다(`decision`: typesafe·cloudflare·openai·gemini 등, `llm`: anthropic·openai 등). 이 기능의 검증은 mock 제공자와 주입한 `fetch`(`llm` `http` 제공자)로만 했고, 실제 모델 키로 호출해 보지는 않았다. `unresolved` 선택지를 실제 모델이 얼마나 정확히 고르는지는 확인하지 못했다.
