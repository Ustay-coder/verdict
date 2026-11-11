/**
 * Registers `verdict hub`: sign in to a hub with GitHub (device flow), check who you publish as, list your
 * publications, and sign out (revoking the key on the hub).
 */
import { ValidationError } from "@verdict-ai/core";
import { VerdictError } from "@verdict-ai/sdk";
import { Command } from "commander";

import { hubTarget } from "../hub/credentials.js";
import { hubClient, hubDefaults, type HubDependencies } from "../hub/deps.js";
import { browserSignIn } from "../hub/browser.js";
import { githubDeviceFlow } from "../hub/device.js";

interface HubOption { hub?: string }
interface LoginOptions extends HubOption { githubUrl: string; withKey?: boolean }

/** `verdict login` and `verdict hub login`: the same sign-in under both names. */
function addLogin(parent: Command, deps: HubDependencies) {
  parent.command("login").description("sign in to a Verdict server and keep its API key in ~/.config/verdict/hub.json (one key per server)")
    .option("--hub <url>", "server URL (default: VERDICT_HUB_URL)").option("--github-url <url>", "GitHub (Enterprise Server) URL", "https://github.com")
    .option("--with-key", "save an API key read from standard input instead of signing in with GitHub (self-hosted servers)")
    .action(async (o: LoginOptions) => {
      const { hub: url } = await hubTarget(deps.credentials, { ...deps.env, VERDICT_HUB_KEY: undefined }, o.hub);
      if (o.withKey) { await saveKey(deps, url); return; }
      const client = hubClient(deps, url);
      const { github, signIn } = await client.hub.config();
      const prompt = ({ userCode, verificationUri, expiresInSeconds }: { userCode: string; verificationUri: string; expiresInSeconds: number }) =>
        deps.warn(`Open ${verificationUri} and enter ${userCode} (expires in ${Math.round(expiresInSeconds / 60)} min). Waiting…`);
      // A server that runs sign-in itself says so; the person signs in on its page, by whatever means it offers.
      if (signIn?.kind === "browser") {
        const session = await browserSignIn({ server: url, signIn, fetch: deps.fetch, sleep: deps.sleep, prompt });
        await deps.credentials.write({ hub: url, apiKey: session.apiKey, ...(session.keyId ? { keyId: session.keyId } : {}), ...(session.handle ? { handle: session.handle } : {}) });
        deps.out(`signed in to ${url}${session.handle ? ` as ${session.handle}` : ""}`);
        return;
      }
      if (!github) throw new ValidationError(`${url} does not use GitHub sign-in; save a key from its operator with \`verdict login --hub ${url} --with-key\`, or set VERDICT_HUB_KEY`);
      const token = await githubDeviceFlow({ clientId: github.clientId, githubUrl: o.githubUrl, fetch: deps.fetch, sleep: deps.sleep, prompt });
      const session = await client.hub.login(token);
      await deps.credentials.write({ hub: url, apiKey: session.apiKey, keyId: session.keyId, handle: session.handle });
      deps.out(`signed in to ${url} as ${session.handle}`);
    });
}

/** Keeps a key the server's operator issued. The server is asked once, so a mistyped key is not saved. */
async function saveKey(deps: HubDependencies, url: string) {
  const apiKey = await (deps.readSecret ?? hubDefaults.readSecret!)(`API key for ${url}: `);
  if (!apiKey) throw new ValidationError("no key given: pipe it in, e.g. `verdict login --hub <url> --with-key < key.txt`");
  try { await hubClient(deps, url, apiKey).projects.list(); }
  catch (e) {
    if (e instanceof VerdictError && e.status === 401) throw new ValidationError(`${url} did not accept that key; nothing was saved`);
    // A server that does not serve projects, or cannot be reached right now, says nothing about the key.
    deps.warn(`could not check the key with ${url} (${e instanceof Error ? e.message : String(e)}); saved it anyway`);
  }
  await deps.credentials.write({ hub: url, apiKey });
  deps.out(`saved the key for ${url}`);
}

export function registerHub(program: Command, deps: HubDependencies = hubDefaults) {
  const hub = program.command("hub").description("sign in to a Verdict hub and manage your publications");
  addLogin(hub, deps);
  addLogin(program, deps);

  hub.command("whoami").description("show who this key publishes as").option("--hub <url>").action(async (o: HubOption) => {
    const target = await hubTarget(deps.credentials, deps.env, o.hub);
    if (!target.apiKey) throw new ValidationError(`not signed in to ${target.hub}; run \`verdict hub login\``);
    const me = await hubClient(deps, target.hub, target.apiKey).hub.me();
    deps.out(me.handle ? `${me.handle} on ${target.hub}` : `signed in to ${target.hub}, but this key cannot publish (no GitHub sign-in)`);
  });

  hub.command("list").description("list your publications on the hub, withdrawn included").option("--hub <url>").option("--json").action(async (o: HubOption & { json?: boolean }) => {
    const target = await hubTarget(deps.credentials, deps.env, o.hub);
    if (!target.apiKey) throw new ValidationError(`not signed in to ${target.hub}; run \`verdict hub login\``);
    const { data } = await hubClient(deps, target.hub, target.apiKey).publications.list();
    if (o.json) { deps.out(JSON.stringify(data, null, 2)); return; }
    if (!data.length) deps.out("no publications yet");
    for (const p of data) deps.out(`${p.id}\t${p.ref}\t${p.version.id}\t${p.createdAt}${p.takedown ? `\ttaken down ${p.takedown.at}: ${p.takedown.reason}` : p.withdrawnAt ? `\twithdrawn ${p.withdrawnAt}` : ""}`);
  });

  hub.command("logout").description("revoke a sign-in's key on its server and forget it locally (default: the most recent sign-in)").option("--hub <url>")
    .action(async (o: HubOption) => {
      const saved = await deps.credentials.read(o.hub);
      if (!saved) { deps.out(o.hub ? `not signed in to ${o.hub}` : "not signed in"); return; }
      if (saved.keyId) {
        // A hub that cannot be reached must not keep the key on disk: forget it locally and say so.
        try { await hubClient(deps, saved.hub, saved.apiKey).hub.revokeKey(saved.keyId); }
        catch (error) { deps.warn(`could not revoke the key on ${saved.hub} (${error instanceof Error ? error.message : String(error)}); ask its operator to revoke ${saved.keyId}`); }
      }
      await deps.credentials.remove(saved.hub);
      deps.out(`signed out of ${saved.hub}`);
    });
}
