/**
 * 서버 진입점. 환경 변수(website/reference가 아닌 apps/review/README.md에 정리):
 *   PORT(8790), REVIEW_DATA_DIR(./data), VERDICT_API_KEYS(키:tenant, 미설정 = 단일 tenant "default"),
 *   OPENAI_API_KEY / OPENAI_BASE_URL, REVIEW_LLM_MODEL(gpt-5.4-mini), REVIEW_OCR_MODEL(gpt-5.4-mini),
 *   REVIEW_TEXT_JUDGE_PROVIDER(typesafe) / REVIEW_TEXT_JUDGE_MODEL(jev-latest) + 해당 provider 키(TYPESAFE_API_KEY 등).
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { envAuth } from "@verdict-ai/api";
import { Engine } from "@verdict-ai/core";
import { fromSqliteFile } from "@verdict-ai/db/sqlite";
import { mkdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { createReviewApp } from "./app.js";
import { Repo } from "./db.js";
import { FilePreparer, FileStorage } from "./files.js";
import { openAiClient } from "./llm.js";
import type { ReviewSettings } from "./review.js";
import { EngineEventRouter, Runner } from "./runner.js";

export function settingsFromEnv(env = process.env): ReviewSettings {
  return {
    mode: env.REVIEW_MODE === "full" ? "full" : "hybrid",
    fastMinConfidence: env.REVIEW_FAST_MIN_CONFIDENCE ? Number(env.REVIEW_FAST_MIN_CONFIDENCE) : 0.8,
    llmModel: env.REVIEW_LLM_MODEL ?? "gpt-5.4-mini",
    textJudge: { provider: (env.REVIEW_TEXT_JUDGE_PROVIDER ?? "typesafe") as ReviewSettings["textJudge"]["provider"], model: env.REVIEW_TEXT_JUDGE_MODEL ?? "jev-latest" },
  };
}

export async function startReviewServer(env = process.env) {
  const dataDir = env.REVIEW_DATA_DIR ?? "./data";
  mkdirSync(dataDir, { recursive: true });
  const repo = new Repo(join(dataDir, "review.sqlite"));
  const verdict = await fromSqliteFile(join(dataDir, "verdict.sqlite"));
  const router = new EngineEventRouter();
  const engine = new Engine({ store: verdict.store, onEvent: router.handler, concurrency: 4, rateLimitWait: (ms) => new Promise((r) => setTimeout(r, ms)) });
  const llm = openAiClient();
  const settings = settingsFromEnv(env);
  const log = (m: string, e?: unknown) => console.error(m, e);
  const runner = new Runner({ repo, engine, llm, settings, log }, router);
  const preparer = new FilePreparer(repo, new FileStorage(dataDir), { llm, ocrModel: env.REVIEW_OCR_MODEL ?? "gpt-5.4-mini" }, 2, log);
  const app = createReviewApp({ repo, runner, preparer, auth: envAuth(env), settings });

  const webDist = fileURLToPath(new URL("../../web/dist", import.meta.url));
  const root = relative(process.cwd(), webDist) || ".";
  // 개발용 UI 시안(prototype.html)은 운영 서버에서 내보내지 않는다.
  app.get("/prototype.html", (c) => (env.REVIEW_SERVE_PROTOTYPE === "1" ? serveStatic({ root })(c, async () => {}) as never : c.notFound()));
  app.use("/assets/*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));

  preparer.resume();
  runner.start();
  const port = Number(env.PORT ?? 8790);
  const server = serve({ fetch: app.fetch, port }, (info) => console.log(`verdict review listening on http://localhost:${info.port} (data: ${dataDir})`));
  const shutdown = async () => { server.close(); await runner.stop(); repo.close(); verdict.sqlite.close(); process.exit(0); };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  return { app, server, repo, runner, preparer, engine };
}

if (import.meta.url === `file://${process.argv[1]}`) void startReviewServer();
