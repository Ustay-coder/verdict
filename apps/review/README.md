# Verdict 서류 검토 (`apps/review`)

자연어로 적은 요건에 따라 여러 서류(PDF·스캔 PDF·이미지·텍스트)를 한 건씩 검토하고 `충족` / `미충족` / `확인 필요`로 분류하는 웹 서비스.
판정은 이 저장소의 Verdict 엔진(`@verdict-ai/core`)이 한다. 기획·UI·명세: [`docs/verdict-review/`](../../docs/verdict-review/).

```
apps/review/
  server/src/   Node 서버(Hono): 업로드·추출(OCR)·요건 해석·빠른 판정(fast.ts)·사실 대조·Verdict 실행·순차 실행기·SSE
  server/test/  오프라인 테스트(가짜 LLM, 가짜 Jev fetch) — 100건 상태·복구 포함
  web/src/      React + Tailwind + shadcn/ui. main.tsx = 운영 화면, dev/ = 개발용 UI 시안(예시 데이터)
  fixtures/     검증용 예시 PDF(가상 회사, 스캔본·손상 파일 포함). 운영 화면은 쓰지 않음
  scripts/      make-fixtures / live-check(실연동) / e2e(브라우저) / screens(시안 스크린샷)
```

## 실행

```bash
pnpm install
```

```bash
pnpm build
```

```bash
pnpm --filter @verdict-ai/review-app build
```

```bash
TYPESAFE_API_KEY=... OPENAI_API_KEY=... pnpm --filter @verdict-ai/review-app start
```

`http://localhost:8790` 을 연다. 개발 중에는 서버(`dev:server`)와 `pnpm --filter @verdict-ai/review-app dev:web`(Vite, `/api`를 8790으로 프록시)을 함께 띄운다.
Claude Code 클라우드 세션에서는 Node 명령 앞에 `NODE_USE_ENV_PROXY=1` 을 붙인다.

| 환경 변수 | 기본값 | 의미 |
| --- | --- | --- |
| `PORT` | `8790` | |
| `REVIEW_DATA_DIR` | `./data` | `review.sqlite`(실행 상태), `verdict.sqlite`(Verdict 평가), `files/`(원본) |
| `VERDICT_API_KEYS` | 미설정 = 단일 tenant `default` | `키:tenant,…`. 브라우저는 `POST /api/session {apiKey}`로 httpOnly 쿠키를 받는다 |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL` | | 요건 해석·사실 추출·OCR(구조화 출력, 비전) |
| `REVIEW_MODE` | `hybrid` | `hybrid` = 문서마다 Jev 한 요청으로 빠른 판정, 확정 못 한 문서만 LLM 사실 추출로. `full` = 항상 LLM 사실 추출 |
| `REVIEW_FAST_MIN_CONFIDENCE` | `0.8` | 빠른 판정에서 고른 결과의 확률이 이보다 낮으면 LLM 사실 추출로 넘긴다 |
| `REVIEW_LLM_MODEL` / `REVIEW_OCR_MODEL` | `gpt-5.4-mini` | |
| `REVIEW_TEXT_JUDGE_PROVIDER` / `REVIEW_TEXT_JUDGE_MODEL` | `typesafe` / `jev-latest` | 서술형 요건을 판정하는 Verdict decision judge. 해당 provider 키 필요(`TYPESAFE_API_KEY` 등) |
| `REVIEW_SERVE_PROTOTYPE` | 미설정 | `1`이면 개발용 시안 `/prototype.html`도 내보낸다 |

## 확인

```bash
pnpm --filter @verdict-ai/review-app typecheck
```

```bash
pnpm --filter @verdict-ai/review-app test
```

```bash
NODE_USE_ENV_PROXY=1 node apps/review/scripts/live-check.mjs
```

```bash
node apps/review/scripts/e2e.mjs http://localhost:8790
```

`live-check`와 `e2e`는 실제 모델을 호출한다(키 필요). `e2e`는 스크린샷을 `docs/verdict-review/screens/`에 남긴다.
