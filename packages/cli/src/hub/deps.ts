/**
 * Dependencies of the hub commands, injectable so tests drive the CLI against an in-memory hub and a fake GitHub.
 */
import { Verdict } from "@verdict-ai/sdk";
import { createInterface } from "node:readline/promises";

import { versionDefaults, type VersionDependencies } from "../versions/workspace.js";
import { fileCredentials, type CredentialStore } from "./credentials.js";

export interface HubDependencies extends VersionDependencies {
  credentials: CredentialStore;
  env: Record<string, string | undefined>;
  /** Network for both the hub and GitHub. */
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  /** Asks a yes/no question; only called when `interactive()` is true. */
  confirm: (question: string) => Promise<boolean>;
  interactive: () => boolean;
  /** Reads an API key from standard input (`verdict login --with-key`): piped, or typed at a prompt. */
  readSecret?: (prompt: string) => Promise<string>;
  /** Where `verdict.yaml` is looked for, upwards. Default: the working directory. */
  cwd?: () => string;
}

export const hubDefaults: HubDependencies = {
  ...versionDefaults,
  credentials: fileCredentials(),
  env: process.env,
  fetch: (input, init) => fetch(input, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim()); }
    finally { rl.close(); }
  },
  interactive: () => !!process.stdin.isTTY,
  readSecret: async (prompt) => {
    if (!process.stdin.isTTY) {
      let piped = "";
      for await (const chunk of process.stdin) piped += String(chunk);
      return piped.trim();
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try { return (await rl.question(prompt)).trim(); }
    finally { rl.close(); }
  },
  cwd: () => process.cwd(),
};

/** A client for one hub. Without a hub key it sends none: never the VERDICT_API_KEY meant for another server. */
export const hubClient = (deps: Pick<HubDependencies, "fetch">, hub: string, apiKey?: string, org?: string) => new Verdict({ baseUrl: hub, apiKey: apiKey ?? "", fetch: deps.fetch, ...(org ? { org } : {}) });

/** Commands shared with the local-only version tools take hub dependencies when given, the defaults otherwise. */
export const withHub = (deps: VersionDependencies | HubDependencies): HubDependencies => ("credentials" in deps ? deps : { ...hubDefaults, ...deps });
