# syntax=docker/dockerfile:1
# 서류 검토 서비스 이미지(linux/amd64). 빌드 컨텍스트는 저장소 루트다(워크스페이스의 core·db·api가 필요).
#   docker build -f apps/review/Dockerfile -t verdict-review .
# Cloudflare Containers에서는 apps/review-deploy/wrangler.jsonc가 이 파일로 이미지를 만든다.

FROM node:22-bookworm-slim AS build
# better-sqlite3 미리 빌드된 바이너리를 못 받으면 직접 컴파일한다.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
ENV CI=1
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
# 앱이 쓰는 워크스페이스 패키지(core → db → api)를 의존 순서대로, 그다음 앱(서버 + 운영 화면, 개발용 시안 제외).
RUN pnpm -r --filter "@verdict-ai/review-app^..." run build
RUN REVIEW_NO_PROTOTYPE=1 pnpm --filter @verdict-ai/review-app run build
# 운영 의존성만 담은 실행용 묶음.
RUN pnpm --filter @verdict-ai/review-app deploy --prod --legacy /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080 REVIEW_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
# SIGTERM을 받으면 진행 중인 문서를 저장한 뒤 종료한다(server/src/main.ts).
CMD ["node", "server/dist/main.js"]
