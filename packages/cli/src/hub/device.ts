/**
 * GitHub's OAuth device flow, run by the CLI (docs/design/hub.md H2): show a code, the person enters it at
 * github.com/login/device, the CLI polls until GitHub hands over a token. No client secret is involved; the scope is
 * empty, so the token can only read the account's public profile.
 */
import { ValidationError } from "@verdict-ai/core";

export interface DeviceFlowOptions {
  clientId: string;
  /** Default https://github.com (GitHub Enterprise Server: https://HOST). */
  githubUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Shown the user code and where to enter it. */
  prompt: (p: { userCode: string; verificationUri: string; expiresInSeconds: number }) => void;
}

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
// GitHub asks clients that poll too fast to add five seconds to the interval.
const SLOW_DOWN_MS = 5000;

/** Resolves a GitHub access token, or rejects when the code expires or the person declines. */
export async function githubDeviceFlow(o: DeviceFlowOptions): Promise<string> {
  const base = (o.githubUrl ?? "https://github.com").replace(/\/$/, "");
  const doFetch = o.fetch ?? fetch, sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const start = await post(doFetch, `${base}/login/device/code`, { client_id: o.clientId, scope: "" });
  if (typeof start.device_code !== "string" || typeof start.user_code !== "string") throw new ValidationError(`GitHub did not start the device flow: ${describe(start)}`);
  o.prompt({ userCode: start.user_code, verificationUri: String(start.verification_uri ?? `${base}/login/device`), expiresInSeconds: Number(start.expires_in ?? 900) });
  let interval = Number(start.interval ?? 5) * 1000;
  for (;;) {
    await sleep(interval);
    const poll = await post(doFetch, `${base}/login/oauth/access_token`, { client_id: o.clientId, device_code: start.device_code, grant_type: DEVICE_GRANT });
    if (typeof poll.access_token === "string") return poll.access_token;
    if (poll.error === "authorization_pending") continue;
    if (poll.error === "slow_down") { interval = Number(poll.interval ?? 0) * 1000 || interval + SLOW_DOWN_MS; continue; }
    if (poll.error === "expired_token") throw new ValidationError("the sign-in code expired; run `verdict hub login` again");
    if (poll.error === "access_denied") throw new ValidationError("the sign-in was declined on GitHub");
    throw new ValidationError(`GitHub refused the sign-in: ${describe(poll)}`);
  }
}

async function post(doFetch: typeof fetch, url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
  const res = await doFetch(url, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
  const text = await res.text();
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new ValidationError(`GitHub answered ${res.status} without JSON at ${url}`); }
}

const describe = (body: Record<string, unknown>) => String(body.error_description ?? body.error ?? JSON.stringify(body));
