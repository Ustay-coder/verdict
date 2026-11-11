/**
 * Sign-in approved in the browser, for servers that run it themselves: the CLI asks the
 * server for a code, the person opens the server's page, signs in there however that server allows, and approves the
 * code; the CLI polls until the server hands over an API key. The CLI never sees how the person signed in.
 */
import { ValidationError } from "@verdict-ai/core";

export interface BrowserSignInOptions {
  server: string;
  /** Paths on `server`, from its `/v1/hub/config`. */
  signIn: { start: string; token: string };
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Shown the code and where to approve it. */
  prompt: (p: { userCode: string; verificationUri: string; expiresInSeconds: number }) => void;
}

export interface SignedIn { apiKey: string; keyId?: string; handle?: string }

// Asked to slow down, a client adds five seconds to its interval (RFC 8628).
const SLOW_DOWN_MS = 5000;

/** Resolves the key the server issued, or rejects when the code expires or the person declines. */
export async function browserSignIn(o: BrowserSignInOptions): Promise<SignedIn> {
  // The server names its own routes; a config pointing anywhere else is not followed.
  for (const path of [o.signIn.start, o.signIn.token]) if (!/^\/[^/]/.test(path)) throw new ValidationError(`${o.server} announced a sign-in route outside itself (${path}); not following it`);
  const start = await post(o, o.signIn.start, {});
  const { deviceCode, userCode, verificationUri } = start.body;
  if (start.status >= 400 || typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") throw new ValidationError(`${o.server} did not start the sign-in: ${reason(start.body)}`);
  const expiresInSeconds = Number(start.body.expiresIn ?? 900);
  o.prompt({ userCode, verificationUri, expiresInSeconds });
  let interval = Number(start.body.interval ?? 5) * 1000;
  for (let waited = 0; waited < expiresInSeconds * 1000; waited += interval) {
    await o.sleep(interval);
    const answer = answered(o.server, await post(o, o.signIn.token, { deviceCode }));
    if (answer === "expired") break;
    if (answer === "slow_down") interval += SLOW_DOWN_MS;
    else if (answer !== "pending") return answer;
  }
  throw new ValidationError("the sign-in code expired; run `verdict login` again");
}

/** What one poll says: the key, keep waiting, wait longer, or the code ran out. Throws when the sign-in was refused. */
function answered(server: string, poll: { status: number; body: Record<string, unknown> }): SignedIn | "pending" | "slow_down" | "expired" {
  if (poll.status < 400 && typeof poll.body.apiKey === "string") return { apiKey: poll.body.apiKey, ...text("keyId", poll.body.keyId), ...text("handle", poll.body.handle) };
  const type = errorType(poll.body);
  if (type === "authorization_pending") return "pending";
  if (type === "slow_down") return "slow_down";
  if (type === "expired_token") return "expired";
  if (type === "access_denied") throw new ValidationError("the sign-in was declined in the browser");
  throw new ValidationError(`${server} refused the sign-in: ${reason(poll.body)}`);
}

const text = <K extends string>(key: K, value: unknown) => (typeof value === "string" ? { [key]: value } as Record<K, string> : {});
const errorType = (body: Record<string, unknown>) => (body.error && typeof body.error === "object" ? (body.error as { type?: unknown }).type : undefined);
const reason = (body: Record<string, unknown>) => String((body.error as { message?: unknown } | undefined)?.message ?? errorType(body) ?? JSON.stringify(body));

async function post(o: BrowserSignInOptions, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await o.fetch(`${o.server}${path}`, { method: "POST", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
  const raw = await res.text();
  try { return { status: res.status, body: JSON.parse(raw) as Record<string, unknown> }; }
  catch { throw new ValidationError(`${o.server} answered ${res.status} without JSON at ${path}`); }
}
