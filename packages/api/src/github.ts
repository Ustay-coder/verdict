/**
 * Verifies who a GitHub token belongs to, for hub sign-in (docs/design/hub.md H2). The CLI runs GitHub's device flow
 * itself and hands the hub a token; the hub only asks GitHub whose it is, then forgets it.
 *   - With the OAuth App's client secret, the hub asks GitHub to check the token *for this app*
 *     (POST /applications/{client_id}/token): a token minted for another app is refused.
 *   - Without it, the hub reads GET /user: any valid token of the account is accepted. Fine for trying things out;
 *     production should set the secret.
 * Only `fetch` is used, so this runs on Workers.
 */
import { HTTPException } from "hono/http-exception";

export interface GithubConfig {
  /** OAuth App client id; public — the CLI reads it from GET /v1/hub/config to start the device flow. */
  clientId: string;
  /** OAuth App client secret; when set, tokens are checked against this app. */
  clientSecret?: string;
  /** Default https://api.github.com (GitHub Enterprise Server: https://HOST/api/v3). */
  apiUrl?: string;
  fetch?: typeof fetch;
}

export interface GithubAccount { id: number; login: string }

const HEADERS = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "verdict-hub" };

/** Resolves the account a token belongs to; 401 for a token GitHub rejects, 502 when GitHub cannot be asked. */
export async function verifyGithubToken(token: string, cfg: GithubConfig): Promise<GithubAccount> {
  const api = (cfg.apiUrl ?? "https://api.github.com").replace(/\/$/, "");
  const doFetch = cfg.fetch ?? fetch;
  let res: Response;
  try {
    res = cfg.clientSecret
      ? await doFetch(`${api}/applications/${encodeURIComponent(cfg.clientId)}/token`, {
        method: "POST",
        headers: { ...HEADERS, authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`, "content-type": "application/json" },
        body: JSON.stringify({ access_token: token }),
      })
      : await doFetch(`${api}/user`, { headers: { ...HEADERS, authorization: `Bearer ${token}` } });
  } catch (cause) {
    throw new HTTPException(502, { message: `could not reach GitHub to verify the sign-in (${cause instanceof Error ? cause.message : String(cause)})` });
  }
  // 401 (bad token), 404 (token not of this app), 422 (malformed) all mean "not a valid sign-in for this hub".
  if (res.status === 401 || res.status === 404 || res.status === 422) throw new HTTPException(401, { message: "GitHub did not accept this token for this hub; run `verdict hub login` again" });
  if (!res.ok) throw new HTTPException(502, { message: `GitHub answered ${res.status} while verifying the sign-in` });
  const body = (await res.json()) as { id?: unknown; login?: unknown; user?: { id?: unknown; login?: unknown } };
  const user = cfg.clientSecret ? body.user : body;
  if (typeof user?.id !== "number" || typeof user.login !== "string") throw new HTTPException(502, { message: "GitHub's answer did not name an account" });
  return { id: user.id, login: user.login };
}
