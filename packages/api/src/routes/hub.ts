/**
 * Hub sign-in (docs/design/hub.md H2). `GET /v1/hub/config` and `POST /v1/hub/login` are public: the CLI learns the
 * GitHub client id, runs the device flow, and trades the GitHub token for a hub API key bound to the GitHub account.
 * `GET /v1/hub/me` and `DELETE /v1/hub/keys/:id` are authenticated.
 */
import { hasPublishers, type PublisherStore } from "@verdict-ai/core";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";

import type { AppOptions, Env } from "../app.js";
import { verifyGithubToken } from "../github.js";
import { defaultClientKey, enforce } from "../rate-limit.js";
import { tenant } from "./shared.js";

/** Paths that answer without an API key. */
export const PUBLIC_HUB_PATHS = new Set(["/v1/hub/config", "/v1/hub/login"]);

/** The tenant of a GitHub account. Numeric ids survive renamed logins. */
export const githubTenant = (githubId: number) => `gh:${githubId}`;

export function registerHub(app: Hono<Env>, { engine, keys, github, now = () => Date.now(), limits, clientKey = defaultClientKey, signIn }: AppOptions) {
  const publishers = (): PublisherStore => {
    if (!hasPublishers(engine.store)) throw new HTTPException(501, { message: "this server's store cannot keep publishers" });
    return engine.store;
  };

  app.get("/v1/hub/config", (c) => c.json({ github: github ? { clientId: github.clientId } : null, publishing: github ? "github" : "tenant", ...(signIn ? { signIn } : {}) }));

  app.post("/v1/hub/login", async (c) => {
    if (!github) throw new HTTPException(501, { message: "GitHub sign-in is not configured on this server (GITHUB_CLIENT_ID)" });
    if (!keys) throw new HTTPException(501, { message: "this server cannot issue API keys (needs a database store)" });
    // Each sign-in asks GitHub and mints a key: limit it per client before doing either.
    await enforce(limits?.login, clientKey(c), "sign-in");
    const { githubToken } = z.object({ githubToken: z.string().min(1).max(512) }).parse(await c.req.json());
    const account = await verifyGithubToken(githubToken, github);
    const tenantId = githubTenant(account.id), at = new Date(now()).toISOString();
    const existing = await publishers().getPublisher(tenantId);
    await publishers().putPublisher({ tenantId, githubId: account.id, login: account.login, createdAt: existing?.createdAt ?? at, updatedAt: at });
    const key = await keys.createKey(tenantId, `hub sign-in (${account.login})`);
    // The GitHub token is not stored anywhere; the hub key is shown once, here.
    return c.json({ apiKey: key.key, keyId: key.id, handle: account.login, tenantId }, 201);
  });

  app.get("/v1/hub/me", async (c) => {
    const tenantId = tenant(c);
    const publisher = tenantId && hasPublishers(engine.store) ? await engine.store.getPublisher(tenantId) : undefined;
    return c.json({ tenantId: tenantId ?? null, handle: publisher?.login ?? (github ? null : tenantId ?? "local"), github: publisher ? { id: publisher.githubId, login: publisher.login } : null });
  });

  app.delete("/v1/hub/keys/:id", async (c) => {
    if (!keys) throw new HTTPException(501, { message: "this server cannot manage API keys" });
    const tenantId = tenant(c);
    if (!tenantId || !(await keys.revokeKey(c.req.param("id"), tenantId))) throw new HTTPException(404, { message: "no such key for this account" });
    return c.body(null, 204);
  });
}

/**
 * Who a tenant publishes as. With GitHub sign-in configured, only signed-in GitHub accounts publish, under their
 * login; without it (a self-hosted team server), a tenant publishes under its own id, an open server as "local".
 */
export function publisherFor(opts: Pick<AppOptions, "engine" | "github">) {
  return async (tenantId: string | undefined): Promise<string | undefined> => {
    if (!opts.github) return tenantId ?? "local";
    if (!tenantId || !hasPublishers(opts.engine.store)) return undefined;
    return (await opts.engine.store.getPublisher(tenantId))?.login;
  };
}
