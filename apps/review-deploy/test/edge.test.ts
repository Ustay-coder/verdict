import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { accessVerifier, authenticate, containerEnv, forwardRequest, USER_HEADER, type Env } from "../src/edge.js";

const TEAM = "https://example-team.cloudflareaccess.com";
const AUD = "aud-tag-123";
let sign: (claims: Record<string, unknown>, opts?: { iss?: string; aud?: string; exp?: string }) => Promise<string>;
let verify: ReturnType<typeof accessVerifier>;
let otherSign: typeof sign;

beforeAll(async () => {
  const mk = async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: Math.random().toString(36).slice(2), alg: "RS256" };
    const s: typeof sign = (claims, o = {}) => new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: jwk.kid }).setIssuer(o.iss ?? TEAM).setAudience(o.aud ?? AUD).setSubject("user-1").setIssuedAt().setExpirationTime(o.exp ?? "5m").sign(privateKey);
    return { jwk, s };
  };
  const good = await mk();
  const bad = await mk();
  sign = good.s;
  otherSign = bad.s;
  verify = accessVerifier({ ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD }, createLocalJWKSet({ keys: [good.jwk] }));
});

const req = (token?: string, extra: Record<string, string> = {}) => new Request("https://review.verdict-ai.dev/api/runs?x=1", { headers: { ...(token ? { "cf-access-jwt-assertion": token } : {}), ...extra } });
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

describe("Access check in front of the container", () => {
  it("lets through a valid Access token and names the user", async () => {
    expect(await authenticate(req(await sign({ email: "lead@example.com" })), env, verify)).toBe("lead@example.com");
    expect(await authenticate(req(await sign({ common_name: "e2e-bot.access" })), env, verify)).toBe("service:e2e-bot.access");
  });

  it("refuses missing, forged, expired, wrong-audience and wrong-issuer tokens", async () => {
    expect(await authenticate(req(), env, verify)).toBeNull();
    expect(await authenticate(req(await otherSign({ email: "x@example.com" })), env, verify)).toBeNull();
    expect(await authenticate(req(await sign({ email: "x@example.com" }, { exp: "-1m" })), env, verify)).toBeNull();
    expect(await authenticate(req(await sign({ email: "x@example.com" }, { aud: "other" })), env, verify)).toBeNull();
    expect(await authenticate(req(await sign({ email: "x@example.com" }, { iss: "https://evil.cloudflareaccess.com" })), env, verify)).toBeNull();
  });

  it("refuses everything when Access is not configured", async () => {
    expect(await authenticate(req(await sign({ email: "lead@example.com" })), { ACCESS_TEAM_DOMAIN: "", ACCESS_AUD: "" }, verify)).toBeNull();
  });

  it("forwards to the container with only the verified user header", async () => {
    const forwarded = forwardRequest(req("t", { [USER_HEADER]: "spoofed@example.com", host: "review.verdict-ai.dev" }), "lead@example.com");
    expect(forwarded.url).toBe("http://container/api/runs?x=1");
    expect(forwarded.headers.get(USER_HEADER)).toBe("lead@example.com");
    expect(forwarded.headers.get("host")).toBeNull();
  });

  it("passes secrets and set settings to the container, leaving unset ones to server defaults", () => {
    const e = containerEnv({ OPENAI_API_KEY: "o", TYPESAFE_API_KEY: "t", REVIEW_MODE: "hybrid", REVIEW_LLM_MODEL: "" } as unknown as Env);
    expect(e).toEqual({ PORT: "8080", REVIEW_DATA_DIR: "/data", NODE_ENV: "production", OPENAI_API_KEY: "o", TYPESAFE_API_KEY: "t", REVIEW_MODE: "hybrid" });
  });
});
