/**
 * 서류 검토 서비스의 앞단 Worker (Cloudflare Containers, 1단계 온라인 테스트용).
 *
 * - 모든 요청은 Cloudflare Access를 통과해야 한다. Worker가 Access JWT(Cf-Access-Jwt-Assertion)를 검증하고,
 *   검증된 이메일만 x-verdict-user 헤더로 컨테이너에 넘긴다(외부에서 온 같은 헤더는 지운다).
 * - 컨테이너는 1대다(순차 실행기·SQLite가 한 프로세스에 있음). 이름 "main"의 Durable Object 하나가 띄우고 전달한다.
 * - 검토가 진행 중이면 알람이 5분마다 컨테이너 상태(/api/health의 busy)를 보고 비활성 타이머를 연장한다.
 *   그래서 사용자가 탭을 닫아도 검토가 끝날 때까지 컨테이너가 꺼지지 않는다.
 * - 컨테이너 디스크는 재배포·재시작 때 사라진다(1단계의 알려진 한계, README 참고).
 */
import { DurableObject } from "cloudflare:workers";
import { accessVerifier, authenticate, containerEnv, forwardRequest, INACTIVITY_TIMEOUT_MS, KEEPALIVE_INTERVAL_MS, PORT, type Env, type VerifyAccess } from "./edge.js";

export type { Env } from "./edge.js";
const READY_ATTEMPTS = 150;
const READY_WAIT_MS = 200;

/* ---------------- 컨테이너 1대 ---------------- */

export class ReviewContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    // 재배포 등으로 Durable Object만 다시 뜨면 타이머가 없어지므로 다시 건다.
    if (container?.running) void ctx.blockConcurrencyWhile(() => container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS));
  }

  private get container(): Container {
    const c = this.ctx.container;
    if (!c) throw new Error("컨테이너 설정이 없습니다");
    return c;
  }

  async fetch(request: Request): Promise<Response> {
    try {
      this.starting ??= this.startAndWaitForPort().finally(() => { this.starting = undefined; });
      await this.starting;
    } catch (error) {
      return new Response(`서비스를 시작하지 못했습니다: ${(error as Error).message}`, { status: 503, headers: { "retry-after": "5" } });
    }
    await this.ensureKeepAlive();
    return this.container.getTcpPort(PORT).fetch(request);
  }

  private async startAndWaitForPort(): Promise<void> {
    const container = this.container;
    if (!container.running) {
      container.start({ image: container.images.base!, instance: "standard-1", enableInternet: true, env: containerEnv(this.env) });
    }
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    const port = container.getTcpPort(PORT);
    let last: unknown;
    for (let i = 0; i < READY_ATTEMPTS; i++) {
      try {
        const res = await port.fetch("http://container/api/health", { signal: AbortSignal.timeout(1000) });
        await res.body?.cancel();
        if (res.ok) return;
        last = new Error(`health ${res.status}`);
      } catch (error) { last = error; }
      await scheduler.wait(READY_WAIT_MS);
    }
    throw new Error(`컨테이너가 ${PORT}번 포트에서 응답하지 않습니다`, { cause: last });
  }

  /** 알람이 없으면 건다. 알람이 할 일이 있는 동안 스스로 다시 건다. */
  private async ensureKeepAlive() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
  }

  /** 검토가 진행 중이면 컨테이너 비활성 타이머를 연장하고 다음 알람을 건다. 한가하면 알람을 멈춘다(타이머가 끄도록 둔다). */
  async alarm() {
    const container = this.ctx.container;
    if (!container?.running) return;
    let busy = false;
    try {
      const res = await container.getTcpPort(PORT).fetch("http://container/api/health", { signal: AbortSignal.timeout(5000) });
      busy = res.ok && Boolean(((await res.json()) as { busy?: boolean }).busy);
    } catch { busy = false; }
    if (!busy) return;
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);
    await this.ctx.storage.setAlarm(Date.now() + KEEPALIVE_INTERVAL_MS);
  }
}

/* ---------------- 진입점 ---------------- */

export function makeHandler(verifyFor: (env: Env) => VerifyAccess) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const user = await authenticate(request, env, verifyFor(env));
      if (!user) return new Response("접근 권한이 없습니다", { status: 403, headers: { "content-type": "text/plain; charset=utf-8" } });
      return env.REVIEW.getByName("main").fetch(forwardRequest(request, user));
    },
  } satisfies ExportedHandler<Env>;
}

let cached: { key: string; verify: VerifyAccess } | undefined;
export default makeHandler((env) => {
  const key = `${env.ACCESS_TEAM_DOMAIN}|${env.ACCESS_AUD}`;
  if (cached?.key !== key) cached = { key, verify: accessVerifier(env) };
  return cached.verify;
});
