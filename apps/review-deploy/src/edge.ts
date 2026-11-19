/** 앞단 Worker의 순수 로직(접근 확인, 요청 전달, 컨테이너 환경). Workers 런타임 없이 테스트할 수 있다. */
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";

export interface Env {
  REVIEW: DurableObjectNamespace;
  /** Cloudflare Access 팀 도메인, 예: https://<team>.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN: string;
  /** Access 애플리케이션의 AUD 태그 */
  ACCESS_AUD: string;
  /** 컨테이너로 넘기는 설정(비밀 아님) */
  REVIEW_MODE?: string;
  REVIEW_LLM_MODEL?: string;
  REVIEW_OCR_MODEL?: string;
  REVIEW_MAX_FILES_PER_RUN?: string;
  /** 비밀(wrangler secret put) */
  OPENAI_API_KEY: string;
  TYPESAFE_API_KEY: string;
}

export const PORT = 8080;
export const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
export const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
/** 컨테이너가 신뢰하는 사용자 헤더. 외부 요청에서 온 값은 버린다. */
export const USER_HEADER = "x-verdict-user";

/* ---------------- 접근 확인 ---------------- */

export type VerifyAccess = (token: string) => Promise<JWTPayload>;

/** Access 공개키(팀 도메인의 /cdn-cgi/access/certs)로 서명·발급자·대상(AUD)·만료를 검증한다. keys는 테스트에서 바꿔 넣는다. */
export function accessVerifier(env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">, keys?: JWTVerifyGetKey): VerifyAccess {
  const team = env.ACCESS_TEAM_DOMAIN.replace(/\/$/, "");
  const keySet = keys ?? createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
  return async (token) => (await jwtVerify(token, keySet, { issuer: team, audience: env.ACCESS_AUD, algorithms: ["RS256"], requiredClaims: ["exp", "sub"] })).payload;
}

/** Access를 통과한 요청이면 사용자(이메일 또는 서비스 토큰 id), 아니면 null. 설정이 없으면 모두 거부한다. */
export async function authenticate(request: Request, env: Pick<Env, "ACCESS_TEAM_DOMAIN" | "ACCESS_AUD">, verify: VerifyAccess): Promise<string | null> {
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get("cf-access-jwt-assertion");
  if (!token) return null;
  try {
    const payload = await verify(token);
    const email = typeof payload.email === "string" ? payload.email : undefined;
    const serviceToken = typeof payload.common_name === "string" ? `service:${payload.common_name}` : undefined;
    return email ?? serviceToken ?? (typeof payload.sub === "string" ? payload.sub : null);
  } catch {
    return null;
  }
}

/** 컨테이너로 보낼 요청: 주소를 컨테이너 내부로 바꾸고, 사용자 헤더는 검증된 값으로만 둔다. */
export function forwardRequest(request: Request, user: string): Request {
  const url = new URL(request.url);
  url.protocol = "http:";
  url.host = "container";
  const forwarded = new Request(url, request);
  forwarded.headers.delete("host");
  forwarded.headers.delete(USER_HEADER);
  forwarded.headers.set(USER_HEADER, user);
  return forwarded;
}

/** 컨테이너 환경 변수. 값이 없는 항목은 넣지 않는다(서버 기본값 사용). */
export function containerEnv(env: Env): Record<string, string> {
  const out: Record<string, string> = {
    PORT: String(PORT),
    REVIEW_DATA_DIR: "/data",
    NODE_ENV: "production",
    OPENAI_API_KEY: env.OPENAI_API_KEY,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
  };
  for (const k of ["REVIEW_MODE", "REVIEW_LLM_MODEL", "REVIEW_OCR_MODEL", "REVIEW_MAX_FILES_PER_RUN"] as const) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

