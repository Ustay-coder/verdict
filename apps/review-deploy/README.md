# 서류 검토 서비스 배포 (1단계: 온라인 테스트)

`apps/review`의 Node 서버를 **Cloudflare Containers** 1대에 그대로 올리고, 앞단 Worker와 **Cloudflare Access**로 지정한 사람만 들어오게 한다.
테스트용 배포다. 데이터 보존(D1·R2로 옮기기)은 2단계에서 다룬다.

```
브라우저 ──▶ review.verdict-ai.dev ──▶ Cloudflare Access(이메일 일회용 코드)
                                       └▶ 앞단 Worker(src/index.ts): Access JWT 검증 → Durable Object "main"
                                            └▶ 컨테이너 1대(apps/review/Dockerfile, standard-1): Node 서버 :8080, SQLite·파일은 /data
```

| 파일 | 역할 |
| --- | --- |
| `src/edge.ts` | Access JWT 검증, 컨테이너로 보낼 요청(검증된 사용자만 `x-verdict-user`), 컨테이너 환경 변수. 테스트: `test/edge.test.ts` |
| `src/index.ts` | Worker 진입점과 `ReviewContainer`(Durable Object). 컨테이너 시작·준비 확인·전달, 검토 중이면 5분마다 알람으로 꺼짐 방지 |
| `wrangler.jsonc` | 컨테이너(`durable_object` 스케줄링), Durable Object, 도메인, 설정 값 |
| `../review/Dockerfile` | 서버 이미지. 빌드 컨텍스트는 저장소 루트, 제외 목록은 `Dockerfile.dockerignore` |

## 배포 전에 정할 것과 필요한 권한

1. **Docker가 있는 곳**에서 배포한다. `wrangler deploy`가 Dockerfile로 이미지를 빌드해 Cloudflare 레지스트리에 올린다(`--dry-run`도 Docker가 필요하다).
2. **Cloudflare API 토큰 권한**(대시보드 → 내 프로필 → API 토큰):
   - 계정: Workers Scripts 편집, **Containers 편집**, Workers Observability(선택)
   - 영역 `verdict-ai.dev`: Workers Routes 편집, DNS 편집(사용자 지정 도메인 연결)
   - Access 앱을 API로 만들 경우만: Access: Apps and Policies 편집(대시보드에서 직접 만들면 불필요)
3. **모델 키**: 실제 OpenAI API 키, TypeSafe(Jev) API 키.

## 절차

### 1. Access 애플리케이션 만들기 (대시보드, 배포 전에)
Zero Trust → Access controls → Applications → **Add an application → Self-hosted**
- 도메인: `review.verdict-ai.dev`
- 정책 1 (Allow): Include → Emails → 사용할 사람의 이메일(본인, 함께 볼 분)
- 정책 2 (Service Auth, 자동 검증용): Include → Service Token → 아래에서 만든 토큰
- 저장 후 **Application Audience (AUD) Tag**를 복사한다. 팀 도메인은 `https://<팀이름>.cloudflareaccess.com`.

자동 검증용 서비스 토큰: Access controls → Service credentials → Service Tokens → Create. Client ID·Secret은 한 번만 보이므로 보관한다.

### 2. 설정 값 넣기
`wrangler.jsonc`의 `vars`에서 `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`를 실제 값으로 바꾼다(비밀이 아니다).
값이 맞지 않으면 Worker는 **모든 요청을 거부**한다(열린 채로 배포되지 않는다).

### 3. 비밀 넣기
```bash
cd apps/review-deploy
```
```bash
npx wrangler secret put OPENAI_API_KEY
```
```bash
npx wrangler secret put TYPESAFE_API_KEY
```
처음 배포 전이라 Worker가 없다고 나오면, 4단계 배포 후 다시 넣고 한 번 더 배포한다.

### 4. 배포
```bash
pnpm install
```
```bash
pnpm --filter @verdict-ai/review-deploy deploy
```
`workers.dev`·미리보기 주소는 꺼져 있다(Access 우회 방지). 주소는 `review.verdict-ai.dev` 하나다.

### 5. 확인
- 브라우저로 `https://review.verdict-ai.dev` → Access 로그인(이메일 코드) → 요건 입력 화면.
- Access 없이 Worker에 닿는 경로가 없는지: 다른 이메일로 로그인 거부, `curl -I https://review.verdict-ai.dev`가 Access 로그인으로 넘어가는지.
- 기능 전체(브라우저, 실제 모델 호출):
```bash
REVIEW_ACCESS_CLIENT_ID=… REVIEW_ACCESS_CLIENT_SECRET=… node apps/review/scripts/e2e.mjs https://review.verdict-ai.dev
```
- 처리 시간(가상 서류 100건, 실제 모델 호출 비용 발생):
```bash
REVIEW_BASE_URL=https://review.verdict-ai.dev REVIEW_ACCESS_CLIENT_ID=… REVIEW_ACCESS_CLIENT_SECRET=… node apps/review/scripts/bench.mjs 100 0.1
```

## 알려진 한계 (1단계)
- **데이터가 지워진다.** 컨테이너 디스크(`/data`: 올린 서류, 결과, Verdict 평가)는 재배포, 플랫폼 재시작, 30분 무활동 후 정지 때 사라진다. 실제 서류는 이 점을 알고 올린다.
- 검토가 진행 중이면 알람이 컨테이너를 유지한다. 재배포·재시작 때는 진행 중인 문서까지 저장하고 종료하지만(SIGTERM 처리), 새 인스턴스는 빈 디스크로 시작한다.
- 컨테이너는 1대다(순차 실행기와 SQLite). 동시 사용자는 같은 작업 공간(tenant `default`)을 함께 본다.
- 한 실행당 서류 수 상한: `REVIEW_MAX_FILES_PER_RUN`(기본 200).

## 되돌리기
- 이전 버전으로: `npx wrangler rollback`
- 서비스 내리기: 대시보드에서 Worker `verdict-review`의 도메인을 제거하거나 Worker를 삭제한다(컨테이너와 데이터도 함께 사라진다).
